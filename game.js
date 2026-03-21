import * as THREE from 'three';
import { haversineMi, calcScore } from './scoring.js';
import { LOCATIONS, ROUNDS_PER_GAME } from './locations.js';

// ─── Constants ────────────────────────────────────────────────────────────────
const GLOBE_RADIUS = 1;
const ARC_SEGMENTS = 64;
const ARC_SPEED    = 0.7; // progress units per second → ~1.4s for full arc

const COLOR_GUESS   = 0xff6b35; // orange
const COLOR_PENDING = 0xffffff; // white — unconfirmed guess
const COLOR_ANSWER  = 0x44ff88; // green

// ─── State ────────────────────────────────────────────────────────────────────
const STATE = {
  IDLE:              'IDLE',
  ROUND_START:       'ROUND_START',
  WAITING_FOR_GUESS: 'WAITING_FOR_GUESS',
  PENDING_GUESS:     'PENDING_GUESS',
  REVEALING:         'REVEALING',
  NEXT_ROUND:        'NEXT_ROUND',
  GAME_OVER:         'GAME_OVER',
};

let state          = STATE.IDLE;
let currentRound   = 0;
let totalScore     = 0;
let roundLocations = [];

// ─── Three.js refs (set by initGame) ─────────────────────────────────────────
let _globe;

// ─── Arc state ────────────────────────────────────────────────────────────────
let arcProgress  = 0;
let arcActive    = false;
let allArcPoints = [];
let arcGeo, arcPositions, arcLine;
let guessMarker   = null;
let pendingMarker = null;
let answerMarker  = null;
let currentGuessLat, currentGuessLng;
let pendingLat, pendingLng;

// ─── Auto-spin state ──────────────────────────────────────────────────────────
const SPIN_SPEED = 2.5; // radians per second
let spinActive   = false;
let spinTargetX  = 0;
let spinTargetY  = 0;

// ─── UI element refs ──────────────────────────────────────────────────────────
let elIntroContent, elRoundContent;
let elRoundNum, elLocationLabel;
let elConfirmBtn, elConfirmHint;
let elHudScore;
let elScorePanel, elDistanceDisplay, elRoundScoreDisplay, elNextBtn;
let elGameOverPanel, elFinalScoreDisplay;

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Convert lat/lng to a local-space THREE.Vector3 on the globe surface.
 * Must exactly invert main.js's toLatLng which uses:
 *   lat = asin(local.y),  lng = atan2(local.z, local.x)
 */
function latLngToLocal(lat, lng, radius) {
  const phi   = (90 - lat) * (Math.PI / 180);
  const theta = lng         * (Math.PI / 180);
  return new THREE.Vector3(
    radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

/**
 * Spike marker: a thin radial line from the surface outward + a constant
 * screen-size dot at the tip. Precise at any zoom level and visible from far.
 */
function createMarker(lat, lng, color) {
  const group = new THREE.Group();

  const base = latLngToLocal(lat, lng, GLOBE_RADIUS + 0.002);
  const tip  = latLngToLocal(lat, lng, GLOBE_RADIUS + 0.18);

  // Thin spike line
  const lineGeo = new THREE.BufferGeometry().setFromPoints([base, tip]);
  const line = new THREE.Line(
    lineGeo,
    new THREE.LineBasicMaterial({ color, depthTest: false }),
  );
  line.renderOrder = 1;
  group.add(line);

  // Constant screen-size dot at the tip — visible at any zoom
  const dotGeo = new THREE.BufferGeometry();
  dotGeo.setAttribute('position', new THREE.BufferAttribute(
    new Float32Array([tip.x, tip.y, tip.z]), 3,
  ));
  const dot = new THREE.Points(
    dotGeo,
    new THREE.PointsMaterial({ color, size: 6, sizeAttenuation: false, depthTest: false }),
  );
  dot.renderOrder = 2;
  group.add(dot);

  return group;
}

function disposeMarker(marker) {
  if (!marker) return;
  marker.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) obj.material.dispose();
  });
}

function computeArcPoints(lat1, lng1, lat2, lng2) {
  const start = latLngToLocal(lat1, lng1, 1).normalize();
  const end   = latLngToLocal(lat2, lng2, 1).normalize();
  const pts = [];
  for (let i = 0; i <= ARC_SEGMENTS; i++) {
    const t    = i / ARC_SEGMENTS;
    const pt   = new THREE.Vector3().copy(start).lerp(end, t).normalize();
    const lift = Math.sin(t * Math.PI) * 0.12;
    pts.push(pt.multiplyScalar(GLOBE_RADIUS + 0.025 + lift));
  }
  return pts;
}

