import * as THREE from 'three';

// ─── Constants ───────────────────────────────────────────────────────────────
const GLOBE_RADIUS       = 1;
const CAMERA_FOV         = 45;
const CAMERA_INITIAL_Z   = 3;
const ZOOM_MIN           = 1.5;
const ZOOM_MAX           = 8;
const STAR_COUNT         = 2000;
const FRICTION           = 0.93;
const VELOCITY_THRESHOLD = 0.0001;

// ─── Scene, Camera, Renderer ─────────────────────────────────────────────────
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  CAMERA_FOV,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);
camera.position.z = CAMERA_INITIAL_Z;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // cap at 2x — 3x retina wastes GPU
document.body.appendChild(renderer.domElement);

// ─── Lighting ─────────────────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0xffffff, 0.3)); // keeps dark side from going pure black
const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(5, 3, 5);
scene.add(dirLight);

// ─── Globe ────────────────────────────────────────────────────────────────────
const loader = new THREE.TextureLoader();
const colorMap = loader.load('./assets/textures/earth_8k.jpg');
const bumpMap  = loader.load('./assets/textures/earth_bump_8k.jpg');

colorMap.minFilter = THREE.LinearMipmapLinearFilter;
bumpMap.minFilter  = THREE.LinearMipmapLinearFilter;

const globe = new THREE.Mesh(
  new THREE.SphereGeometry(GLOBE_RADIUS, 64, 64),
  new THREE.MeshPhongMaterial({
    map:      colorMap,
    bumpMap:  bumpMap,
    bumpScale: 0.05,
    shininess: 15,
    specular:  new THREE.Color(0x333333),
  })
);
scene.add(globe);

// ─── Stars ────────────────────────────────────────────────────────────────────
// Marsaglia rejection sampling — uniform distribution on sphere (no pole clustering)
const starPositions = new Float32Array(STAR_COUNT * 3);
for (let i = 0; i < STAR_COUNT; i++) {
  let x, y, z, d;
  do {
    x = Math.random() * 2 - 1;
    y = Math.random() * 2 - 1;
    z = Math.random() * 2 - 1;
    d = x*x + y*y + z*z;
  } while (d > 1 || d === 0);
  const s = 500 / Math.sqrt(d);
  starPositions[i*3]     = x * s;
  starPositions[i*3 + 1] = y * s;
  starPositions[i*3 + 2] = z * s;
}
const starGeo = new THREE.BufferGeometry();
starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
scene.add(new THREE.Points(
  starGeo,
  new THREE.PointsMaterial({ color: 0xffffff, size: 0.5, sizeAttenuation: true })
));

// ─── Controls State ───────────────────────────────────────────────────────────
const ctrl = {
  isDragging: false,
  lastX: 0,
  lastY: 0,
  velocityX: 0,
  velocityY: 0,
};

// ─── Rotation Helper ──────────────────────────────────────────────────────────
function applyRotation(dx, dy) {
  globe.rotation.y += dx;
  // clamp x rotation to prevent pole flip
  globe.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, globe.rotation.x + dy));
}

// ─── Mouse Events ─────────────────────────────────────────────────────────────
renderer.domElement.addEventListener('mousedown', (e) => {
  ctrl.isDragging = true;
  ctrl.lastX = e.clientX;
  ctrl.lastY = e.clientY;
  ctrl.velocityX = 0;
  ctrl.velocityY = 0;
});

renderer.domElement.addEventListener('mousemove', (e) => {
  if (!ctrl.isDragging) return;
  const dx = e.clientX - ctrl.lastX;
  const dy = e.clientY - ctrl.lastY;
  ctrl.velocityX = (dx / window.innerHeight) * Math.PI;
  ctrl.velocityY = (dy / window.innerHeight) * Math.PI;
  applyRotation(ctrl.velocityX, ctrl.velocityY);
  ctrl.lastX = e.clientX;
  ctrl.lastY = e.clientY;
});

// mouseup on window so fast drags that exit the canvas still release
window.addEventListener('mouseup', () => {
  ctrl.isDragging = false;
});

// ─── Scroll Zoom ──────────────────────────────────────────────────────────────
renderer.domElement.addEventListener('wheel', (e) => {
  e.preventDefault();
  camera.position.z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, camera.position.z + e.deltaY * 0.01));
}, { passive: false });

// ─── Touch Events ─────────────────────────────────────────────────────────────
let lastPinchDist = null;

function getPinchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx*dx + dy*dy);
}

renderer.domElement.addEventListener('touchstart', (e) => {
  e.preventDefault();
  if (e.touches.length === 1) {
    ctrl.isDragging = true;
    ctrl.lastX = e.touches[0].clientX;
    ctrl.lastY = e.touches[0].clientY;
    ctrl.velocityX = 0;
    ctrl.velocityY = 0;
    lastPinchDist = null;
  } else if (e.touches.length === 2) {
    ctrl.isDragging = false;
    lastPinchDist = getPinchDist(e.touches);
  }
}, { passive: false });

renderer.domElement.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (e.touches.length === 1 && ctrl.isDragging) {
    const dx = e.touches[0].clientX - ctrl.lastX;
    const dy = e.touches[0].clientY - ctrl.lastY;
    ctrl.velocityX = (dx / window.innerHeight) * Math.PI;
    ctrl.velocityY = (dy / window.innerHeight) * Math.PI;
    applyRotation(ctrl.velocityX, ctrl.velocityY);
    ctrl.lastX = e.touches[0].clientX;
    ctrl.lastY = e.touches[0].clientY;
  } else if (e.touches.length === 2) {
    const d = getPinchDist(e.touches);
    if (lastPinchDist !== null) {
      camera.position.z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, camera.position.z + (lastPinchDist - d) * 0.01));
    }
    lastPinchDist = d;
  }
}, { passive: false });

renderer.domElement.addEventListener('touchend', (e) => {
  if (e.touches.length === 0) {
    ctrl.isDragging = false;
    lastPinchDist = null;
  }
});

// ─── Raycast → Lat/Lng ────────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const pointer   = new THREE.Vector2();
const debugEl   = document.getElementById('debug');

// Convert a world-space point on the globe surface to lat/lng.
// IMPORTANT: must transform into globe local space first — otherwise
// the calculation breaks when the globe is rotated.
function toLatLng(worldPoint, mesh) {
  const local = mesh.worldToLocal(worldPoint.clone()).normalize();
  return {
    lat: Math.asin(local.y) * (180 / Math.PI),
    lng: Math.atan2(local.z, local.x) * (180 / Math.PI),
  };
}

renderer.domElement.addEventListener('click', (e) => {
  pointer.x =  (e.clientX / window.innerWidth)  * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(globe);
  if (hits.length > 0) {
    const { lat, lng } = toLatLng(hits[0].point, globe);
    debugEl.textContent = `lat: ${lat.toFixed(4)}  lng: ${lng.toFixed(4)}`;
  }
});

// ─── Resize ───────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ─── Animation Loop ───────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);

  if (!ctrl.isDragging) {
    if (Math.abs(ctrl.velocityX) > VELOCITY_THRESHOLD || Math.abs(ctrl.velocityY) > VELOCITY_THRESHOLD) {
      applyRotation(ctrl.velocityX, ctrl.velocityY);
      ctrl.velocityX *= FRICTION;
      ctrl.velocityY *= FRICTION;
    }
  }

  renderer.render(scene, camera);
}

animate();
