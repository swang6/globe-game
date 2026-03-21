import * as THREE from 'three';
import { haversineKm, calcScore } from './scoring.js';
import { LOCATIONS, ROUNDS_PER_GAME } from './locations.js';

// ─── Constants ────────────────────────────────────────────────────────────────
const GLOBE_RADIUS  = 1;
const ARC_SEGMENTS  = 64;
const MARKER_OFFSET = 0.025; // how far above globe surface markers sit
const ARC_SPEED     = 0.7;   // progress units per second → ~1.4s for full arc

const COLOR_GUESS  = 0xff6b35; // orange
const COLOR_ANSWER = 0x44ff88; // green

// ─── State ────────────────────────────────────────────────────────────────────
const STATE = {
  IDLE:              'IDLE',
  ROUND_START:       'ROUND_START',
  WAITING_FOR_GUESS: 'WAITING_FOR_GUESS',
  REVEALING:         'REVEALING',
  NEXT_ROUND:        'NEXT_ROUND',
  GAME_OVER:         'GAME_OVER',
};

let state        = STATE.IDLE;
let currentRound = 0;
let totalScore   = 0;
let roundLocations = [];

// ─── Three.js refs (set by initGame) ─────────────────────────────────────────
let _globe;

// ─── Arc state ────────────────────────────────────────────────────────────────
let arcProgress  = 0;
let arcActive    = false;
let allArcPoints = [];
let arcGeo, arcPositions, arcLine;
let guessMarker  = null;
let answerMarker = null;
let currentGuessLat, currentGuessLng;

// ─── UI element refs ──────────────────────────────────────────────────────────
let elTopPanel, elIntroContent, elRoundContent;
let elRoundNum, elLocationLabel;
let elHudScore;
let elScorePanel, elDistanceDisplay, elRoundScoreDisplay, elNextBtn;
let elGameOverPanel, elFinalScoreDisplay, elRestartBtn;

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Convert lat/lng to a local-space THREE.Vector3 on the globe surface.
 * Must exactly invert main.js's toLatLng which uses:
 *   lat = asin(local.y),  lng = atan2(local.z, local.x)
 */
function latLngToLocal(lat, lng, radius) {
  const phi   = (90 - lat) * (Math.PI / 180); // polar angle from +Y axis
  const theta = lng         * (Math.PI / 180); // azimuthal angle in XZ plane
  return new THREE.Vector3(
    radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

function createMarker(lat, lng, color, size = 0.022) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(size, 12, 12),
    new THREE.MeshBasicMaterial({ color, depthTest: false }),
  );
  mesh.position.copy(latLngToLocal(lat, lng, GLOBE_RADIUS + MARKER_OFFSET));
  mesh.renderOrder = 1;
  return mesh;
}

function computeArcPoints(lat1, lng1, lat2, lng2) {
  const start = latLngToLocal(lat1, lng1, 1).normalize();
  const end   = latLngToLocal(lat2, lng2, 1).normalize();
  const pts = [];
  for (let i = 0; i <= ARC_SEGMENTS; i++) {
    const t  = i / ARC_SEGMENTS;
    const pt = new THREE.Vector3().copy(start).lerp(end, t).normalize();
    const lift = Math.sin(t * Math.PI) * 0.12; // midpoint lift
    pts.push(pt.multiplyScalar(GLOBE_RADIUS + MARKER_OFFSET + lift));
  }
  return pts;
}

function animateCountUp(el, target, ms = 800) {
  const start = performance.now();
  (function step(now) {
    const t = Math.min((now - start) / ms, 1);
    const e = 1 - (1 - t) ** 3; // ease-out cubic
    el.textContent = Math.round(e * target).toLocaleString();
    if (t < 1) requestAnimationFrame(step);
  })(performance.now());
}

function pickLocations() {
  return [...LOCATIONS].sort(() => Math.random() - 0.5).slice(0, ROUNDS_PER_GAME);
}

function clearRoundObjects() {
  if (guessMarker)  { _globe.remove(guessMarker);  guessMarker  = null; }
  if (answerMarker) { _globe.remove(answerMarker); answerMarker = null; }
  arcGeo.setDrawRange(0, 0);
  arcActive = false;
}

// ─── State machine ────────────────────────────────────────────────────────────

function setState(next) {
  state = next;

  if (next === STATE.ROUND_START) {
    const loc = roundLocations[currentRound];

    // Switch top panel to round view
    elIntroContent.classList.add('hidden');
    elRoundContent.classList.remove('hidden');
    elRoundNum.textContent    = currentRound + 1;
    elLocationLabel.textContent = loc.label;

    // Show HUD
    elHudScore.classList.remove('hidden');

    // Enable crosshair
    document.body.classList.add('waiting');

    setState(STATE.WAITING_FOR_GUESS);
  }

  if (next === STATE.REVEALING) {
    document.body.classList.remove('waiting');
  }

  if (next === STATE.GAME_OVER) {
    elFinalScoreDisplay.textContent = totalScore.toLocaleString();
    elGameOverPanel.classList.add('visible');
  }
}

