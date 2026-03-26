import * as THREE from 'three';
import { haversineMi, calcScore } from './scoring.js';
import { LOCATIONS, ROUNDS_PER_GAME } from './locations.js';

// ─── Constants ────────────────────────────────────────────────────────────────
const GLOBE_RADIUS = 1;
const ARC_SEGMENTS = 64;
const ARC_SPEED    = 0.7; // progress units per second → ~1.4s for full arc
const MAX_TILT     = 65 * Math.PI / 180; // mirrors main.js — prevents euler clamp jump after slerp
const ZOOM_FINAL   = 1.5; // final tight zoom after reveal

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
let _camera;

// ─── Arc state ────────────────────────────────────────────────────────────────
let arcElapsed   = 0; // seconds elapsed since arc started (replaces linear arcProgress)
let arcActive    = false;
let allArcPoints = [];
let arcGeo, arcPositions, arcLine;
let guessMarker   = null;
let pendingMarker = null;
let answerMarker  = null;
let currentGuessLat, currentGuessLng;
let pendingLat, pendingLng;

// ─── Auto-spin / zoom state ───────────────────────────────────────────────────
const SPIN_DURATION  = 1.0 / ARC_SPEED; // matches arc draw time so both finish together
let spinActive       = false;
let spinJustStarted  = false; // true on first tick so spinStartQuat is captured after inertia runs
let spinStartQuat    = new THREE.Quaternion();
let spinTargetQuat   = new THREE.Quaternion();
let spinElapsed      = 0;
let zoomStartZ   = null;  // camera z at start of animation
let zoomTargetZ  = null;  // destination z (null = inactive)
let zoomDuration = 0;     // seconds
let zoomElapsed  = 0;     // seconds elapsed
let zoomInTimer  = null;  // setTimeout ID for phase-2 zoom

// ─── Scoreboard state ─────────────────────────────────────────────────────────
let roundScores = []; // { label, score, distMi } — one per completed round

// ─── UI element refs ──────────────────────────────────────────────────────────
let elTopPanel;
let elIntroContent, elRoundContent;
let elRoundNum, elLocationLabel;
let elConfirmBtn, elConfirmHint;
let elHudScore;
let elScorePanel, elDistanceDisplay, elRoundScoreDisplay, elNextBtn;
let elGameOverPanel, elFinalScoreDisplay;
let elScoreboard, elSbRows, elSbTotalRow, elSbTotalPts, elShareBtn;

// ─── Glow texture (shared across all markers) ────────────────────────────────
// Radial gradient on a canvas → CanvasTexture gives a soft circular glow dot.
function makeGlowTexture() {
  const size   = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx  = canvas.getContext('2d');
  const r    = size / 2;
  const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0,   'rgba(255,255,255,1.0)');
  grad.addColorStop(0.35,'rgba(255,255,255,0.7)');
  grad.addColorStop(1,   'rgba(255,255,255,0.0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fill();
  return new THREE.CanvasTexture(canvas);
}
const glowTexture = makeGlowTexture();

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Convert lat/lng to a local-space THREE.Vector3 on the globe surface.
 * Must exactly invert main.js's toLatLng which uses:
 *   lat = asin(local.y),  lng = atan2(local.z, local.x)
 */
