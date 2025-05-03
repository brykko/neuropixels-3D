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

// const HDR_FILENAME = './paul_lobe_haus_1k.hdr';     // semi-outdoor, overcast
const HDR_FILENAME = './studio_small_08_1k.hdr';  // high-contrast studio lights
// Determine probe type from URL (e.g. ?probe_type=1 or ?probe=2), defaulting to 2
const urlParams = new URLSearchParams(window.location.search);
const probeType = parseInt(urlParams.get('probe_type')) || 2;
const tranparent = Boolean(parseInt(urlParams.get('transparent'))) || false;

const AUTOROTATE_PROBE = true;

let elecFile, outlineFile;
if (probeType==1){
  elecFile = './site_positions_np1.csv'
  outlineFile = './probe_outline_np1.csv'
} else if (probeType==2){
  elecFile = './site_positions_np2.csv'
  outlineFile = './probe_outline_np2.csv'
}

// === Scene Setup ===
const scene = new THREE.Scene();

// Create a 'group' for all of the probe components. We can then manipulate this group
// as a whole (convenient when we need to rotate)
const probeGroup = new THREE.Group();
scene.add(probeGroup);
probeGroup.rotation.y = -2;

// Set a dark background for better contrast
// scene.background = new THREE.Color(0x000000);
// Load an HDR environment for realistic transmission reflections
new RGBELoader()
  .setDataType(THREE.HalfFloatType)
  .load(HDR_FILENAME, (hdr) => {
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = hdr;
  });
  scene.environmentIntensity = 1 // scale the reflectance of the HDR environment

const camera = new THREE.PerspectiveCamera(
  30,
  window.innerWidth / window.innerHeight,
  1,    // instead of 0.1
  20
);
camera.position.set(-2.5, CAMERA_YPOS, 1.25);

const renderer = new THREE.WebGLRenderer({
  canvas: document.getElementById('three-canvas'),
  antialias: true,
  alpha: tranparent
});
// Enable physically correct lighting and HDR tone mapping
renderer.physicallyCorrectLights = true;
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;

// Expose camera & controls in the console for interactive tweaking
window.camera = camera;
window.controls = orbitControls;

// Press 'c' in the browser console to log the current camera position and target
window.addEventListener('keydown', (e) => {
  if (e.key === 'c') {
    console.log('Camera position:', camera.position);
    console.log('OrbitControls target:', orbitControls.target);
  }
});

// Enable auto-rotate for an orbiting camera effect
orbitControls.autoRotate = false;
orbitControls.target.set(0, CAMERA_YPOS, 0);

// === Materials ===
const siliconMat = new THREE.MeshPhysicalMaterial({
  color: 0x888888,
  metalness: 0.3,
  roughness: 0.2,
  transparent: true,
  transmission: 0.8,
  // thickness: 1,
  thickness: WAFER_THICKNESS * MICRON_TO_UNIT,
  attenuationDistance: WAFER_THICKNESS * MICRON_TO_UNIT * 2,
  attenuationColor: 0xffffff,
  side: THREE.DoubleSide,
  polygonOffset: true,    // necessary to prevent z-fighting
  polygonOffsetFactor: 1,
  polygonOffsetUnits: 1,
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
  const outlineRaw = await loadCSV(outlineFile);
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

  // 1. Extract the raw points for triangulation:
const { shape: outerPts, holes } = shape.extractPoints();

// 2. Log how many outer‐contour points and holes you have:
console.log('Outer contour points:', outerPts.length);
console.log('Hole contours:', holes.length);

// 3. Run the earcut triangulator and see how many triangles it produces:
const tris = THREE.ShapeUtils.triangulateShape(outerPts, holes);
console.log('Number of cap triangles:', tris.length);

  // Extrude wafer
  const extrudeSettings = {
    depth: WAFER_THICKNESS * MICRON_TO_UNIT,
    bevelEnabled: false,
    openEnded: true,
  };
  const waferGeo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
  // Debug: log out geometry groups to verify caps and sides
  console.log('waferGeo.groups:', waferGeo.groups);
  waferGeo.groups.forEach((group, idx) => {
    console.log(`Group ${idx}: start=${group.start}, count=${group.count}, matIndex=${group.materialIndex}`);
  });
  waferGeo.computeVertexNormals();
  const waferMesh = new THREE.Mesh(waferGeo, siliconMat);
  probeGroup.add(waferMesh); // anything added to probeGroup gets added to scene automatically

  // Manually add front and back caps to ensure faces are rendered
  const capGeo = new THREE.ShapeGeometry(shape);
  // Front cap (at z=0)
  const frontCap = new THREE.Mesh(capGeo, siliconMat);
  frontCap.position.set(0, 0, 0);
  probeGroup.add(frontCap);

  // Back cap (at z = wafer thickness)
  const backCap = new THREE.Mesh(capGeo, siliconMat);
  // backCap.rotation.x = Math.PI; // flip normal
  backCap.position.set(0, 0, WAFER_THICKNESS * MICRON_TO_UNIT);
  probeGroup.add(backCap);

  // 2. Load electrode positions
  // Place site_positions.csv in project_root/public/
  const sitesRaw = await loadCSV(elecFile);
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
    probeGroup.add(elecMesh);
  });
}

// === Initialize ===
buildProbe().catch(err => console.error('Error building probe:', err));

// === Render Loop ===
function animate() {
  requestAnimationFrame(animate);
  orbitControls.update();
  if (AUTOROTATE_PROBE) {
    probeGroup.rotation.y += 0.002;
  }
  renderer.render(scene, camera);
}
animate();