function revealGuess(lat, lng) {
  currentGuessLat = lat;
  currentGuessLng = lng;

  // Place guess marker
  guessMarker = createMarker(lat, lng, COLOR_GUESS);
  _globe.add(guessMarker);

  // Pre-compute arc
  const loc = roundLocations[currentRound];
  allArcPoints = computeArcPoints(lat, lng, loc.lat, loc.lng);
  arcProgress  = 0;
  arcActive    = true;

  setState(STATE.REVEALING);
}

function onArcComplete() {
  const loc       = roundLocations[currentRound];
  const distKm    = Math.round(haversineKm(currentGuessLat, currentGuessLng, loc.lat, loc.lng));
  const score     = calcScore(distKm);
  totalScore     += score;

  // Place answer marker
  answerMarker = createMarker(loc.lat, loc.lng, COLOR_ANSWER, 0.028);
  _globe.add(answerMarker);

  // Update distance display
  elDistanceDisplay.textContent = distKm.toLocaleString();

  // Animate score displays
  animateCountUp(elRoundScoreDisplay, score);
  // HUD shows running total with " pts" suffix
  const prevTotal = totalScore - score;
  const hudStart = performance.now();
  (function hudStep(now) {
    const t = Math.min((now - hudStart) / 1000, 1);
    const e = 1 - (1 - t) ** 3;
    elHudScore.textContent = Math.round(prevTotal + e * score).toLocaleString() + ' pts';
    if (t < 1) requestAnimationFrame(hudStep);
  })(performance.now());

  // Slide up score panel
  elScorePanel.classList.add('visible');

  // Show Next button after short delay
  setTimeout(() => {
    elNextBtn.classList.add('visible');
    setState(STATE.NEXT_ROUND);
  }, 1500);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function initGame({ scene, globe, camera }) {
  _globe = globe;

  // Grab UI elements
  elTopPanel        = document.getElementById('top-panel');
  elIntroContent    = document.getElementById('intro-content');
  elRoundContent    = document.getElementById('round-content');
  elRoundNum        = document.getElementById('round-num');
  elLocationLabel   = document.getElementById('location-label');
  elHudScore        = document.getElementById('hud-score');
  elScorePanel      = document.getElementById('score-panel');
  elDistanceDisplay = document.getElementById('distance-display');
  elRoundScoreDisplay = document.getElementById('round-score-display');
  elNextBtn         = document.getElementById('next-btn');
  elGameOverPanel   = document.getElementById('game-over-panel');
  elFinalScoreDisplay = document.getElementById('final-score-display');
  elRestartBtn      = document.getElementById('restart-btn');

  // Pre-allocate arc geometry (reused across all rounds)
  arcPositions = new Float32Array((ARC_SEGMENTS + 1) * 3);
  arcGeo       = new THREE.BufferGeometry();
  arcGeo.setAttribute('position', new THREE.BufferAttribute(arcPositions, 3));
  arcGeo.setDrawRange(0, 0);
  arcLine = new THREE.Line(
    arcGeo,
    new THREE.LineBasicMaterial({ color: 0xffd700, depthTest: false }),
  );
  arcLine.renderOrder = 2;
  globe.add(arcLine); // child of globe — rotates with it

  // Wire buttons
  document.getElementById('start-btn').addEventListener('click', () => {
    roundLocations = pickLocations();
    currentRound   = 0;
    totalScore     = 0;
    setState(STATE.ROUND_START);
  });

  document.getElementById('next-btn').addEventListener('click', () => {
    if (state !== STATE.NEXT_ROUND) return;

    // Reset UI
    elScorePanel.classList.remove('visible');
    elNextBtn.classList.remove('visible');
    elRoundScoreDisplay.textContent = '0';

    clearRoundObjects();

    currentRound++;
    if (currentRound >= ROUNDS_PER_GAME) {
      setState(STATE.GAME_OVER);
    } else {
      setState(STATE.ROUND_START);
    }
  });

  document.getElementById('restart-btn').addEventListener('click', () => {
    location.reload();
  });

  setState(STATE.IDLE);

  return {
    onGlobeClick(lat, lng) {
      if (state !== STATE.WAITING_FOR_GUESS) return;
      revealGuess(lat, lng);
    },

    tick(delta) {
      if (!arcActive || state !== STATE.REVEALING) return;

      arcProgress += Math.min(delta, 0.1) * ARC_SPEED;
      const done  = arcProgress >= 1.0;
      const count = done
        ? ARC_SEGMENTS + 1
        : Math.min(Math.floor(arcProgress * ARC_SEGMENTS) + 2, ARC_SEGMENTS + 1);

      for (let i = 0; i < count; i++) {
        arcPositions[i * 3]     = allArcPoints[i].x;
        arcPositions[i * 3 + 1] = allArcPoints[i].y;
        arcPositions[i * 3 + 2] = allArcPoints[i].z;
      }
      arcGeo.attributes.position.needsUpdate = true;
      arcGeo.setDrawRange(0, count);

      if (done) {
        arcActive = false;
        onArcComplete();
      }
    },
  };
}