function latLngToLocal(lat, lng, radius) {
  const phi   = (90 - lat) * (Math.PI / 180);
  const theta = -lng        * (Math.PI / 180); // negated: +Z in Three.js sphere = 90°W = lng -90°
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

  const base = latLngToLocal(lat, lng, GLOBE_RADIUS + 0.01);
  const tip  = latLngToLocal(lat, lng, GLOBE_RADIUS + 0.18);

  // Thin spike line — depthTest: true hides it when behind the globe
  const lineGeo = new THREE.BufferGeometry().setFromPoints([base, tip]);
  const line = new THREE.Line(
    lineGeo,
    new THREE.LineBasicMaterial({ color, depthTest: true }),
  );
  line.renderOrder = 1;
  group.add(line);

  // Glowing dot at the base — marks the exact clicked location, constant pixel size
  const dotGeo = new THREE.BufferGeometry();
  dotGeo.setAttribute('position', new THREE.BufferAttribute(
    new Float32Array([base.x, base.y, base.z]), 3,
  ));
  const dot = new THREE.Points(
    dotGeo,
    new THREE.PointsMaterial({
      color, size: 20, sizeAttenuation: false, depthTest: true,
      map: glowTexture, transparent: true, alphaTest: 0.01,
    }),
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
  // Scale lift by angular separation: close guesses stay low, far guesses arch high.
  // dot product gives cos(angle); clamp to [0,1] for acos safety.
  const angle   = Math.acos(Math.min(1, Math.max(-1, start.dot(end)))); // 0 → π
  const maxLift = Math.max(0.03, angle / Math.PI * 0.28); // 0.03 when same spot, 0.28 at antipode
  const pts = [];
  for (let i = 0; i <= ARC_SEGMENTS; i++) {
    const t    = i / ARC_SEGMENTS;
    const pt   = new THREE.Vector3().copy(start).lerp(end, t).normalize();
    const lift = Math.sin(t * Math.PI) * maxLift;
    pts.push(pt.multiplyScalar(GLOBE_RADIUS + 0.01 + lift));
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
  arcElapsed = 0;
  arcActive  = false;
}

// ─── State machine ────────────────────────────────────────────────────────────

function setState(next) {
  state = next;

  if (next === STATE.ROUND_START) {
    const loc = roundLocations[currentRound];

    elTopPanel.classList.remove('faded');
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
    elTopPanel.classList.add('faded');
    elConfirmBtn.classList.add('hidden');
    elConfirmHint.classList.add('hidden');
    document.body.classList.remove('waiting');
  }

  if (next === STATE.GAME_OVER) {
    elFinalScoreDisplay.textContent = totalScore.toLocaleString();
    elGameOverPanel.classList.add('visible');
    elShareBtn.classList.remove('hidden');
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

function startZoom(targetZ, duration) {
  zoomStartZ   = _camera.position.z;
  zoomTargetZ  = targetZ;
  zoomDuration = duration;
  zoomElapsed  = 0;
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
  arcElapsed   = 0;
  arcActive    = true;

  // Phase-1 zoom: fast ease-out to reveal distance (both pins visible)
  const revealDist = haversineMi(currentGuessLat, currentGuessLng, loc.lat, loc.lng);
  startZoom(Math.max(1.8, Math.min(4.2, 1.9 + (revealDist / 1553) * 2.5)), 0.8);

  // Start spinning immediately — globe rotates to answer while arc draws
  startSpinToLocation(loc.lat, loc.lng);

  setState(STATE.REVEALING);
}

function startSpinToLocation(lat, lng) {
  const p  = latLngToLocal(lat, lng, 1).normalize();
  const q0 = new THREE.Quaternion().setFromUnitVectors(p, new THREE.Vector3(0, 0, 1));

  // Where does the north pole end up after q0?
  const north = new THREE.Vector3(0, 1, 0).applyQuaternion(q0);
  // +roll rotates (north.x, north.y) to (0, r) — north pointing up on screen
  const roll  = Math.atan2(north.x, north.y);
  const qCorr = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll);

  // Apply q0 first, then qCorr: city faces camera AND north points up
  spinTargetQuat.copy(qCorr).multiply(q0);

  spinElapsed     = 0;
  spinActive      = true;
  spinJustStarted = true; // spinStartQuat will be captured on the first tick, after inertia runs
}

// Reorient globe so north pole is up while keeping the current facing longitude.
// Finds which longitude is facing the camera (+Z in local space), then spins so
// (lat=0, lng=facingLng) faces camera with north up — same roll-correction as startSpinToLocation.
function resetNorthUp() {
  // Globe's local +Z axis in world space = the point currently facing camera
  const worldFwd = new THREE.Vector3(0, 0, 1);
  const local    = _globe.worldToLocal(worldFwd.clone()).normalize();
  const facingLng = Math.atan2(-local.z, local.x) * (180 / Math.PI);
  // Spin to equator at that longitude (lat=0 means north is unambiguously up)
  startSpinToLocation(0, facingLng);
}

function scoreColor(score) {
  if (score >= 800) return '#4caf50';
  if (score >= 600) return '#8bc34a';
  if (score >= 400) return '#ffd700';
  if (score >= 200) return '#ff9800';
  return '#f44336';
}

function scoreEmoji(score) {
  if (score >= 800) return '🟢';
  if (score >= 400) return '🟡';
  if (score >= 200) return '🟠';
  return '🔴';
}

function updateScoreboard() {
  elSbRows.innerHTML = roundScores.map((r, i) => `
    <div class="sb-row">
      <span class="sb-num">${i + 1}</span>
      <span class="sb-city">${r.label}</span>
      <span class="sb-pts" style="color:${scoreColor(r.score)}">${r.score.toLocaleString()}</span>
    </div>`).join('');
  const total = roundScores.reduce((s, r) => s + r.score, 0);
  elSbTotalPts.textContent = `${total.toLocaleString()} / ${(ROUNDS_PER_GAME * 1000).toLocaleString()}`;
  elScoreboard.classList.remove('hidden');
  elSbTotalRow.classList.remove('hidden');
}

function onArcComplete() {
  const loc    = roundLocations[currentRound];
  const distMi = Math.round(haversineMi(currentGuessLat, currentGuessLng, loc.lat, loc.lng));
  const score  = calcScore(distMi);
  totalScore  += score;

  roundScores.push({ label: loc.label, score, distMi });
  updateScoreboard();

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

  // Phase-2 zoom: slow cinematic zoom in to final tight view
  zoomInTimer = setTimeout(() => {
    startZoom(ZOOM_FINAL, 2.0);
    zoomInTimer = null;
  }, 600);

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
  spinActive      = false;
  spinJustStarted = false;
  spinElapsed     = 0;
  spinStartQuat   = new THREE.Quaternion();
  spinTargetQuat  = new THREE.Quaternion();
  zoomTargetZ  = null;
  zoomStartZ   = null;
  zoomElapsed  = 0;
  if (zoomInTimer) { clearTimeout(zoomInTimer); zoomInTimer = null; }

  roundScores = [];
  elTopPanel.classList.remove('faded');
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
  elScoreboard.classList.add('hidden');
  elSbRows.innerHTML = '';
  elSbTotalRow.classList.add('hidden');
  elShareBtn.classList.add('hidden');
  elShareBtn.textContent = 'Share Results';
  document.body.classList.remove('waiting');
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function initGame({ scene, globe, camera }) {
  _globe  = globe;
  _camera = camera;

  elTopPanel          = document.getElementById('top-panel');
  elScoreboard        = document.getElementById('scoreboard');
  elSbRows            = document.getElementById('sb-rows');
  elSbTotalRow        = document.getElementById('sb-total-row');
  elSbTotalPts        = document.getElementById('sb-total-pts');
  elShareBtn          = document.getElementById('share-btn');
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
    new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: true }),
  );
  arcLine.renderOrder = 2;
  globe.add(arcLine);

  // Glow layer — same geometry, additive blended points give a thick soft glowing line
  const arcGlow = new THREE.Points(
    arcGeo,
    new THREE.PointsMaterial({
      color: 0xffd700, size: 28, sizeAttenuation: false,
      map: glowTexture, transparent: true, alphaTest: 0.01,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true,
    }),
  );
  arcGlow.renderOrder = 1;
  globe.add(arcGlow);

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
    zoomTargetZ = null;
    if (zoomInTimer) { clearTimeout(zoomInTimer); zoomInTimer = null; }

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

  elShareBtn.addEventListener('click', () => {
    const lines = roundScores.map((r, i) =>
      `${i + 1}. ${r.label.padEnd(22)} ${scoreEmoji(r.score)} ${r.score.toLocaleString()}`
    );
    const total = roundScores.reduce((s, r) => s + r.score, 0);
    const text  = `🌍 Globe Game\n${lines.join('\n')}\nTotal: ${total.toLocaleString()} / ${(ROUNDS_PER_GAME * 1000).toLocaleString()}`;
    navigator.clipboard.writeText(text).then(() => {
      elShareBtn.textContent = 'Copied!';
      setTimeout(() => { elShareBtn.textContent = 'Share Results'; }, 2000);
    });
  });

  return {
    resetNorthUp() { resetNorthUp(); },

    onGlobeClick(lat, lng) {
      if (state !== STATE.WAITING_FOR_GUESS && state !== STATE.PENDING_GUESS) return;
      setPendingGuess(lat, lng);
    },

    tick(delta) {
      // Time-based eased zoom animation
      if (zoomTargetZ !== null) {
        zoomElapsed = Math.min(zoomElapsed + delta, zoomDuration);
        const t     = zoomElapsed / zoomDuration;
        const eased = t < 0.5 ? 2*t*t : -1 + (4 - 2*t)*t; // smooth-step ease-in-out
        _camera.position.z = zoomStartZ + (zoomTargetZ - zoomStartZ) * eased;
        if (zoomElapsed >= zoomDuration) { _camera.position.z = zoomTargetZ; zoomTargetZ = null; }
      }

      if (spinActive) {
        if (spinJustStarted) {
          // Capture start orientation here — after applyRotation (inertia) ran in main.js
          // this frame — so there's no jump at the very first interpolation step.
          spinStartQuat.copy(_globe.quaternion);
          spinJustStarted = false;
        }
        spinElapsed    += Math.min(delta, 0.1);
        const raw       = Math.min(spinElapsed / SPIN_DURATION, 1);
        const eased     = 1 - Math.pow(1 - raw, 2); // ease-out quadratic
        _globe.quaternion.copy(spinStartQuat).slerp(spinTargetQuat, eased);
        if (raw >= 1) {
          spinActive = false;
        }
      }

      if (!arcActive || state !== STATE.REVEALING) return;

      arcElapsed += Math.min(delta, 0.1);
      const arcT    = Math.min(arcElapsed / (1.0 / ARC_SPEED), 1);
      const arcEased = 1 - Math.pow(1 - arcT, 2.5); // ease-out — fast start, decelerates
      const done    = arcT >= 1;
      const count   = done
        ? ARC_SEGMENTS + 1
        : Math.min(Math.floor(arcEased * ARC_SEGMENTS) + 2, ARC_SEGMENTS + 1);

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