function animateCountUp(el, target, ms = 800) {
  const start = performance.now();
  (function step(now) {
    const t = Math.min((now - start) / ms, 1);
    const e = 1 - (1 - t) ** 3;
    el.textContent = Math.round(e * target).toLocaleString();
    if (t < 1) requestAnimationFrame(step);
  })(performance.now());
}

function pickLocations() {
  return [...LOCATIONS].sort(() => Math.random() - 0.5).slice(0, ROUNDS_PER_GAME);
}

function clearRoundObjects() {
  if (pendingMarker) { _globe.remove(pendingMarker); disposeMarker(pendingMarker); pendingMarker = null; }
  if (guessMarker)   { _globe.remove(guessMarker);   disposeMarker(guessMarker);   guessMarker   = null; }
  if (answerMarker)  { _globe.remove(answerMarker);  disposeMarker(answerMarker);  answerMarker  = null; }
  arcGeo.setDrawRange(0, 0);
  arcActive = false;
}

// ─── State machine ────────────────────────────────────────────────────────────

function setState(next) {
  state = next;

  if (next === STATE.ROUND_START) {
    const loc = roundLocations[currentRound];

    elIntroContent.classList.add('hidden');
    elRoundContent.classList.remove('hidden');
    elRoundNum.textContent      = currentRound + 1;
    elLocationLabel.textContent = loc.label;

    elHudScore.classList.remove('hidden');
    document.body.classList.add('waiting');

    setState(STATE.WAITING_FOR_GUESS);
  }

  if (next === STATE.PENDING_GUESS) {
    // Small delay before confirm becomes interactive — prevents ghost clicks
    // from the same tap/click that placed the pending marker.
    elConfirmBtn.style.pointerEvents = 'none';
    elConfirmBtn.classList.remove('hidden');
    elConfirmHint.classList.remove('hidden');
    setTimeout(() => { elConfirmBtn.style.pointerEvents = ''; }, 200);
  }

  if (next === STATE.REVEALING) {
    elConfirmBtn.classList.add('hidden');
    elConfirmHint.classList.add('hidden');
    document.body.classList.remove('waiting');
  }

  if (next === STATE.GAME_OVER) {
    elFinalScoreDisplay.textContent = totalScore.toLocaleString();
    elGameOverPanel.classList.add('visible');
  }
}

function setPendingGuess(lat, lng) {
  pendingLat = lat;
  pendingLng = lng;

  if (pendingMarker) { _globe.remove(pendingMarker); disposeMarker(pendingMarker); pendingMarker = null; }
  pendingMarker = createMarker(lat, lng, COLOR_PENDING);
  _globe.add(pendingMarker);

  if (state !== STATE.PENDING_GUESS) {
    setState(STATE.PENDING_GUESS);
  }
}

function confirmGuess() {
  if (state !== STATE.PENDING_GUESS) return;

  currentGuessLat = pendingLat;
  currentGuessLng = pendingLng;

  if (pendingMarker) { _globe.remove(pendingMarker); disposeMarker(pendingMarker); pendingMarker = null; }
  guessMarker = createMarker(currentGuessLat, currentGuessLng, COLOR_GUESS);
  _globe.add(guessMarker);

  const loc    = roundLocations[currentRound];
  allArcPoints = computeArcPoints(currentGuessLat, currentGuessLng, loc.lat, loc.lng);
  arcProgress  = 0;
  arcActive    = true;

  setState(STATE.REVEALING);
}

function startSpinToLocation(lat, lng) {
  spinTargetX = -lat * (Math.PI / 180);
  spinTargetY = (90 - lng) * (Math.PI / 180);
  spinActive  = true;
}

