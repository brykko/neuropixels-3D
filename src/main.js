import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import Papa from 'papaparse';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';

// === Constants & Scale ===
const MICRON_TO_UNIT = 0.001;      // 1 µm = 0.001 Three.js units
const WAFER_THICKNESS = 20;        // in µm
const ELECTRODE_SIZE = 12;         // edge length in µm
const ELECTRODE_THICKNESS = 3;     // in µm
const CAMERA_YPOS = 0.5            // offset from shank tips, in mm

// === Scene Setup ===
const scene = new THREE.Scene();
// Set a dark background for better contrast
scene.background = new THREE.Color(0x202020);
// Load an HDR environment for realistic transmission reflections
new RGBELoader()
  .setDataType(THREE.HalfFloatType)
  .load('studio_small_03_1k.hdr', (hdr) => {
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = hdr;
  });
const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);
// camera.position.set(0, 0, 50);
camera.position.set(0.28, CAMERA_YPOS, 1.28);

const renderer = new THREE.WebGLRenderer({
  canvas: document.getElementById('three-canvas'),
  antialias: true,
});
// Enable physically correct lighting and HDR tone mapping
renderer.physicallyCorrectLights = true;
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.setSize(window.innerWidth, window.innerHeight);
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// Expose camera & controls in the console for interactive tweaking
window.camera = camera;
window.controls = controls;

// Press 'c' in the browser console to log the current camera position and target
window.addEventListener('keydown', (e) => {
  if (e.key === 'c') {
    console.log('Camera position:', camera.position);
    console.log('OrbitControls target:', controls.target);
  }
});

// Enable auto-rotate for an orbiting camera effect
controls.autoRotate = true;
controls.autoRotateSpeed = 2; // adjust rotation speed (default is 1)
controls.target.set(0, CAMERA_YPOS, 0);

// === Lighting ===
const ambient = new THREE.AmbientLight(0xffffff, 1.0);
scene.add(ambient);

function addLight(x, y, z) {
  const light = new THREE.DirectionalLight(0xffffff, 10)
  light.position.set(x, y, z);
  scene.add(light);
}

// Add four lights to illuminate each of the main faces
addLight(0, 0, 10);
addLight(0, 0, -10);
addLight(10, 0, 0);
addLight(-10, 0, 0);

// === Materials ===
const siliconMat = new THREE.MeshPhysicalMaterial({
  color: 0x888888,
  metalness: 0.3,
  roughness: 0.1,
  transparent: true,
  transmission: 0.9,
  thickness: WAFER_THICKNESS * MICRON_TO_UNIT,
  attenuationDistance: WAFER_THICKNESS * MICRON_TO_UNIT * 2,
  attenuationColor: 0xffffff,
  side: THREE.DoubleSide,
});

const electrodeMat = new THREE.MeshStandardMaterial({
  color: 0xB5A642,  // brass-like
  metalness: 0.5,
  roughness: 0.8,
  side: THREE.DoubleSide,
});

// === CSV Loader ===
async function loadCSV(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  const text = await response.text();
  return new Promise((resolve) => {
    Papa.parse(text, {
      header: false,
      dynamicTyping: true,
      skipEmptyLines: true,
      complete: (results) => resolve(results.data),
    });
  });
}

// === Build Probe Geometry ===
async function buildProbe() {
  // 1. Load and filter 2D outline points
  // Place probe_outline.csv in project_root/public/
  const outlineRaw = await loadCSV('/probe_outline_np2.csv');
  const outlineData = outlineRaw.filter(
    ([x, y]) => typeof x === 'number' && typeof y === 'number'
  );
  if (outlineData.length === 0) {
    console.error('probe_outline.csv contains no valid numeric points.');
    return;
  }

  // Create shape
  const shape = new THREE.Shape();
  outlineData.forEach(([x, y], idx) => {
    const ux = x * MICRON_TO_UNIT;
    const uy = y * MICRON_TO_UNIT;
    if (idx === 0) shape.moveTo(ux, uy);
    else shape.lineTo(ux, uy);
  });
  shape.closePath();

  // Extrude wafer
  const extrudeSettings = {
    depth: WAFER_THICKNESS * MICRON_TO_UNIT,
    bevelEnabled: false,
    openEnded: false,
  };
  const waferGeo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
  waferGeo.computeVertexNormals();
  const waferMesh = new THREE.Mesh(waferGeo, siliconMat);
  scene.add(waferMesh);
  // Outline the wafer edges for clarity
  // const waferEdges = new THREE.EdgesGeometry(waferGeo);
  // const waferOutline = new THREE.LineSegments(
  //   waferEdges,
  //   new THREE.LineBasicMaterial({ color: 0x555555 })
  // );
  // scene.add(waferOutline);
  
  // Manually add front and back caps to ensure faces are rendered
  const capGeo = new THREE.ShapeGeometry(shape);
  // Front cap (at z=0)
  const frontCap = new THREE.Mesh(capGeo, siliconMat);
  frontCap.position.set(0, 0, 0);
  scene.add(frontCap);

  // Back cap (at z = wafer thickness)
  const backCap = new THREE.Mesh(capGeo, siliconMat);
  // backCap.rotation.x = Math.PI; // flip normal
  backCap.position.set(0, 0, WAFER_THICKNESS * MICRON_TO_UNIT);
  scene.add(backCap);

  // 2. Load electrode positions
  // Place site_positions.csv in project_root/public/
  const sitesRaw = await loadCSV('/site_positions_np2.csv');
  const sites = sitesRaw.filter(
    ([x, y]) => typeof x === 'number' && typeof y === 'number'
  );
  if (sites.length === 0) {
    console.error('site_positions.csv contains no valid numeric points.');
    return;
  }

  // Electrode geometry
  const elecGeo = new THREE.BoxGeometry(
    ELECTRODE_SIZE * MICRON_TO_UNIT,
    ELECTRODE_SIZE * MICRON_TO_UNIT,
    ELECTRODE_THICKNESS * MICRON_TO_UNIT
  );
  const waferTopZ = WAFER_THICKNESS * MICRON_TO_UNIT;

  sites.forEach(([x, y]) => {
    const elecMesh = new THREE.Mesh(elecGeo, electrodeMat);
    elecMesh.position.set(
      x * MICRON_TO_UNIT,
      y * MICRON_TO_UNIT,
      waferTopZ + (ELECTRODE_THICKNESS * MICRON_TO_UNIT) / 2
    );
    scene.add(elecMesh);
  });
}

// === Initialize ===
buildProbe().catch(err => console.error('Error building probe:', err));

// === Render Loop ===
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();
