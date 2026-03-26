import * as THREE from 'three';
import { initGame } from './game.js';

// ─── Constants ───────────────────────────────────────────────────────────────
const GLOBE_RADIUS       = 1;
const CAMERA_FOV         = 45;
const CAMERA_INITIAL_Z   = 3;
let ZOOM_MIN             = 1.5;
let ZOOM_MAX             = 8;
const STAR_COUNT         = 5000;
const STAR_COUNT_BRIGHT  = 100;
const FRICTION           = 0.93;
const VELOCITY_THRESHOLD = 0.0001;
const MAX_TILT           = 65 * Math.PI / 180; // ~1.13 rad — prevents globe from tipping sideways

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
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
document.body.appendChild(renderer.domElement);

// ─── Lighting ─────────────────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0x334466, 0.8)); // deep blue-grey ambient — space-like dark side
const dirLight = new THREE.DirectionalLight(0xfff5e0, 1.4); // warm sunlight
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

// ─── Atmosphere ───────────────────────────────────────────────────────────────
// A slightly larger back-face sphere with a fresnel shader produces the blue
// limb glow visible around Earth from orbit.
const atmosphere = new THREE.Mesh(
  new THREE.SphereGeometry(GLOBE_RADIUS * 1.12, 64, 64),
  new THREE.ShaderMaterial({
    vertexShader: `
      varying vec3 vNormal;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vNormal;
      void main() {
        float intensity = pow(max(0.0, 0.65 - dot(vNormal, vec3(0.0, 0.0, 1.0))), 2.5);
        gl_FragColor = vec4(0.25, 0.55, 1.0, 1.0) * intensity;
      }
    `,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
  })
);
scene.add(atmosphere);

// ─── Debug interface (gated on ?debug URL param) ──────────────────────────────
// Must be created before initGame so game.js can extend it.
if (location.search.includes('debug')) {
  window.__dbg = {
    getCamera: () => camera,
    getGlobe:  () => globe,
    setZoomMin: v => { ZOOM_MIN = v; },
    setZoomMax: v => { ZOOM_MAX = v; },
    getFacingLatLng() {
      globe.updateMatrixWorld(true);
      const worldFwd = new THREE.Vector3(0, 0, 1);
      const local    = globe.worldToLocal(worldFwd.clone()).normalize();
      return {
        lat: (Math.asin(local.y) * 180 / Math.PI).toFixed(1),
        lng: (Math.atan2(-local.z, local.x) * 180 / Math.PI).toFixed(1),
      };
    },
  };
}

// ─── Game ─────────────────────────────────────────────────────────────────────
const game = initGame({ scene, globe, camera });

document.getElementById('reset-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  game.resetNorthUp();
});

// ─── Stars ────────────────────────────────────────────────────────────────────
// Marsaglia rejection sampling — uniform distribution on sphere (no pole clustering)
// Uniform sphere sample (Marsaglia) with power-law brightness + subtle color temperature.
// Power-law (x^2.5) gives many dim stars and a few bright ones — matches real sky statistics.
function sampleStars(count, radius, brightnessPow = 2.5, minBrightness = 0.12) {
  const positions = new Float32Array(count * 3);
  const colors    = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    let x, y, z, d;
    do {
      x = Math.random() * 2 - 1;
      y = Math.random() * 2 - 1;
      z = Math.random() * 2 - 1;
      d = x*x + y*y + z*z;
    } while (d > 1 || d === 0);
    const s = radius / Math.sqrt(d);
    positions[i*3]     = x * s;
    positions[i*3 + 1] = y * s;
    positions[i*3 + 2] = z * s;

    const b    = Math.pow(Math.random(), brightnessPow);
    const lum  = minBrightness + b * (1 - minBrightness);
    const temp = Math.random(); // color temperature: 0=cool/orange, 1=hot/blue
    const r = lum * (temp < 0.12 ? 0.80 : temp > 0.88 ? 1.00 : 1.0);
    const g = lum * 1.0;
    const bv = lum * (temp < 0.12 ? 0.80 : temp > 0.88 ? 1.00 : 0.92);
    colors[i*3]     = r;
    colors[i*3 + 1] = g;
    colors[i*3 + 2] = bv;
  }
  return { positions, colors };
}

// Primary field — 5000 stars at 1.5px constant screen size
const { positions: starPos, colors: starCol } = sampleStars(STAR_COUNT, 500);
const starGeo = new THREE.BufferGeometry();
starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
starGeo.setAttribute('color',    new THREE.BufferAttribute(starCol, 3));

// Bright star layer — 100 larger stars, lower brightness exponent so more of them are bright
const { positions: brightPos, colors: brightCol } = sampleStars(STAR_COUNT_BRIGHT, 500, 1.2, 0.4);
const brightGeo = new THREE.BufferGeometry();
brightGeo.setAttribute('position', new THREE.BufferAttribute(brightPos, 3));
brightGeo.setAttribute('color',    new THREE.BufferAttribute(brightCol, 3));

// Group both layers so a single rotation drives all stars at the same rate
const starField = new THREE.Group();
starField.add(new THREE.Points(
  starGeo,
  new THREE.PointsMaterial({ size: 1.5, sizeAttenuation: false, vertexColors: true }),
));
starField.add(new THREE.Points(
  brightGeo,
  new THREE.PointsMaterial({ size: 3, sizeAttenuation: false, vertexColors: true }),
));
scene.add(starField);

// ─── Controls State ───────────────────────────────────────────────────────────
const ctrl = {
  isDragging: false,
  lastX: 0,
  lastY: 0,
  velocityX: 0,
  velocityY: 0,
  dragDistPx: 0,  // accumulated drag distance since mousedown — used to distinguish click vs drag
};