function onArcComplete() {
  const loc    = roundLocations[currentRound];
  const distMi = Math.round(haversineMi(currentGuessLat, currentGuessLng, loc.lat, loc.lng));
  const score  = calcScore(distMi);
  totalScore  += score;

  startSpinToLocation(loc.lat, loc.lng);

  answerMarker = createMarker(loc.lat, loc.lng, COLOR_ANSWER);
  _globe.add(answerMarker);

  elDistanceDisplay.textContent = distMi.toLocaleString();

  animateCountUp(elRoundScoreDisplay, score);

  const prevTotal = totalScore - score;
  const hudStart  = performance.now();
  (function hudStep(now) {
    const t = Math.min((now - hudStart) / 1000, 1);
    const e = 1 - (1 - t) ** 3;
    elHudScore.textContent = Math.round(prevTotal + e * score).toLocaleString() + ' pts';
    if (t < 1) requestAnimationFrame(hudStep);
  })(performance.now());

  elScorePanel.classList.add('visible');

  setTimeout(() => {
    const isLastRound = currentRound === ROUNDS_PER_GAME - 1;
    elNextBtn.textContent = isLastRound ? 'See Results' : 'Next Round \u2192';
    elNextBtn.classList.add('visible');
    setState(STATE.NEXT_ROUND);
  }, 1500);
}

function resetGame() {
  clearRoundObjects();

  state          = STATE.IDLE;
  currentRound   = 0;
  totalScore     = 0;
  roundLocations = [];
  arcProgress    = 0;
  spinActive     = false;

  elIntroContent.classList.remove('hidden');
  elRoundContent.classList.add('hidden');
  elHudScore.classList.add('hidden');
  elHudScore.textContent = '0 pts';
  elScorePanel.classList.remove('visible');
  elNextBtn.classList.remove('visible');
  elNextBtn.textContent = 'Next Round \u2192';
  elRoundScoreDisplay.textContent = '0';
  elDistanceDisplay.textContent = '\u2014';
  elConfirmBtn.classList.add('hidden');
  elConfirmHint.classList.add('hidden');
  elGameOverPanel.classList.remove('visible');
  document.body.classList.remove('waiting');
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function initGame({ scene, globe, camera }) {
  _globe = globe;

  elIntroContent      = document.getElementById('intro-content');
  elRoundContent      = document.getElementById('round-content');
  elRoundNum          = document.getElementById('round-num');
  elLocationLabel     = document.getElementById('location-label');
  elConfirmBtn        = document.getElementById('confirm-btn');
  elConfirmHint       = document.getElementById('confirm-hint');
  elHudScore          = document.getElementById('hud-score');
  elScorePanel        = document.getElementById('score-panel');
  elDistanceDisplay   = document.getElementById('distance-display');
  elRoundScoreDisplay = document.getElementById('round-score-display');
  elNextBtn           = document.getElementById('next-btn');
  elGameOverPanel     = document.getElementById('game-over-panel');
  elFinalScoreDisplay = document.getElementById('final-score-display');

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
  globe.add(arcLine);

  // Wire buttons — stopPropagation prevents clicks from bleeding through to the canvas
  document.getElementById('start-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    roundLocations = pickLocations();
    currentRound   = 0;
    totalScore     = 0;
    setState(STATE.ROUND_START);
  });

  document.getElementById('next-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (state !== STATE.NEXT_ROUND) return;

    elScorePanel.classList.remove('visible');
    elNextBtn.classList.remove('visible');
    elRoundScoreDisplay.textContent = '0';
    elConfirmBtn.classList.add('hidden');
    elConfirmHint.classList.add('hidden');
    spinActive = false;

    clearRoundObjects();

    currentRound++;
    if (currentRound >= ROUNDS_PER_GAME) {
      setState(STATE.GAME_OVER);
    } else {
      setState(STATE.ROUND_START);
    }
  });

  document.getElementById('restart-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    resetGame();
  });

  elConfirmBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    confirmGuess();
  });

  setState(STATE.IDLE);

  return {
    onGlobeClick(lat, lng) {
      if (state !== STATE.WAITING_FOR_GUESS && state !== STATE.PENDING_GUESS) return;
      setPendingGuess(lat, lng);
    },

    tick(delta) {
      if (spinActive) {
        const step = SPIN_SPEED * Math.min(delta, 0.1);
        const dx   = spinTargetX - _globe.rotation.x;
        const dy   = spinTargetY - _globe.rotation.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 0.005) {
          _globe.rotation.x = spinTargetX;
          _globe.rotation.y = spinTargetY;
          spinActive = false;
        } else {
          const t = Math.min(step / dist, 1);
          _globe.rotation.x += dx * t;
          _globe.rotation.y += dy * t;
        }
      }

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