// ─── Rotation Helper ──────────────────────────────────────────────────────────
// Quaternion-based rotation avoids Euler decomposition issues after SLERP animations.
// Tilt clamp: check where north pole lands after the pitch — block if it exceeds MAX_TILT.
const _qY    = new THREE.Quaternion();
const _qX    = new THREE.Quaternion();
const _axisY = new THREE.Vector3(0, 1, 0);
const _axisX = new THREE.Vector3(1, 0, 0);
const _north = new THREE.Vector3();
const MAX_TILT_COS = Math.cos(MAX_TILT); // ≈ 0.42 — north pole y must exceed this

function applyRotation(dx, dy) {
  // Yaw: rotate around world Y (horizontal drag)
  _qY.setFromAxisAngle(_axisY, dx);
  globe.quaternion.premultiply(_qY);

  // Pitch: rotate around world X (vertical drag), with tilt clamping
  _qX.setFromAxisAngle(_axisX, dy);
  // Test where north pole would land after applying qX:
  // premultiply(qX) → new quaternion is (qX * globe.q), so north = (0,1,0) rotated by globe.q then by qX
  _north.set(0, 1, 0).applyQuaternion(globe.quaternion).applyQuaternion(_qX);
  if (_north.y > MAX_TILT_COS) {
    globe.quaternion.premultiply(_qX);
  }
}

// ─── Mouse Events ─────────────────────────────────────────────────────────────
renderer.domElement.addEventListener('mousedown', (e) => {
  ctrl.isDragging = true;
  ctrl.lastX = e.clientX;
  ctrl.lastY = e.clientY;
  ctrl.velocityX = 0;
  ctrl.velocityY = 0;
  ctrl.dragDistPx = 0;
});

renderer.domElement.addEventListener('mousemove', (e) => {
  if (!ctrl.isDragging) return;
  const dx = e.clientX - ctrl.lastX;
  const dy = e.clientY - ctrl.lastY;
  ctrl.dragDistPx += Math.sqrt(dx * dx + dy * dy);
  const zoomScale = camera.position.z / CAMERA_INITIAL_Z;
  ctrl.velocityX = (dx / window.innerHeight) * Math.PI * zoomScale;
  ctrl.velocityY = (dy / window.innerHeight) * Math.PI * zoomScale;
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
    ctrl.dragDistPx = 0;
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
    ctrl.dragDistPx += Math.sqrt(dx * dx + dy * dy);
    const zoomScale = camera.position.z / CAMERA_INITIAL_Z;
    ctrl.velocityX = (dx / window.innerHeight) * Math.PI * zoomScale;
    ctrl.velocityY = (dy / window.innerHeight) * Math.PI * zoomScale;
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

let lastTouchHandled = false;

renderer.domElement.addEventListener('touchend', (e) => {
  if (e.touches.length === 0) {
    if (ctrl.dragDistPx < CLICK_DRAG_THRESHOLD) {
      const touch = e.changedTouches[0];
      pointer.x =  (touch.clientX / window.innerWidth)  * 2 - 1;
      pointer.y = -(touch.clientY / window.innerHeight) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      globe.updateMatrixWorld(true);
      const hits = raycaster.intersectObject(globe);
      if (hits.length > 0) {
        const { lat, lng } = toLatLng(hits[0].point, globe);
        ctrl.velocityX = 0;
        ctrl.velocityY = 0;
        game.onGlobeClick(lat, lng);
        lastTouchHandled = true;
      }
    }
    ctrl.isDragging = false;
    lastPinchDist = null;
  }
});

// ─── Raycast → Lat/Lng ────────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const pointer   = new THREE.Vector2();

// Convert a world-space point on the globe surface to lat/lng.
// IMPORTANT: must transform into globe local space first — otherwise
// the calculation breaks when the globe is rotated.
function toLatLng(worldPoint, mesh) {
  const local = mesh.worldToLocal(worldPoint.clone()).normalize();
  return {
    lat: Math.asin(local.y) * (180 / Math.PI),
    lng: Math.atan2(-local.z, local.x) * (180 / Math.PI),
  };
}

const CLICK_DRAG_THRESHOLD = 20; // pixels — raised for trackpad friendliness

renderer.domElement.addEventListener('click', (e) => {
  if (lastTouchHandled) { lastTouchHandled = false; return; }
  if (ctrl.dragDistPx > CLICK_DRAG_THRESHOLD) return;
  pointer.x =  (e.clientX / window.innerWidth)  * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  globe.updateMatrixWorld(true); // ensure matrix is current before worldToLocal
  const hits = raycaster.intersectObject(globe);
  if (hits.length > 0) {
    const { lat, lng } = toLatLng(hits[0].point, globe);
    ctrl.velocityX = 0; // stop inertia so globe doesn't drift after the guess is placed
    ctrl.velocityY = 0;
    game.onGlobeClick(lat, lng);
  }
});

// ─── Resize ───────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ─── Animation Loop ───────────────────────────────────────────────────────────
let lastTime = 0;
function animate(time = 0) {
  requestAnimationFrame(animate);
  const delta = Math.min((time - lastTime) / 1000, 0.1); // cap at 100ms
  lastTime = time;

  if (!ctrl.isDragging) {
    if (Math.abs(ctrl.velocityX) > VELOCITY_THRESHOLD || Math.abs(ctrl.velocityY) > VELOCITY_THRESHOLD) {
      applyRotation(ctrl.velocityX, ctrl.velocityY);
      ctrl.velocityX *= FRICTION;
      ctrl.velocityY *= FRICTION;
    }
  }

  starField.rotation.y += 0.00003;
  starField.rotation.x += 0.00001;

  game.tick(delta);
  renderer.render(scene, camera);
}

animate();
