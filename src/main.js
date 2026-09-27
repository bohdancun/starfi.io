import { transformPoly, circleVsPolygon, segmentVsPolygon } from '../shared/geometry.js';
import { extractAccentColor } from '../shared/svgAccent.js';
import { classById } from '../shared/classes.js';
import { FireInput } from './fireInput.js';
import { gunMuzzle, enginePoint } from '../shared/guns.js';
import {
  WORLD_W, WORLD_H, WORLD_MIN, CHUNK_SIZE, CHUNKS_PER_AXIS, CHUNK_MIN,
  wrapX, wrapY, torusDelta, worldToChunk, chunkBounds,
} from '../shared/world.js';
import { BIOMES, getBiomeForChunk, biomeWeights, smoothBiomeWeights } from '../shared/biomes.js';

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

// Ship/bullet textures come from the server's 'init' (paths relative to /textures/), loaded lazily.
const texImgCache = new Map(); // path → HTMLImageElement
function texImg(path) {
  let img = texImgCache.get(path);
  if (!img) {
    img = new Image();
    img._loaded = false;
    img.onload = () => { img._loaded = true; };
    img.src = `/textures/${path}`;
    texImgCache.set(path, img);
  }
  return img;
}

// Ship and bullet types from 'init'. The fallback only covers the moment before init arrives.
let shipTypes = { basic: { name: 'Basic', texture: 'ships/basic_ship/shipbasic1.svg', r: 30 } };
let bulletTypes = { basic: { texture: 'ships/sniper/basicbullet.svg', r: 3 } };
let shipTextureScale = 60 / 128; // world units per texture pixel, same for every ship
function shipType(id) { return shipTypes[id] || shipTypes.basic; }

const shipOffscreen = document.createElement('canvas');
const shipOffCtx = shipOffscreen.getContext('2d');
const shipSilhouetteCache = new Map(); // `${shipType}:${tintColor}` → canvas with solid silhouette

const minimapFrameImg = new Image();
let minimapFrameReady = false;
minimapFrameImg.onload = () => { minimapFrameReady = true; };
minimapFrameImg.src = '/textures/minimapframe.svg';

const coinImgs = { small: new Image(), medium: new Image(), big: new Image() };
const COIN_SIZES = { small: 12, medium: 18, big: 26 };
for (const [key, img] of Object.entries(coinImgs)) {
  img._loaded = false;
  img.onload = () => { img._loaded = true; };
  img.src = `/textures/particles/gold/${key}coin.svg`;
}

function makeXpImg(src) {
  const img = new Image();
  img._loaded = false;
  img.onload = () => { img._loaded = true; };
  img.src = src;
  return img;
}
const xpImgs = {
  big:   [1, 2, 3].map(n => makeXpImg(`/textures/particles/xp/bigxp/bigxp${n}.svg`)),
  small: [1, 2, 3].map(n => makeXpImg(`/textures/particles/xp/smallxp/smallxp${n}.svg`)),
};
const XP_SIZES = { big: 24, small: 16 };

const rockImgCache = new Map(); // texturePath → HTMLImageElement
const rockSilhouetteCache = new Map(); // `${texturePath}:${tintColor}` → canvas with solid silhouette

// texturePath is relative to /textures/ ("rocks/48/rock48.svg", "xporerocks/64/xprock64_1.svg").
function loadRockTexture(path) {
  if (rockImgCache.has(path)) return rockImgCache.get(path);
  const img = new Image();
  img._loaded = false;
  img.onload = () => { img._loaded = true; };
  img.src = `/textures/${path}`;
  rockImgCache.set(path, img);
  return img;
}

// Per-rock cosmetic state — angle now server-owned and synced (no more random per client)
const rockAppearance = new Map(); // id -> { angle }

function syncRockAppearance(rocks) {
  const seen = new Set();
  for (const rock of rocks) {
    seen.add(rock.id);
    const cur = rockAppearance.get(rock.id);
    if (!cur) {
      rockAppearance.set(rock.id, { angle: rock.angle ?? 0 });
      if (rock.texturePath) loadRockTexture(rock.texturePath);
      if (rock.k === 'xp' && rock.texturePath) loadRockAccent(rock.texturePath);
    } else {
      if (rock.angle != null) cur.angle = rock.angle; // keep in sync with authoritative server angle
    }
  }
  for (const [id] of rockAppearance) {
    if (!seen.has(id)) rockAppearance.delete(id);
  }
}

// --- Biome color tinting ---
// Everything scales with the camera's biome weights (shared/biomes.js biomeWeights: a pure function
// of position, 0 in the neutral zone, 1 deep inside), so nothing can build up over time.
const BIOME_OBJECT_TINT_ALPHA = 0.3; // silhouette tint on ships, rocks, chips and shards at weight 1 (was 0.2)
const BIOME_TINT_COLORS = {
  frost: '#72A0E6',
  ember: '#E43B3B',
};
const BACKGROUND_TINT_ALPHA = 0.25; // mist over the background (below world objects) at weight 1 (was 0.5)

// Camera biome weights, recomputed from position every frame and lightly smoothed.
let biomeW = { frost: 0, ember: 0 };
function updateBiomeWeights(dt) {
  const target = myId === null ? { frost: 0, ember: 0 } : biomeWeights(localPlayer.x, localPlayer.y);
  biomeW = smoothBiomeWeights(biomeW, target, dt);
}

// Object tint for this frame: the strongest biome's color and a clamped alpha, or null in the neutral zone.
// Biome bands never overlap, so at most one weight is above zero.
function objectTint() {
  const id = biomeW.frost >= biomeW.ember ? 'frost' : 'ember';
  const alpha = Math.min(BIOME_OBJECT_TINT_ALPHA, Math.max(0, biomeW[id] * BIOME_OBJECT_TINT_ALPHA));
  return alpha > 0 ? { color: BIOME_TINT_COLORS[id], alpha } : null;
}

// RGB blended from the neutral value toward each biome's by its weight (key: a BIOMES color field).
function biomeMixRGB(key, neutral) {
  const out = [...neutral];
  for (const id of ['frost', 'ember']) {
    const w = biomeW[id], c = BIOMES[id][key];
    if (!(w > 0) || !c) continue;
    for (let i = 0; i < 3; i++) out[i] += (c[i] - out[i]) * Math.min(1, w);
  }
  return out.map(Math.round);
}

const PARALLAX_TILE = 2048;
const starLayers = [];

function makeStarLayer(count, minR, maxR, minAlpha, maxAlpha) {
  return Array.from({ length: count }, () => ({
    x: Math.random() * PARALLAX_TILE,
    y: Math.random() * PARALLAX_TILE,
    r: minR + Math.random() * (maxR - minR),
    alpha: minAlpha + Math.random() * (maxAlpha - minAlpha),
    phase: Math.random() * Math.PI * 2,
    phaseSpeed: Math.random() * 0.4 + 0.1,
  }));
}

function initStars() {
  starLayers.length = 0;
  starLayers.push({ parallax: 0.04, stars: makeStarLayer(180, 0.2, 0.7, 0.12, 0.35) }); // far
  starLayers.push({ parallax: 0.18, stars: makeStarLayer(90,  0.6, 1.3, 0.28, 0.60) }); // mid
  starLayers.push({ parallax: 0.45, stars: makeStarLayer(40,  1.1, 2.2, 0.55, 1.00) }); // near
}

// --- Shooting stars ---
const shootingStars = [];
const SHOOTING_STAR_RATE = 0.15; // avg spawns per second
const SHOOTING_STAR_PARALLAX = 0.04; // same depth as far star layer

function spawnShootingStar() {
  const ox = ((localPlayer.x * SHOOTING_STAR_PARALLAX) % PARALLAX_TILE + PARALLAX_TILE) % PARALLAX_TILE;
  const oy = ((localPlayer.y * SHOOTING_STAR_PARALLAX) % PARALLAX_TILE + PARALLAX_TILE) % PARALLAX_TILE;
  const angle = (Math.random() * 30 + 15) * Math.PI / 180; // 15–45° downward
  const speed = Math.random() * 400 + 350;
  shootingStars.push({
    x: Math.random() * canvas.width * 1.2 - canvas.width * 0.1 + ox,
    y: Math.random() * canvas.height * 0.5 + oy,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    len: Math.random() * 90 + 60,
    alpha: Math.random() * 0.3 + 0.7,
    life: 1,
  });
}

function updateShootingStars(dt) {
  if (Math.random() < SHOOTING_STAR_RATE * dt) spawnShootingStar();
  for (let i = shootingStars.length - 1; i >= 0; i--) {
    const s = shootingStars[i];
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.life -= dt * (0.9 + Math.random() * 0.4);
    if (s.life <= 0) { shootingStars.splice(i, 1); continue; }
  }
}

function drawShootingStars(camX, camY) {
  const ox = ((camX * SHOOTING_STAR_PARALLAX) % PARALLAX_TILE + PARALLAX_TILE) % PARALLAX_TILE;
  const oy = ((camY * SHOOTING_STAR_PARALLAX) % PARALLAX_TILE + PARALLAX_TILE) % PARALLAX_TILE;
  for (const s of shootingStars) {
    const sx = s.x - ox;
    const sy = s.y - oy;
    const nx = -s.vx / Math.hypot(s.vx, s.vy);
    const ny = -s.vy / Math.hypot(s.vx, s.vy);
    const tx = sx + nx * s.len;
    const ty = sy + ny * s.len;
    const grad = ctx.createLinearGradient(sx, sy, tx, ty);
    const a = Math.min(1, s.alpha * s.life * 2).toFixed(2);
    grad.addColorStop(0, `rgba(255,255,255,${a})`);
    grad.addColorStop(0.3, `rgba(220,230,255,${Math.min(1, s.alpha * s.life * 1.4).toFixed(2)})`);
    grad.addColorStop(1, `rgba(180,200,255,0)`);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(tx, ty);
    ctx.strokeStyle = grad;
    ctx.lineWidth = Math.max(0.5, s.life * 1.5);
    ctx.stroke();
  }
}

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  initStars();
}
window.addEventListener("resize", resize);
resize();

// Constants (must match server)
// WORLD_W/WORLD_H, wrapX/wrapY and torusDelta come from shared/world.js (world centered on the origin).
const PLAYER_ACCEL = 900;
const PLAYER_MAX_SPEED = 650;
const FWD_DRAG = 0.8;
const LAT_DRAG = 7.0;
const TURN_SPEED = 3.0; // rad/s — raise for snappier turning, lower for heavier feel (mirror in server.js)

// Returns the shortest signed angle from `from` to `to` in [-π, π].
function shortestAngleDelta(from, to) {
  let diff = (to - from) % (Math.PI * 2);
  if (diff > Math.PI)  diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

// --- Rock collision shapes (from the server's 'init'; the client never parses SVGs) ---
// texturePath → { localPoly, hull, boundR }; math shared with the server via shared/geometry.js.
let rockShapes = {};
// kind id → { massMult }, from 'init'. Rocks carry their kind as `k`.
let rockKinds = {};

// Same mass as the server's rock.mass (r² × kind massMult), so prediction matches.
function rockMass(rock) {
  return rock.r * rock.r * (rockKinds[rock.k]?.massMult ?? 1);
}

// Rotated shape for a rock, cached on its appearance entry until its angle changes.
function rockShape(rock) {
  const app = rockAppearance.get(rock.id);
  const shape = rockShapes[rock.texturePath];
  if (!app || !shape) return null;
  if (app.shapeAngle !== app.angle) {
    app.poly = transformPoly(shape.localPoly, 0, 0, app.angle);
    app.hull = transformPoly(shape.hull, 0, 0, app.angle);
    app.boundR = shape.boundR;
    app.shapeAngle = app.angle;
  }
  return app;
}

// Dev: ?debughit=1 draws rock polygons/hulls, ship circles and server bullet hit points.
const DEBUG_HIT = new URLSearchParams(location.search).get('debughit') === '1';
const DEBUG_HIT_LIFE = 1500; // ms a hit marker stays visible
const debugHits = []; // { x, y, t }

const MINIMAP_SIZE = 144;

const MINIMAP_HALF_WORLD = 1000;
// Expanded minimap (M, first press): grows toward the screen center from the same corner and
// zooms out to show MINIMAP_EXPANDED_CHUNKS chunks in every direction around the player.
const MINIMAP_EXPANDED_SIZE_MULT = 2;
const MINIMAP_EXPANDED_CHUNKS    = 4;     // → 8×8 chunk area
// XP rock markers on every map: accent-color rhombus (3:5) with a thin white outline, pulsing in size.
const XP_MARKER_HALF_W       = 3;     // px on the minimap (≈2× the old marker)
const XP_MARKER_PULSE        = 0.15;  // ± size
const XP_MARKER_PULSE_PERIOD = 1.0;   // s
const CORNER_PAD = 32;

const MAX_LEVEL = 99;
const LEVEL_THRESHOLDS = (() => {
  const t = [0];
  for (let i = 1; i < MAX_LEVEL; i++)
    t.push(t[i - 1] + Math.floor(10 * Math.pow(1.15, i - 1)));
  return t;
})();

const AWARD_LEVELS = new Set([
  ...Array.from({ length: 29 }, (_, i) => i + 1),
  ...Array.from({ length: 16 }, (_, i) => 30 + i * 2),
  ...Array.from({ length: 13 }, (_, i) => 63 + i * 3),
]);

function getLevelInfo(totalXp) {
  let level = MAX_LEVEL;
  for (let i = 0; i < MAX_LEVEL - 1; i++) {
    if (totalXp < LEVEL_THRESHOLDS[i + 1]) { level = i + 1; break; }
  }
  const start = LEVEL_THRESHOLDS[level - 1];
  const end   = level < MAX_LEVEL ? LEVEL_THRESHOLDS[level] : LEVEL_THRESHOLDS[MAX_LEVEL - 1] + 1;
  return { level, progress: Math.min(1, (totalXp - start) / (end - start)) };
}

const UPGRADE_DEFS_CLIENT = [
  { id: 'healthCap',       label: 'Health Capacity',  color: '#ef4444', texture: '/textures/interface/upgrades/healthupgrade1.svg' },
  { id: 'healthRegen',     label: 'Health Regen',     color: '#f472b6', texture: '/textures/interface/upgrades/hpregenupgrade2.svg' },
  { id: 'bulletReload',    label: 'Bullet Reload',    color: '#fbbf24', texture: '/textures/interface/upgrades/blreloadupgrade3.svg' },
  { id: 'bulletSpeed',     label: 'Bullet Speed',     color: '#fb923c', texture: '/textures/interface/upgrades/blspeedupgrade4.svg' },
  { id: 'bulletDamage',    label: 'Bullet Damage',    color: '#f97316', texture: '/textures/interface/upgrades/bldamageupgrade5.svg' },
  { id: 'shipSpeed',       label: 'Ship Speed',       color: '#22d3ee', texture: '/textures/interface/upgrades/shipspeedupgrade6.svg' },
  { id: 'shipAgility',     label: 'Ship Agility',     color: '#60a5fa', texture: '/textures/interface/upgrades/agilityupgrade7.svg' },
  { id: 'bodyDamage',      label: 'Body Damage',      color: '#c084fc', texture: '/textures/interface/upgrades/bodydamageupgrade8.svg' },
  { id: 'collisionShield', label: 'Collision Shield', color: '#818cf8', texture: '/textures/interface/upgrades/bodyshieldupgrade9.svg' },
];
const MAX_UPGRADE_LEVEL = 6;
const UPGRADE_XP_PER_LEVEL = 50;

const upgradeImgs = {};
for (const def of UPGRADE_DEFS_CLIENT) {
  const img = new Image();
  img._loaded = false;
  img.onload = () => { img._loaded = true; };
  img.src = def.texture;
  upgradeImgs[def.id] = img;
}
const emptyUpgradeImg = new Image();
emptyUpgradeImg._loaded = false;
emptyUpgradeImg.onload = () => { emptyUpgradeImg._loaded = true; };
emptyUpgradeImg.src = '/textures/interface/upgrades/emptyupgrade.svg';
const fullUpgradeImg = new Image();
fullUpgradeImg._loaded = false;
fullUpgradeImg.onload = () => { fullUpgradeImg._loaded = true; };
fullUpgradeImg.src = '/textures/interface/upgrades/fullupgrade.svg';


// --- WebSocket ---

let connected = false;
let myId = null;
let ws = null;
let ping = 0;
let onlineCount = 1; // from the server; other players are only sent when in view range
let pingT = 0;
let pingInterval = null;

function connectToGame(nickname) {
  localPlayer.nickname = nickname || 'Player';

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token    = localStorage.getItem('starship_token') || '';
  const params   = new URLSearchParams();
  if (token) params.set('token', token);
  params.set('color', selectedColor);
  if (DEBUG_HIT) params.set('debughit', '1');
  ws = new WebSocket(`${protocol}//${location.host}/ws?${params.toString()}`);

  ws.onopen  = () => {
    connected = true;
    pingInterval = setInterval(() => {
      if (ws.readyState === 1) {
        pingT = performance.now();
        ws.send(JSON.stringify({ type: 'ping', t: pingT }));
      }
    }, 2000);
  };
  ws.onclose = () => { connected = false; clearInterval(pingInterval); };
  ws.onerror = () => { connected = false; clearInterval(pingInterval); };
  ws.onmessage = handleMessage;
}

// --- Local player (client-side prediction) ---

const localPlayer = {
  x: 0, y: 0,
  vx: 0, vy: 0, angle: 0,
  hp: 100, maxHp: 100,
  color: '#ffffff',
  gemCount: 0,
  xpCount: 0,
  totalXpEarned: 0,
  level: 1,
  upgradePoints: 0,
  dead: false,
  respawnTimer: 0,
  shipType: 'basic',
  upgrades: Object.fromEntries(UPGRADE_DEFS_CLIENT.map(d => [d.id, 0])),
  turnSpeed: TURN_SPEED,
};

let deathPoint = null;
let prevDead = false;

// Server-authoritative state
const remotePlayers = new Map();
let serverRocks = [];
let serverGems = [];
let serverXpDrops = [];
let serverBullets = [];

// --- Input ---

const keys = new Set();
const upgradeFlashTime = new Array(UPGRADE_DEFS_CLIENT.length).fill(-1);
let upgradeBarHidden = true;
let upgradeBarSlideY = 112 + 32; // start fully off-screen (btnH + CORNER_PAD)
let _prevUpgradePoints = 0;
window.addEventListener("keydown", e => {
  const typing = document.activeElement && document.activeElement.tagName === 'INPUT';
  if (!typing && (e.key === 'm' || e.key === 'M') && !e.repeat && myId !== null &&
      !CHEATS.some(code => (cheatBuffer + e.key.toLowerCase()).endsWith(code))) { // e.g. the "m" ending "hesoyam"
    setMapMode((mapMode + 1) % 3);
  }
  if (e.key === 'Escape' && mapMode !== 0) setMapMode(0);
  const upgradeIdx = parseInt(e.key) - 1;
  if (upgradeIdx >= 0 && upgradeIdx < UPGRADE_DEFS_CLIENT.length) {
    sendUpgrade(UPGRADE_DEFS_CLIENT[upgradeIdx].id);
    upgradeFlashTime[upgradeIdx] = performance.now();
  }
  if (e.key === 'u' || e.key === 'U') {
    upgradeBarHidden = !upgradeBarHidden;
  }
  keys.add(e.key.toLowerCase());
  if (e.key === ' ') {
    e.preventDefault();
    if (!e.repeat && !typing && fireInput.press('space')) sendInputNow();
  }
});
window.addEventListener("keyup", e => {
  keys.delete(e.key.toLowerCase());
  if (e.key === ' ' && fireInput.release('space')) sendInputNow();
});

let mouseX = canvas.width / 2;
let mouseY = canvas.height / 2;
let rightMouseDown = false;
// Fire state from all sources (mouse button + Space). Changes are sent immediately; see src/fireInput.js.
const fireInput = new FireInput();
// Dev: ?debugfire=1 logs fire input changes and sends to the console.
const DEBUG_FIRE = new URLSearchParams(location.search).get('debugfire') === '1';
let aimAngle = 0;
let currentThrust = 0;

window.addEventListener("mousemove", e => {
  // Recover a missed mouseup (released outside the window, etc.): the button is no longer down.
  if (!(e.buttons & 1) && fireInput.release('mouse')) sendInputNow();
  mouseX = e.clientX;
  mouseY = e.clientY;
  aimAngle = Math.atan2(mouseY - canvas.height / 2, mouseX - canvas.width / 2);
});
window.addEventListener("contextmenu", e => e.preventDefault());
window.addEventListener("mousedown", e => {
  if (e.button === 0 && mapHit(e.clientX, e.clientY)) return; // clicks on any map never fire
  if (e.button === 0) {
    const card = classCardAt(e.clientX, e.clientY);
    if (card) { classMenu.pressId = card.id; return; } // consumed: no bullet, no hold
    if (fireInput.press('mouse')) sendInputNow();
  }
  if (e.button === 2) rightMouseDown = true;
});
window.addEventListener("mouseup", e => {
  if (e.button === 0 && classMenu.pressId) {
    const card = classCardAt(e.clientX, e.clientY);
    if (card && card.id === classMenu.pressId) chooseClassCard(card.id);
    classMenu.pressId = null;
  }
  // Release anywhere in the window, even if the press was consumed by a card or map (never blocks firing).
  if (e.button === 0 && fireInput.release('mouse')) sendInputNow();
  if (e.button === 2) rightMouseDown = false;
});

// Nothing may stay pressed when the window loses focus, the tab is hidden, or the pointer is cancelled:
// release fire (and movement keys, which get stuck the same way) and tell the server right away.
function releaseAllInput() {
  keys.clear();
  rightMouseDown = false;
  fireInput.releaseAll();
  sendInputNow();
}
window.addEventListener('blur', releaseAllInput);
window.addEventListener('pointercancel', releaseAllInput);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAllInput(); });

// --- Server messages ---

function handleMessage(event) {
  const msg = JSON.parse(event.data);

  if (msg.type === 'init') {
    myId = msg.id;
    localPlayer.x = msg.x;
    localPlayer.y = msg.y;
    localPlayer.color = msg.color;
    rockShapes = msg.rockShapes || {};
    rockKinds = msg.rockKinds || {};
    if (msg.shipTypes) shipTypes = msg.shipTypes;
    if (msg.bulletTypes) bulletTypes = msg.bulletTypes;
    if (msg.shipTextureScale) shipTextureScale = msg.shipTextureScale;
    serverRocks = msg.rocks;
    serverGems = msg.gems;
    syncRockAppearance(serverRocks);
    for (const p of msg.players) {
      if (p.id !== myId) remotePlayers.set(p.id, p);
    }
  }

  else if (msg.type === 'tick') {
    // Before replacing serverRocks, so shatters start from the local interpolated rock.
    if (msg.brokenRocks) handleBrokenRocks(msg.brokenRocks);
    // Visual feedback events; pickups before gems/xp lists are replaced, so the pop starts from our copy.
    if (msg.hits) handleHitEvents(msg.hits);
    if (msg.pickups) handlePickupEvents(msg.pickups);
    if (msg.playerDied) handlePlayerDiedEvents(msg.playerDied); // before positions update: shatter from our copy
    if (msg.rocks   !== undefined) { serverRocks = msg.rocks; syncRockAppearance(serverRocks); }
    if (msg.gems    !== undefined) serverGems    = msg.gems;
    if (msg.xpDrops !== undefined) serverXpDrops = msg.xpDrops || [];

    // Merge bullets — preserve existing extrapolated positions for bullets we already know
    if (msg.bullets) {
      const incoming = new Map(msg.bullets.map(b => [b.id, b]));
      serverBullets = msg.bullets.map(b => {
        const old = serverBullets.find(ob => ob.id === b.id);
        if (!old) spawnMuzzleFlash(b); // first sighting of a bullet → flash at its gun
        return old ? { ...b, x: old.x, y: old.y } : b;
      });
    }

    const seen = new Set();
    for (const p of msg.players) {
      trackLevelUp(p);
      const respawned = trackRespawn(p);
      if (p.id === myId) {
        if (respawned) { localPlayer.x = p.x; localPlayer.y = p.y; } // appear at the spawn, don't glide there
        localPlayer.x = wrapX(localPlayer.x + torusDelta(p.x, localPlayer.x, WORLD_W) * 0.15);
        localPlayer.y = wrapY(localPlayer.y + torusDelta(p.y, localPlayer.y, WORLD_H) * 0.15);
        localPlayer.hp = p.hp;
        localPlayer.maxHp = p.maxHp;
        localPlayer.dead = p.dead;
        localPlayer.respawnTimer = p.respawnTimer;
        localPlayer.gemCount = p.gemCount;
        localPlayer.xpCount = p.xpCount;
        localPlayer.totalXpEarned = p.totalXpEarned ?? localPlayer.totalXpEarned;
        localPlayer.level = p.level ?? localPlayer.level;
        localPlayer.upgradePoints = p.upgradePoints ?? localPlayer.upgradePoints;
        localPlayer.upgrades = p.upgrades || localPlayer.upgrades;
        localPlayer.turnSpeed = p.turnSpeed || TURN_SPEED;
        localPlayer.shipType = p.shipType || 'basic';
        if (p.dead) { localPlayer.vx = 0; localPlayer.vy = 0; }
      } else {
        const existing = remotePlayers.get(p.id);
        // Keep smooth render position, snap target to server authority
        remotePlayers.set(p.id, {
          ...p,
          renderX: existing && !respawned ? existing.renderX : p.x,
          renderY: existing && !respawned ? existing.renderY : p.y,
        });
        seen.add(p.id);
      }
    }
    if (msg.online != null) onlineCount = msg.online;
    for (const [id] of remotePlayers) {
      if (!seen.has(id)) { remotePlayers.delete(id); lastLevels.delete(id); lastDeadState.delete(id); } // left view range
    }
  }

  else if (msg.type === 'classChoice') {
    setClassMenuOptions(msg.options);
  }

  else if (msg.type === 'pong') {
    ping = Math.round(performance.now() - pingT);
  }

  else if (msg.type === 'playerLeft') {
    remotePlayers.delete(msg.id);
    lastLevels.delete(msg.id);
    lastDeadState.delete(msg.id);
    respawnFx.delete(msg.id);
  }

  else if (msg.type === 'playerJoined') {
    if (msg.player.id !== myId) remotePlayers.set(msg.player.id, msg.player);
  }
}

// --- Send input (throttled to server tick rate) ---

let inputTimer = 0;
const INPUT_INTERVAL = 1 / 60;

function sendInput() {
  if (!ws || !connected || myId === null || ws.readyState !== 1) return;
  const fire = fireInput.snapshot(); // { shoot: held or a tap since the last send, fs: press count }
  if (DEBUG_FIRE && fire.shoot) console.log(`[fire] send shoot=${fire.shoot} fs=${fire.fs} held=${fireInput.held}`);
  ws.send(JSON.stringify({
    type: 'input',
    angle: aimAngle,
    thrust: currentThrust,
    shoot: fire.shoot,
    fs: fire.fs,
  }));
}

// Fire state changed: send now instead of waiting for the throttle timer.
function sendInputNow() {
  if (DEBUG_FIRE) console.log(`[fire] change held=${fireInput.held}`);
  sendInput();
}

// --- Client-side collision prediction (mirrors server checkPlayerRockCollisions, no damage) ---
// Same broad phase and the same shared circleVsPolygon as the server, so predictions agree.

function checkLocalPlayerRockCollisions() {
  const pr = shipType(localPlayer.shipType).r;
  for (const rock of serverRocks) {
    const shape = rockShape(rock);
    if (!shape) continue;
    const cdx = torusDelta(localPlayer.x, rock.x, WORLD_W);
    const cdy = torusDelta(localPlayer.y, rock.y, WORLD_H);
    if (cdx * cdx + cdy * cdy >= (pr + shape.boundR) ** 2) continue;

    const contact = circleVsPolygon(cdx, cdy, pr, shape.poly);
    if (!contact) continue;
    const nx = contact.nx, ny = contact.ny, overlap = contact.depth;

    const mP = pr * pr;
    const mR = rockMass(rock);
    const invSum = 1 / (mP + mR);

    localPlayer.x = wrapX(localPlayer.x + nx * overlap * (mR * invSum));
    localPlayer.y = wrapY(localPlayer.y + ny * overlap * (mR * invSum));

    const rvx = localPlayer.vx - (rock.vx || 0);
    const rvy = localPlayer.vy - (rock.vy || 0);
    const relN = rvx * nx + rvy * ny;

    if (relN < 0) {
      const j = -(1 + 0.15) * relN / (1 / mP + 1 / mR);
      localPlayer.vx += (j / mP) * nx;
      localPlayer.vy += (j / mP) * ny;
      const punchMult = 1 + (localPlayer.upgrades.collisionShield || 0) * 0.20;
      rock.vx = (rock.vx || 0) - (j * punchMult * 3.0 / mR) * nx;
      rock.vy = (rock.vy || 0) - (j * punchMult * 3.0 / mR) * ny;
    }
  }
}

// --- Client-side prediction ---

function update(dt) {
  if (localPlayer.dead || myId === null) {
    inputTimer += dt;
    if (inputTimer >= INPUT_INTERVAL) { sendInput(); inputTimer = Math.min(inputTimer - INPUT_INTERVAL, INPUT_INTERVAL); }
    return;
  }

  // Turning: Q/E/A/D rotate the ship heading; speed scales with Ship Agility upgrade
  const ts = localPlayer.turnSpeed || TURN_SPEED;
  if (keys.has('q') || keys.has('a') || keys.has('arrowleft')) aimAngle -= ts * dt;
  if (keys.has('e') || keys.has('d') || keys.has('arrowright')) aimAngle += ts * dt;

  // Right-mouse snaps heading toward cursor and drives forward
  if (rightMouseDown) {
    aimAngle = Math.atan2(mouseY - canvas.height / 2, mouseX - canvas.width / 2);
  }
  // Turn toward target angle at turnSpeed rad/s — mirrors server updatePlayers logic exactly.
  const maxTurn = ts * dt;
  const angleDiff = shortestAngleDelta(localPlayer.angle, aimAngle);
  if (Math.abs(angleDiff) <= maxTurn) {
    localPlayer.angle = aimAngle;
  } else {
    localPlayer.angle += Math.sign(angleDiff) * maxTurn;
  }

  // Thrust: W/up or right-mouse = forward, S/down = reverse
  currentThrust = 0;
  if (keys.has('w') || keys.has('arrowup') || rightMouseDown) currentThrust = 1;
  if (keys.has('s') || keys.has('arrowdown')) currentThrust = -0.5;

  // Shoot: held state only; per-gun cooldowns live on the server.

  // Car physics: thrust along facing direction + directional drag
  const fx = Math.cos(localPlayer.angle), fy = Math.sin(localPlayer.angle);
  const lx = -fy, ly = fx; // lateral (perpendicular) unit vector

  localPlayer.vx += fx * currentThrust * PLAYER_ACCEL * dt;
  localPlayer.vy += fy * currentThrust * PLAYER_ACCEL * dt;

  // Decompose into forward/lateral, apply separate drag
  const fwdSpd = localPlayer.vx * fx + localPlayer.vy * fy;
  const latSpd = localPlayer.vx * lx + localPlayer.vy * ly;
  const fwdNew = fwdSpd * Math.exp(-FWD_DRAG * dt);
  const latNew = latSpd * Math.exp(-LAT_DRAG * dt);
  localPlayer.vx = fwdNew * fx + latNew * lx;
  localPlayer.vy = fwdNew * fy + latNew * ly;

  const spd = Math.hypot(localPlayer.vx, localPlayer.vy);
  if (spd > PLAYER_MAX_SPEED) {
    localPlayer.vx *= PLAYER_MAX_SPEED / spd;
    localPlayer.vy *= PLAYER_MAX_SPEED / spd;
  }

  localPlayer.x = wrapX(localPlayer.x + localPlayer.vx * dt);
  localPlayer.y = wrapY(localPlayer.y + localPlayer.vy * dt);

  // Keep the remainder (not reset to 0), otherwise ~16.6ms frames against a 16.67ms interval skip every
  // other send and the rate drops toward 30 Hz.
  inputTimer += dt;
  if (inputTimer >= INPUT_INTERVAL) { sendInput(); inputTimer = Math.min(inputTimer - INPUT_INTERVAL, INPUT_INTERVAL); }

  // Interpolate remote players toward server-authoritative position
  for (const [, p] of remotePlayers) {
    if (p.renderX === undefined) { p.renderX = p.x; p.renderY = p.y; continue; }
    p.renderX += torusDelta(p.x, p.renderX, WORLD_W) * Math.min(1, 14 * dt);
    p.renderY += torusDelta(p.y, p.renderY, WORLD_H) * Math.min(1, 14 * dt);
  }

  // Extrapolate bullets client-side
  for (const b of serverBullets) {
    b.x = wrapX(b.x + b.vx * dt);
    b.y = wrapY(b.y + b.vy * dt);
  }

  // Extrapolate gems with drag
  for (const g of serverGems) {
    if (g.vx === undefined) continue;
    g.x = wrapX(g.x + g.vx * dt);
    g.y = wrapY(g.y + g.vy * dt);
    g.vx *= Math.exp(-3 * dt);
    g.vy *= Math.exp(-3 * dt);
  }

  // Extrapolate xp drops with drag
  for (const x of serverXpDrops) {
    if (x.vx === undefined) continue;
    x.x = wrapX(x.x + x.vx * dt);
    x.y = wrapY(x.y + x.vy * dt);
    x.vx *= Math.exp(-3 * dt);
    x.vy *= Math.exp(-3 * dt);
  }

  // Extrapolate rocks with drag
  for (const r of serverRocks) {
    if (!r.vx && !r.vy) continue;
    r.x = wrapX(r.x + r.vx * dt);
    r.y = wrapY(r.y + r.vy * dt);
    r.vx *= Math.exp(-1.8 * dt);
    r.vy *= Math.exp(-1.8 * dt);
  }

  checkLocalPlayerRockCollisions();

  for (const layer of starLayers) {
    for (const s of layer.stars) s.phase += s.phaseSpeed * dt;
  }
  updateShootingStars(dt);
}

// --- Upgrade actions ---

const upgradeHitBoxes = []; // [{x, y, w, h, id}] rebuilt every frame

function sendUpgrade(statId) {
  if (!ws || !connected || myId === null || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'upgrade', stat: statId }));
}

// --- Cheat codes ---
// 'gotolvl' (dev builds only; the server also refuses it when NODE_ENV=production) → level 15.
const CHEATS = import.meta.env.DEV ? ['hesoyam', 'gotolvl'] : ['hesoyam'];
let cheatBuffer = '';
window.addEventListener('keypress', e => {
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  cheatBuffer = (cheatBuffer + e.key).slice(-16);
  for (const code of CHEATS) {
    if (cheatBuffer.endsWith(code)) {
      ws.send(JSON.stringify({ type: 'cheat', code }));
      cheatBuffer = '';
    }
  }
});

canvas.addEventListener('click', e => {
  if (localPlayer.dead) return;
  for (const box of upgradeHitBoxes) {
    if (e.clientX >= box.x && e.clientX <= box.x + box.w &&
        e.clientY >= box.y && e.clientY <= box.y + box.h) {
      sendUpgrade(box.id);
      break;
    }
  }
});

// --- Drawing ---

function drawGrid(camX, camY) {
  const gridSize = 60;
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;

  const startX = Math.floor((camX - canvas.width / 2) / gridSize) * gridSize;
  const endX = Math.floor((camX + canvas.width / 2) / gridSize) * gridSize;
  const startY = Math.floor((camY - canvas.height / 2) / gridSize) * gridSize;
  const endY = Math.floor((camY + canvas.height / 2) / gridSize) * gridSize;

  ctx.beginPath();
  for (let x = startX; x <= endX; x += gridSize) {
    ctx.moveTo(x - camX + canvas.width / 2, startY - camY + canvas.height / 2);
    ctx.lineTo(x - camX + canvas.width / 2, endY - camY + canvas.height / 2);
  }
  for (let y = startY; y <= endY; y += gridSize) {
    ctx.moveTo(startX - camX + canvas.width / 2, y - camY + canvas.height / 2);
    ctx.lineTo(endX - camX + canvas.width / 2, y - camY + canvas.height / 2);
  }
  ctx.stroke();
}

function drawHealthBar(centerX, topY, radius, hp, maxHp) {
  const w = Math.max(34, radius * 2.2);
  const h = 6;
  const x = centerX - w / 2;
  const pct = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;

  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.fillRect(x, topY, w, h);
  ctx.fillStyle = "rgba(239,68,68,0.9)";
  ctx.fillRect(x, topY, w * pct, h);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x, topY, w, h);
}

function drawXpBar(centerX, topY, radius, totalXp, scale = 1) {
  const { level, progress } = getLevelInfo(totalXp);
  const w = Math.max(34, radius * 2.2);
  const h = 6;
  const x = centerX - w / 2;
  ctx.save();
  if (scale !== 1) { // pickup pulse: scale around the bar's center
    ctx.translate(centerX, topY + h / 2);
    ctx.scale(scale, scale);
    ctx.translate(-centerX, -(topY + h / 2));
  }

  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.fillRect(x, topY, w, h);
  ctx.fillStyle = "rgba(74,222,128,0.9)";
  ctx.fillRect(x, topY, w * progress, h);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x, topY, w, h);

  ctx.font = 'bold 10px Ticketing';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText(`${level}`, x + w + 4, topY + h / 2);
  ctx.restore();
}

// Create or retrieve a solid silhouette canvas for a ship type in a given tint color
function getShipSilhouette(shipId, tintColor) {
  if (!tintColor) return null;
  const key = `${shipId}:${tintColor}`;
  if (shipSilhouetteCache.has(key)) return shipSilhouetteCache.get(key);

  const ship = shipType(shipId);
  const img = texImg(ship.texture);
  if (!img._loaded) return null;

  const drawW = Math.round((img.naturalWidth || ship.r * 2 / shipTextureScale) * shipTextureScale);
  const drawH = Math.round((img.naturalHeight || ship.r * 2 / shipTextureScale) * shipTextureScale);

  const c = document.createElement('canvas');
  c.width = drawW;
  c.height = drawH;
  const g = c.getContext('2d');

  // Draw texture's alpha channel filled with tint color
  g.drawImage(img, 0, 0, drawW, drawH);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = tintColor;
  g.fillRect(0, 0, drawW, drawH);

  shipSilhouetteCache.set(key, c);
  return c;
}

function drawShip(sx, sy, angle, color, shipId, flash = false, scale = 1, white = 0, alpha = 1) {
  const ship = shipType(shipId);
  const r = ship.r;
  const img = texImg(ship.texture);
  const ready = img._loaded;
  // Every ship texture is drawn at the same pixel scale; the hitbox radius is separate (ship.r).
  const drawW = Math.round((img.naturalWidth || r * 2 / shipTextureScale) * shipTextureScale);
  const drawH = Math.round((img.naturalHeight || r * 2 / shipTextureScale) * shipTextureScale);

  if (ready) {
    if (shipOffscreen.width !== drawW || shipOffscreen.height !== drawH) {
      shipOffscreen.width  = drawW;
      shipOffscreen.height = drawH;
    }
    shipOffCtx.clearRect(0, 0, drawW, drawH);
    shipOffCtx.globalCompositeOperation = 'source-over';
    shipOffCtx.drawImage(img, 0, 0, drawW, drawH);
    shipOffCtx.globalCompositeOperation = 'multiply';
    shipOffCtx.fillStyle = color;
    shipOffCtx.fillRect(0, 0, drawW, drawH);
    // Clip tint back to original alpha so transparent areas stay transparent
    shipOffCtx.globalCompositeOperation = 'destination-in';
    shipOffCtx.drawImage(img, 0, 0, drawW, drawH);
    const whiteA = Math.max(flash ? HIT_FLASH_ALPHA : 0, white);
    if (whiteA > 0) {
      // Hit flash (75%) or fading respawn silhouette: white over the silhouette only (source-atop keeps alpha).
      shipOffCtx.globalCompositeOperation = 'source-atop';
      shipOffCtx.fillStyle = `rgba(255,255,255,${whiteA.toFixed(3)})`;
      shipOffCtx.fillRect(0, 0, drawW, drawH);
    }
    shipOffCtx.globalCompositeOperation = 'source-over';

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(angle + Math.PI / 2);
    if (scale !== 1) ctx.scale(scale, scale);
    if (alpha !== 1) ctx.globalAlpha = alpha;
    ctx.drawImage(shipOffscreen, -drawW / 2, -drawH / 2);

    // Biome tint on top of the player color (cached silhouette, only ever drawn from).
    const tint = objectTint();
    const silhouette = tint && getShipSilhouette(shipId, tint.color);
    if (silhouette) {
      ctx.save();
      ctx.globalAlpha = alpha * tint.alpha;
      ctx.drawImage(silhouette, -drawW / 2, -drawH / 2);
      ctx.restore();
    }

    ctx.restore();
  } else {
    // Fallback triangle while image loads
    const tip = r + 10, back = r + 6, halfW = r * 0.9;
    ctx.beginPath();
    ctx.moveTo(sx + Math.cos(angle) * tip, sy + Math.sin(angle) * tip);
    ctx.lineTo(sx + Math.cos(angle + Math.PI) * back + Math.cos(angle + Math.PI / 2) * halfW,
               sy + Math.sin(angle + Math.PI) * back + Math.sin(angle + Math.PI / 2) * halfW);
    ctx.lineTo(sx + Math.cos(angle + Math.PI) * back + Math.cos(angle - Math.PI / 2) * halfW,
               sy + Math.sin(angle + Math.PI) * back + Math.sin(angle - Math.PI / 2) * halfW);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }
}

// Create or retrieve a solid silhouette canvas for a rock texture in a given tint color
function getRockSilhouette(texturePath, tintColor) {
  if (!tintColor) return null;
  const key = `${texturePath}:${tintColor}`;
  if (rockSilhouetteCache.has(key)) return rockSilhouetteCache.get(key);

  const img = loadRockTexture(texturePath);
  if (!img || !img._loaded) return null;

  // Texture's own pixel size; drawRocks scales it to the rock's size like the texture itself.
  const w = Math.max(1, Math.round(img.naturalWidth || 128));
  const h = Math.max(1, Math.round(img.naturalHeight || 128));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');

  // Draw texture's alpha channel filled with tint color
  g.drawImage(img, 0, 0, w, h);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = tintColor;
  g.fillRect(0, 0, w, h);

  rockSilhouetteCache.set(key, c);
  return c;
}

function drawRocks(camX, camY) {
  const tint = objectTint();
  for (const rock of serverRocks) {
    const dx = torusDelta(rock.x, camX, WORLD_W);
    const dy = torusDelta(rock.y, camY, WORLD_H);
    const sx = canvas.width / 2 + dx;
    const sy = canvas.height / 2 + dy;

    const margin = rock.r + 40;
    if (sx < -margin || sx > canvas.width + margin || sy < -margin || sy > canvas.height + margin) continue;

    const drawSize = rock.r * 2;
    // Knock-and-snap: a visual-only offset/twitch after a hit (position, physics and hitbox untouched).
    const knock = rockKnockOffset(rock.id);
    const angle = (rockAppearance.get(rock.id)?.angle ?? 0) + (knock ? knock.rot : 0);

    // Lazy-loaded on first sight; skip drawing until the image is ready.
    const img = rock.texturePath ? loadRockTexture(rock.texturePath) : null;
    if (!img || !img._loaded) continue;

    ctx.save();
    ctx.translate(knock ? sx + knock.dx : sx, knock ? sy + knock.dy : sy);
    ctx.rotate(angle);
    ctx.drawImage(img, -drawSize / 2, -drawSize / 2, drawSize, drawSize);

    // Biome tint over the rock (cached silhouette, only ever drawn from).
    const silhouette = tint && getRockSilhouette(rock.texturePath, tint.color);
    if (silhouette) {
      ctx.save();
      ctx.globalAlpha = tint.alpha;
      ctx.drawImage(silhouette, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
      ctx.restore();
    }

    ctx.restore();
  }
}

// --- XP rock particles (visual only) ---
// A rhombus in the rock texture's accent color pops up just outside the silhouette, in hard steps.

const XP_PARTICLE_FRAMES     = [[8, 16], [16, 32], [8, 16]]; // [width, height] per frame, world units
const XP_PARTICLE_FRAME_TIME = 0.065; // s per frame (3 frames ≈ 0.2s)
const XP_PARTICLE_GAP_MIN    = 1.0;   // s between particles on one rock (random in [min, max])
const XP_PARTICLE_GAP_MAX    = 2.0;
// Gap between the rock edge and the particle at its peak size. The center is pushed out by this
// plus the peak rhombus's reach toward the edge: 12 units off side-facing edges, up to 20 off
// top/bottom-facing ones (the peak is 32 tall), so it never overlaps the outline.
const XP_PARTICLE_OFFSET     = 4;
const XP_PARTICLE_OPACITY    = 0.75;
const XP_PARTICLE_TRIES      = 4;     // edge points tried per spawn before skipping (deep dents)
const XP_PARTICLE_FALLBACK   = '#ffffff';

// texturePath → accent color from the texture SVG, null while loading. Bad textures → white, warned once.
const rockAccentCache = new Map();
function loadRockAccent(path) {
  if (rockAccentCache.has(path)) return;
  rockAccentCache.set(path, null);
  fetch(`/textures/${path}`).then(r => r.text()).then(svg => {
    const accent = extractAccentColor(svg);
    if (!accent) console.warn(`[xp rocks] no single accent color in ${path}; using white particles`);
    rockAccentCache.set(path, accent || XP_PARTICLE_FALLBACK);
  }).catch(() => rockAccentCache.set(path, XP_PARTICLE_FALLBACK));
}

// Rock-relative particle center for (edge, t) on the rotated polygon. Positive winding, so
// (dy, -dx) is the outward normal. Recomputed each frame, so it follows rotation and drift.
function xpParticleCenter(poly, edge, t) {
  const [ax, ay] = poly[edge], [bx, by] = poly[(edge + 1) % poly.length];
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
  const nx = dy / len, ny = -dx / len;
  const [pw, ph] = XP_PARTICLE_FRAMES[1];
  const reach = Math.max(pw / 2 * Math.abs(nx), ph / 2 * Math.abs(ny)); // peak rhombus toward the edge
  const off = reach + XP_PARTICLE_OFFSET;
  return [ax + dx * t + nx * off, ay + dy * t + ny * off];
}

// Random edge point whose peak rhombus (grown by the gap) stays clear of the whole silhouette,
// so dents can't swallow it. Returns { edge, t } or null.
function pickXpParticleSpot(poly) {
  const [pw, ph] = XP_PARTICLE_FRAMES[1];
  const hw = pw / 2 + XP_PARTICLE_OFFSET, hh = ph / 2 + XP_PARTICLE_OFFSET;
  for (let tries = 0; tries < XP_PARTICLE_TRIES; tries++) {
    const edge = Math.floor(Math.random() * poly.length);
    const t = 0.15 + Math.random() * 0.7;
    const [x, y] = xpParticleCenter(poly, edge, t);
    const rh = [[x, y - hh], [x + hw, y], [x, y + hh], [x - hw, y]];
    let clear = true;
    for (let i = 0; i < 4 && clear; i++) {
      const [x1, y1] = rh[i], [x2, y2] = rh[(i + 1) % 4];
      if (segmentVsPolygon(x1, y1, x2, y2, poly)) clear = false;
    }
    if (clear) return { edge, t };
  }
  return null;
}

function isRockOnScreen(rock, camX, camY, pad) {
  const sx = canvas.width / 2 + torusDelta(rock.x, camX, WORLD_W);
  const sy = canvas.height / 2 + torusDelta(rock.y, camY, WORLD_H);
  return sx > -pad && sx < canvas.width + pad && sy > -pad && sy < canvas.height + pad;
}

// Particle state lives on the rock's appearance entry, so it disappears the moment the rock breaks
// or leaves view (both delete the entry). Effect time, so ?fxslow applies.
function updateXpParticles(dt) {
  const fdt = dt / FX_SLOW;
  const life = XP_PARTICLE_FRAME_TIME * XP_PARTICLE_FRAMES.length;
  const pad = XP_PARTICLE_FRAMES[1][1] + XP_PARTICLE_OFFSET;
  for (const rock of serverRocks) {
    if (rock.k !== 'xp') continue;
    const app = rockAppearance.get(rock.id);
    if (!app) continue;
    if (app.xpTimer === undefined) app.xpTimer = Math.random() * XP_PARTICLE_GAP_MAX; // desync rocks
    if (app.xpParticle) {
      app.xpParticle.age += fdt;
      if (app.xpParticle.age < life) continue;
      app.xpParticle = null;
      app.xpTimer = XP_PARTICLE_GAP_MIN + Math.random() * (XP_PARTICLE_GAP_MAX - XP_PARTICLE_GAP_MIN);
    }
    app.xpTimer -= fdt;
    if (app.xpTimer > 0) continue;
    app.xpTimer = XP_PARTICLE_GAP_MIN + Math.random() * (XP_PARTICLE_GAP_MAX - XP_PARTICLE_GAP_MIN);
    if (!rockAccentCache.get(rock.texturePath)) continue; // color still loading
    const shape = rockShape(rock);
    if (!shape || !isRockOnScreen(rock, localPlayer.x, localPlayer.y, shape.boundR + pad)) continue;
    const spot = pickXpParticleSpot(shape.poly);
    if (spot) app.xpParticle = { ...spot, age: 0 };
  }
}

function drawXpParticles(camX, camY) {
  const pad = XP_PARTICLE_FRAMES[1][1] + XP_PARTICLE_OFFSET;
  ctx.save();
  ctx.globalAlpha = XP_PARTICLE_OPACITY;
  for (const rock of serverRocks) {
    if (rock.k !== 'xp') continue;
    const p = rockAppearance.get(rock.id)?.xpParticle;
    if (!p) continue;
    const shape = rockShape(rock);
    if (!shape || !isRockOnScreen(rock, camX, camY, shape.boundR + pad)) continue;
    const size = XP_PARTICLE_FRAMES[Math.floor(p.age / XP_PARTICLE_FRAME_TIME)];
    if (!size) continue;
    const [ox, oy] = xpParticleCenter(shape.poly, p.edge, p.t);
    // Whole screen pixels; frame sizes are even so every vertex lands on a pixel.
    const cx = Math.round(canvas.width / 2 + torusDelta(rock.x, camX, WORLD_W) + ox);
    const cy = Math.round(canvas.height / 2 + torusDelta(rock.y, camY, WORLD_H) + oy);
    const hw = size[0] / 2, hh = size[1] / 2;
    ctx.fillStyle = rockAccentCache.get(rock.texturePath) || XP_PARTICLE_FALLBACK;
    ctx.beginPath();
    ctx.moveTo(cx, cy - hh);
    ctx.lineTo(cx + hw, cy);
    ctx.lineTo(cx, cy + hh);
    ctx.lineTo(cx - hw, cy);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore(); // restores globalAlpha
}

// --- Shatter effect (visual only) ---
// Cuts snapped to 45°, dust = white squares. Motion is smooth and continuous (computed from age, so it is
// frame-rate independent): pieces fly apart with ease-out (exponential drag), spin at a constant rate,
// and scale down while fading out over the whole lifetime.

const SHATTER_DURATION        = 0.6;   // s total piece lifetime (scale + fade run over all of it)
const SHATTER_END_SCALE       = 0.4;   // piece scale at the end of its life (fully faded by then)
const SHATTER_PIECES_MIN      = 3;     // piece count at r <= SHATTER_R_SMALL
const SHATTER_PIECES_MAX      = 6;     // piece count at r >= SHATTER_R_LARGE
const SHATTER_R_SMALL         = 24;
const SHATTER_R_LARGE         = 128;
const SHATTER_ORIGIN_TO_HIT   = 0.3;   // crack origin: fraction of the way from center toward impact
const SHATTER_PUSH_BASE       = 50;    // px/s outward push, plus...
const SHATTER_PUSH_PER_R      = 1.0;   // ...px/s per px of rock radius
const SHATTER_PUSH_NEAR_FRAC  = 0.35;  // push multiplier for pieces facing the impact (1.0 facing away)
const SHATTER_SPIN_MAX        = 2.5;   // rad/s, random ±
const SHATTER_DRAG            = 2.5;   // 1/s exponential velocity decay
const SHATTER_MAX_PIECES      = 150;   // over this, oldest effects end early
const SHATTER_DUST_MIN        = 4;     // dust count at small r
const SHATTER_DUST_MAX        = 8;     // dust count at large r
const SHATTER_DUST_SIZE_MIN   = 4;     // px square at small r
const SHATTER_DUST_SIZE_MAX   = 8;     // px square at large r
const SHATTER_DUST_DURATION   = 0.3;   // s
const SHATTER_DUST_SPEED_MIN  = 60;    // px/s
const SHATTER_DUST_SPEED_MAX  = 170;   // px/s
const SHATTER_DUST_SPREAD     = Math.PI / 3; // ± around the outward direction
const SHATTER_DUST_DRAG       = 4;     // 1/s

// Dev: ?fxslow=N slows effects (not the game) by N for inspection.
const FX_SLOW = (() => {
  const n = parseFloat(new URLSearchParams(location.search).get('fxslow'));
  return n > 0 ? n : 1;
})();

const SHATTER_DEFAULTS = {
  duration: SHATTER_DURATION, endScale: SHATTER_END_SCALE,
  piecesMin: SHATTER_PIECES_MIN, piecesMax: SHATTER_PIECES_MAX,
  rSmall: SHATTER_R_SMALL, rLarge: SHATTER_R_LARGE,
  originToHit: SHATTER_ORIGIN_TO_HIT,
  pushBase: SHATTER_PUSH_BASE, pushPerR: SHATTER_PUSH_PER_R, pushNearFrac: SHATTER_PUSH_NEAR_FRAC,
  spinMax: SHATTER_SPIN_MAX, drag: SHATTER_DRAG,
  dustMin: SHATTER_DUST_MIN, dustMax: SHATTER_DUST_MAX,
  dustSizeMin: SHATTER_DUST_SIZE_MIN, dustSizeMax: SHATTER_DUST_SIZE_MAX,
  dustDuration: SHATTER_DUST_DURATION,
  dustSpeedMin: SHATTER_DUST_SPEED_MIN, dustSpeedMax: SHATTER_DUST_SPEED_MAX,
  dustSpread: SHATTER_DUST_SPREAD, dustDrag: SHATTER_DUST_DRAG,
};

const shatterEffects = []; // oldest first
const ANGLE_STEP = Math.PI / 4;

function lerp(a, b, t) { return a + (b - a) * Math.max(0, Math.min(1, t)); }

// Pick n distinct 45° directions (indices 0..7) with no gap over 180°, so every wedge is convex.
function pickCutDirections(n) {
  for (let tries = 0; tries < 30; tries++) {
    const pool = [0, 1, 2, 3, 4, 5, 6, 7];
    const dirs = [];
    for (let i = 0; i < n; i++) dirs.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    dirs.sort((a, b) => a - b);
    let maxGap = 0;
    for (let i = 0; i < n; i++) maxGap = Math.max(maxGap, (dirs[(i + 1) % n] - dirs[i] + 8) % 8 || 8);
    if (maxGap <= 4) return dirs;
  }
  const off = Math.floor(Math.random() * 8);
  return Array.from({ length: n }, (_, i) => (off + Math.round(i * 8 / n)) % 8).sort((a, b) => a - b);
}

// Distance covered by time t (s) at initial speed 1 under exponential drag k: an ease-out curve.
function dragTravel(t, k) {
  return k > 0 ? (1 - Math.exp(-k * t)) / k : t;
}

// rock: { x, y, r, angle, vx, vy, texturePath }, opts: { hitX, hitY, ...SHATTER_DEFAULTS overrides,
// img/w/h (art other than the rock texture), silhouette(color) → alpha-masked tint canvas for that art }
function spawnShatter(rock, opts = {}) {
  const cfg = { ...SHATTER_DEFAULTS, ...opts };
  const { r } = rock;

  // Skip entirely if the rock is off-screen.
  const dxCam = torusDelta(rock.x, localPlayer.x, WORLD_W);
  const dyCam = torusDelta(rock.y, localPlayer.y, WORLD_H);
  if (Math.abs(dxCam) > canvas.width / 2 + r * 2 || Math.abs(dyCam) > canvas.height / 2 + r * 2) return;

  const sizeT = (r - cfg.rSmall) / (cfg.rLarge - cfg.rSmall);

  // Impact relative to rock center, clamped to the rim (ram impacts are the ship center, outside the rock).
  let ix = torusDelta(cfg.hitX ?? rock.x, rock.x, WORLD_W);
  let iy = torusDelta(cfg.hitY ?? rock.y, rock.y, WORLD_H);
  const iLen = Math.hypot(ix, iy);
  if (iLen > r) { ix *= r / iLen; iy *= r / iLen; }
  const awayX = iLen > 0 ? -ix / Math.hypot(ix, iy) : 0;
  const awayY = iLen > 0 ? -iy / Math.hypot(ix, iy) : 0;

  // opts.img / opts.w / opts.h let other things shatter (e.g. a tinted ship); default: the rock texture.
  const img = opts.img || (rock.texturePath ? loadRockTexture(rock.texturePath) : null);
  const imgW = opts.w ?? r * 2, imgH = opts.h ?? r * 2;
  const pieces = [];

  if (img && (img._loaded || img instanceof HTMLCanvasElement)) {
    const ox = ix * cfg.originToHit, oy = iy * cfg.originToHit;
    const n = Math.round(lerp(cfg.piecesMin, cfg.piecesMax, sizeT));
    const dirs = pickCutDirections(n);
    const far = r * 2.2; // wedges extend past the rim; texture alpha defines the outer shape
    const pushSpeed = cfg.pushBase + cfg.pushPerR * r;
    const sampleStep = Math.max(3, r / 10);
    const bodyR2 = (r * 0.85) ** 2;

    for (let i = 0; i < n; i++) {
      const a1 = dirs[i], a2 = dirs[(i + 1) % n] + (dirs[(i + 1) % n] <= a1 ? 8 : 0);
      const poly = [[ox, oy]];
      for (let k = a1; k <= a2; k++) poly.push([ox + Math.cos(k * ANGLE_STEP) * far, oy + Math.sin(k * ANGLE_STEP) * far]);

      // Centroid of the wedge ∩ rock body (grid-sampled), used as the spin/scale pivot.
      const d1x = Math.cos(a1 * ANGLE_STEP), d1y = Math.sin(a1 * ANGLE_STEP);
      const d2x = Math.cos(a2 * ANGLE_STEP), d2y = Math.sin(a2 * ANGLE_STEP);
      let sx = 0, sy = 0, cnt = 0;
      for (let gx = -r; gx <= r; gx += sampleStep) {
        for (let gy = -r; gy <= r; gy += sampleStep) {
          if (gx * gx + gy * gy > bodyR2) continue;
          const vx = gx - ox, vy = gy - oy;
          if (d1x * vy - d1y * vx < 0 || vx * d2y - vy * d2x < 0) continue;
          sx += gx; sy += gy; cnt++;
        }
      }
      const mid = (a1 + a2) / 2 * ANGLE_STEP;
      const cx = cnt ? sx / cnt : ox + Math.cos(mid) * r * 0.5;
      const cy = cnt ? sy / cnt : oy + Math.sin(mid) * r * 0.5;

      let ux = cx - ox, uy = cy - oy;
      const uLen = Math.hypot(ux, uy) || 1;
      ux /= uLen; uy /= uLen;
      const facingAway = (ux * awayX + uy * awayY + 1) / 2; // 0 = toward impact, 1 = away
      const push = pushSpeed * lerp(cfg.pushNearFrac, 1, iLen > 0 ? facingAway : 1);

      pieces.push({
        x0: rock.x + cx, y0: rock.y + cy,
        vx: (rock.vx || 0) + ux * push, vy: (rock.vy || 0) + uy * push,
        spin: (Math.random() * 2 - 1) * cfg.spinMax,
        poly: poly.map(([px, py]) => [px - cx, py - cy]),
        texOffX: -cx, texOffY: -cy, // rock center relative to piece pivot
      });
    }
  }

  // Dust: white squares popping outward from the impact point.
  const dust = [];
  const dustCount = Math.round(lerp(cfg.dustMin, cfg.dustMax, sizeT));
  const dustSize = Math.round(lerp(cfg.dustSizeMin, cfg.dustSizeMax, sizeT));
  const baseAng = iLen > 0 ? Math.atan2(iy, ix) : Math.random() * Math.PI * 2;
  for (let i = 0; i < dustCount; i++) {
    const ang = baseAng + (Math.random() * 2 - 1) * cfg.dustSpread;
    const spd = cfg.dustSpeedMin + Math.random() * (cfg.dustSpeedMax - cfg.dustSpeedMin);
    dust.push({
      x0: rock.x + ix, y0: rock.y + iy,
      vx: (rock.vx || 0) + Math.cos(ang) * spd, vy: (rock.vy || 0) + Math.sin(ang) * spd,
    });
  }

  // Biome tint at the moment it broke, applied through the art's alpha-masked silhouette only.
  const tint = objectTint();
  const silhouette = !tint ? null
    : opts.silhouette ? opts.silhouette(tint.color)
    : rock.texturePath ? getRockSilhouette(rock.texturePath, tint.color) : null;

  shatterEffects.push({
    age: 0, cfg, img, r, w: imgW, h: imgH, angle: rock.angle || 0, pieces, dust, dustSize,
    tint: silhouette ? { silhouette, alpha: tint.alpha } : null,
  });

  // Cap active pieces: end the oldest effects early.
  let total = 0;
  for (const fx of shatterEffects) total += fx.pieces.length;
  while (total > SHATTER_MAX_PIECES && shatterEffects.length > 1) total -= shatterEffects.shift().pieces.length;
}

// Positions, spin, scale and fade are all functions of age (see drawShatterEffects): only age advances.
function updateShatterEffects(dt) {
  const fdt = dt / FX_SLOW;
  for (let i = shatterEffects.length - 1; i >= 0; i--) {
    const fx = shatterEffects[i];
    fx.age += fdt;
    if (fx.age >= Math.max(fx.cfg.duration, fx.cfg.dustDuration)) shatterEffects.splice(i, 1);
  }
}

function drawShatterEffects(camX, camY) {
  for (const fx of shatterEffects) {
    const { cfg, img, r } = fx;
    const t = Math.min(1, fx.age / cfg.duration);
    const e = t * t; // ease-in: scale/fade start gently and are fully done at the end, no pops
    const scale = 1 - (1 - cfg.endScale) * e;
    const alpha = 1 - e;
    if (alpha > 0 && img && (img._loaded || img instanceof HTMLCanvasElement)) {
      const travel = dragTravel(fx.age, cfg.drag);
      for (const p of fx.pieces) {
        // Sub-pixel positions (no rounding): continuous motion without 1px jumps.
        const sx = canvas.width / 2 + torusDelta(p.x0 + p.vx * travel, camX, WORLD_W);
        const sy = canvas.height / 2 + torusDelta(p.y0 + p.vy * travel, camY, WORLD_H);
        if (sx < -r * 2 || sx > canvas.width + r * 2 || sy < -r * 2 || sy > canvas.height + r * 2) continue;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(sx, sy);
        ctx.rotate(p.spin * fx.age);
        ctx.scale(scale, scale);
        ctx.beginPath();
        ctx.moveTo(p.poly[0][0], p.poly[0][1]);
        for (let k = 1; k < p.poly.length; k++) ctx.lineTo(p.poly[k][0], p.poly[k][1]);
        ctx.closePath();
        ctx.clip();
        ctx.translate(p.texOffX, p.texOffY);
        ctx.rotate(fx.angle);
        ctx.drawImage(img, -fx.w / 2, -fx.h / 2, fx.w, fx.h);
        // Tint: the alpha-masked silhouette, same rect and clip, so only the art's own pixels change.
        if (fx.tint) {
          ctx.globalAlpha = alpha * fx.tint.alpha;
          ctx.drawImage(fx.tint.silhouette, -fx.w / 2, -fx.h / 2, fx.w, fx.h);
        }
        ctx.restore();
      }
    }
    // Dust: white squares flying out with ease-out, shrinking and fading smoothly.
    const dt01 = Math.min(1, fx.age / cfg.dustDuration);
    if (dt01 < 1) {
      const de = dt01 * dt01;
      const size = fx.dustSize * (1 - 0.5 * de);
      const travel = dragTravel(fx.age, cfg.dustDrag);
      ctx.save();
      ctx.globalAlpha = 1 - de;
      ctx.fillStyle = '#ffffff';
      for (const d of fx.dust) {
        const sx = canvas.width / 2 + torusDelta(d.x0 + d.vx * travel, camX, WORLD_W) - size / 2;
        const sy = canvas.height / 2 + torusDelta(d.y0 + d.vy * travel, camY, WORLD_H) - size / 2;
        ctx.fillRect(sx, sy, size, size);
      }
      ctx.restore();
    }
  }
}

// Server says a rock broke: shatter from our local (extrapolated) copy if we have one, so nothing jumps.
function handleBrokenRocks(events) {
  for (const ev of events) {
    const idx = serverRocks.findIndex(r => r.id === ev.id);
    const local = idx >= 0 ? serverRocks[idx] : null;
    const app = local ? rockAppearance.get(local.id) : null;
    const rock = local
      ? { x: local.x, y: local.y, r: local.r, vx: local.vx, vy: local.vy,
          angle: app?.angle ?? local.angle, texturePath: local.texturePath }
      : ev;
    // Impact offset is relative to the server position; re-apply it to the local position.
    const hitX = rock.x + torusDelta(ev.hx, ev.x, WORLD_W);
    const hitY = rock.y + torusDelta(ev.hy, ev.y, WORLD_H);
    if (idx >= 0) serverRocks.splice(idx, 1);
    rockAppearance.delete(ev.id);
    spawnShatter(rock, { hitX, hitY });
  }
}

// --- Feedback effects (visual only): hit flash, impact sparks, muzzle flash, pickup pop, level-up ---
// One list for all of these, on the shatter's effect clock (?fxslow applies), capped and culled.
// Style: white or the player's color, 8px-based sizes, stepped animation.

const FX_MAX_ACTIVE          = 400;   // cap on active entries; oldest end early
const FX_CULL_PAD            = 64;    // px beyond the screen edge before an effect is skipped
const FX_SHRINK_STEPS        = 4;     // stepped shrink: 1 → 0.75 → 0.5 → 0.25 → gone

const HIT_FLASH_TIME         = 0.05;  // s (~2 frames at 60 fps)
const HIT_FLASH_ALPHA        = 0.75;

const SPARK_COUNT_MIN        = 3;
const SPARK_COUNT_MAX        = 5;
const SPARK_SIZE_MIN         = 4;     // px
const SPARK_SIZE_MAX         = 8;
const SPARK_SNIPER_COUNT     = 1.6;   // sniper hits: more sparks...
const SPARK_SNIPER_SIZE      = 1.5;   // ...and bigger
const SPARK_TIME             = 0.25;  // s
const SPARK_SPEED_MIN        = 80;    // px/s
const SPARK_SPEED_MAX        = 220;
const SPARK_SPREAD           = Math.PI / 3; // ± around the reflected direction
const SPARK_DRAG             = 6;     // 1/s

// Muzzle flash, drawn in the gun's rotated frame: [width across the barrel, length forward] per frame.
const MUZZLE_FLASH_FRAMES    = [[8, 8], [8, 16], [4, 8]];
const MUZZLE_FLASH_TIME      = 0.08;  // s
const MUZZLE_SNIPER_MULT     = 1.5;   // sniper gun: bigger and longer
const MUZZLE_MAX_DIST        = 150;   // a "new" bullet farther than this from its owner just entered view: no flash

// Rock hits (instead of flash + sparks): knock-and-snap offset and chips cut from the rock texture.
const KNOCK_MAX_PX           = 6;     // jolt at the smallest rocks...
const KNOCK_REF_R            = 24;    // ...(r = 24); bigger rocks: × sqrt(KNOCK_REF_R / r)
const KNOCK_ROT_DEG          = 2;     // rotation twitch
const KNOCK_SNIPER_MULT      = 1.5;
const KNOCK_STEP_TIME        = 0.05;  // full offset, then half, then back (2 hard steps ≈ 0.1s)

const CHIP_COUNT_MIN         = 2;
const CHIP_COUNT_MAX         = 4;
const CHIP_SNIPER_EXTRA_MIN  = 1;     // sniper hits: 1–2 more chips...
const CHIP_SNIPER_EXTRA_MAX  = 2;
const CHIP_SNIPER_SIZE       = 1.25;  // ...slightly bigger
const CHIP_SIZES             = [8, 12, 16]; // px, from 8px blocks
const CHIP_TIME              = 0.3;   // s
const CHIP_SPEED_MIN         = 60;    // px/s
const CHIP_SPEED_MAX         = 160;
const CHIP_SPREAD            = Math.PI / 3; // ± around the reflected direction
const CHIP_SPIN_MAX          = 6;     // rad/s
const CHIP_DRAG              = 4;     // 1/s
const CHIP_INSET             = 0.6;   // chip center moved this × chip size inside the rim, so it holds rock

// Engine trail: one smooth tapered ribbon per engine, following the engine's recent path.
const TRAIL_HISTORY          = 0.7;   // s of path kept while thrusting
const TRAIL_WIDTH            = 8;     // px at the engine, tapering to 0 at the tail
const TRAIL_ALPHA            = 0.6;   // opacity at the engine, fading to 0 at the tail
const TRAIL_FADE_TIME        = 0.3;   // s a detached trail (thrust stopped) takes to shorten and fade out
const TRAIL_MIN_STEP         = 2;     // px: closer samples just move the head point
const TRAIL_MAX_JUMP         = 150;   // px between frames: bigger (respawn/teleport) starts a new ribbon
const TRAIL_BACK_OFFSET      = 4;     // px behind the engine point

// Ship death: the player-colored ship shatters like a rock, with a few more pieces (biome tint via the
// ship's silhouette).
const SHIP_SHATTER_EXTRA_PIECES = 2;

// Respawn: scale RESPAWN_SCALE_FROM → 1 and fade in (ease-out), with a white silhouette fading out first.
const RESPAWN_FX_TIME        = 0.4;   // s
const RESPAWN_SCALE_FROM     = 0.4;
const RESPAWN_WHITE_FADE     = 0.2;   // s for the white silhouette to fade from full to nothing

const PICKUP_POP_TIME        = 0.15;  // s to fly into the ship
const PICKUP_POP_STEPS       = 4;
const XP_BAR_PULSE_TIME      = 0.2;   // s
const XP_BAR_PULSE_SCALES    = [1.1, 1.2, 1.1]; // stepped scale up and back

const LEVEL_RING_TIME        = 0.4;   // s
const LEVEL_RING_STEPS       = 5;
const LEVEL_RING_MAX_MULT    = 3;     // grows to 3× the ship radius
const LEVEL_RING_WIDTH       = 8;     // px
const LEVEL_TEXT_TIME        = 0.8;   // s
const LEVEL_TEXT_RISE        = 16;    // px risen over its life, in steps
const LEVEL_TEXT_STEPS       = 4;
const LEVEL_TEXT_FONT_PX     = 20;
const LEVEL_TEXT_ABOVE       = 36;    // px above the ship's top (clears the name + HP bar)

const fxList = [];                    // { kind, age, life, ... }
const rockKnocks = new Map();         // rock id → { dx, dy, rot, age } visual jolt
const hitFlashPlayers = new Map();    // player id → s remaining
const lastLevels = new Map();         // player id → last seen level
const lastDeadState = new Map();      // player id → last seen dead flag
const respawnFx = new Map();          // player id → s since respawn
const trailRibbons = new Map();       // `${playerId}:${engine}` → active ribbon { points: [{x, y, t}], color }
const detachedTrails = [];            // ribbons whose thrust stopped: { points, color, fadeAge }
let fxClock = 0;                      // effect time (s, ?fxslow applies), for trail point ages
let xpBarPulseAge = Infinity;

function pushFx(e) {
  fxList.push({ age: 0, ...e });
  if (fxList.length > FX_MAX_ACTIVE) fxList.splice(0, fxList.length - FX_MAX_ACTIVE);
}

function fxScreen(x, y) {
  return [canvas.width / 2 + torusDelta(x, localPlayer.x, WORLD_W), canvas.height / 2 + torusDelta(y, localPlayer.y, WORLD_H)];
}

function fxOnScreen(x, y, pad = FX_CULL_PAD) {
  const [sx, sy] = fxScreen(x, y);
  return sx > -pad && sx < canvas.width + pad && sy > -pad && sy < canvas.height + pad;
}

// Current position/heading of a player for effects that follow them (null if gone or dead).
function fxPlayer(id) {
  if (id === myId) {
    if (localPlayer.dead) return null;
    return { x: localPlayer.x, y: localPlayer.y, angle: localPlayer.angle, shipType: localPlayer.shipType, color: localPlayer.color };
  }
  const p = remotePlayers.get(id);
  if (!p || p.dead) return null;
  return { x: p.renderX ?? p.x, y: p.renderY ?? p.y, angle: p.angle, shipType: p.shipType, color: p.color };
}

// Stepped shrink factor for age/life: 1, 0.75, 0.5, 0.25 (steps = FX_SHRINK_STEPS).
function fxShrink(age, life, steps = FX_SHRINK_STEPS) {
  return 1 - Math.floor(Math.min(0.999, age / life) * steps) / steps;
}

// Server hit events. Rocks: knock-and-snap + chips of their own texture. Ships: silhouette flash + sparks.
function handleHitEvents(events) {
  for (const ev of events) {
    if (DEBUG_HIT) debugHits.push({ x: ev.x, y: ev.y, t: performance.now() });
    if (ev.targetType === 'rock') {
      knockRock(ev);
      if (fxOnScreen(ev.x, ev.y)) spawnRockChips(ev);
      continue;
    }
    hitFlashPlayers.set(ev.targetId, HIT_FLASH_TIME);
    if (!fxOnScreen(ev.x, ev.y)) continue;
    const sniper = ev.b === 'sniper';
    const count = Math.round((SPARK_COUNT_MIN + Math.random() * (SPARK_COUNT_MAX - SPARK_COUNT_MIN)) * (sniper ? SPARK_SNIPER_COUNT : 1));
    const base = Math.atan2(-ev.dirY, -ev.dirX); // back out of the surface, against the bullet
    for (let i = 0; i < count; i++) {
      const a = base + (Math.random() * 2 - 1) * SPARK_SPREAD;
      const spd = SPARK_SPEED_MIN + Math.random() * (SPARK_SPEED_MAX - SPARK_SPEED_MIN);
      const size = Math.round((SPARK_SIZE_MIN + Math.random() * (SPARK_SIZE_MAX - SPARK_SIZE_MIN)) * (sniper ? SPARK_SNIPER_SIZE : 1));
      pushFx({ kind: 'spark', layer: 'world', life: SPARK_TIME, x: ev.x, y: ev.y, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd, size });
    }
  }
}

// Jolt a rock's drawn position along the bullet direction with a small twitch. Hits don't stack
// beyond the rock's max jolt. Visual only: rock.x/y, physics and prediction are untouched.
function knockRock(ev) {
  const rock = serverRocks.find(r => r.id === ev.targetId);
  if (!rock) return;
  const sizeMult = Math.sqrt(KNOCK_REF_R / Math.max(KNOCK_REF_R, rock.r));
  const hitMult = ev.b === 'sniper' ? KNOCK_SNIPER_MULT : 1;
  const jolt = KNOCK_MAX_PX * sizeMult * hitMult;
  const maxJolt = KNOCK_MAX_PX * sizeMult * KNOCK_SNIPER_MULT;
  const maxRot = KNOCK_ROT_DEG * KNOCK_SNIPER_MULT * Math.PI / 180;
  const cur = rockKnockOffset(rock.id) || { dx: 0, dy: 0, rot: 0 };
  let dx = cur.dx + ev.dirX * jolt, dy = cur.dy + ev.dirY * jolt;
  const len = Math.hypot(dx, dy);
  if (len > maxJolt) { dx *= maxJolt / len; dy *= maxJolt / len; }
  const twitch = (Math.random() < 0.5 ? -1 : 1) * KNOCK_ROT_DEG * hitMult * Math.PI / 180;
  const rot = Math.max(-maxRot, Math.min(maxRot, cur.rot + twitch));
  rockKnocks.set(rock.id, { dx, dy, rot, age: 0 });
}

// Current knock offset: full for one step, half for the next, then gone (hard steps).
function rockKnockOffset(id) {
  const k = rockKnocks.get(id);
  if (!k) return null;
  const f = k.age < KNOCK_STEP_TIME ? 1 : k.age < KNOCK_STEP_TIME * 2 ? 0.5 : 0;
  return f ? { dx: k.dx * f, dy: k.dy * f, rot: k.rot * f } : null;
}

// Small angular clip shapes (triangle, square, diamond) of half-size h, turned by a 45° multiple.
function chipPolygon(h) {
  const shapes = [
    [[0, -h], [h, h], [-h, h]],
    [[-h, -h], [h, -h], [h, h], [-h, h]],
    [[0, -h], [h, 0], [0, h], [-h, 0]],
  ];
  const poly = shapes[Math.floor(Math.random() * shapes.length)];
  const a = Math.floor(Math.random() * 8) * Math.PI / 4, c = Math.cos(a), sn = Math.sin(a);
  return poly.map(([x, y]) => [x * c - y * sn, x * sn + y * c]);
}

// Chips cut from the rock's own texture around the hit point (same clipping as the shatter pieces),
// flying back out of the surface with a little spin, shrinking in steps.
function spawnRockChips(ev) {
  const rock = serverRocks.find(r => r.id === ev.targetId);
  if (!rock) return;
  const img = rock.texturePath ? loadRockTexture(rock.texturePath) : null;
  if (!img || !img._loaded) return;
  const sniper = ev.b === 'sniper';
  const app = rockAppearance.get(rock.id);
  const rockAngle = app?.angle ?? 0;
  const t0 = objectTint();
  const silhouette = t0 && rock.texturePath ? getRockSilhouette(rock.texturePath, t0.color) : null;
  const tint = silhouette ? { silhouette, alpha: t0.alpha } : null;
  // Hit point relative to the rock center (unrotated world axes), and the inward direction.
  const hx = torusDelta(ev.x, rock.x, WORLD_W), hy = torusDelta(ev.y, rock.y, WORLD_H);
  const hl = Math.hypot(hx, hy) || 1;
  const inX = -hx / hl, inY = -hy / hl;
  let count = CHIP_COUNT_MIN + Math.floor(Math.random() * (CHIP_COUNT_MAX - CHIP_COUNT_MIN + 1));
  if (sniper) count += CHIP_SNIPER_EXTRA_MIN + Math.floor(Math.random() * (CHIP_SNIPER_EXTRA_MAX - CHIP_SNIPER_EXTRA_MIN + 1));
  const base = Math.atan2(-ev.dirY, -ev.dirX);
  for (let i = 0; i < count; i++) {
    const size = CHIP_SIZES[Math.floor(Math.random() * CHIP_SIZES.length)] * (sniper ? CHIP_SNIPER_SIZE : 1);
    // Sample spot: just inside the rim at the hit, jittered along the edge so chips differ.
    const along = (Math.random() * 2 - 1) * size * 0.5;
    const cx = hx + inX * size * CHIP_INSET - inY * along;
    const cy = hy + inY * size * CHIP_INSET + inX * along;
    const a = base + (Math.random() * 2 - 1) * CHIP_SPREAD;
    const spd = CHIP_SPEED_MIN + Math.random() * (CHIP_SPEED_MAX - CHIP_SPEED_MIN);
    pushFx({
      kind: 'chip', layer: 'world', life: CHIP_TIME,
      x: rock.x + cx, y: rock.y + cy,
      vx: (rock.vx || 0) + Math.cos(a) * spd, vy: (rock.vy || 0) + Math.sin(a) * spd,
      rot: 0, spin: (Math.random() * 2 - 1) * CHIP_SPIN_MAX,
      poly: chipPolygon(size / 2),
      texOffX: -cx, texOffY: -cy, // rock center relative to the chip center
      img, r: rock.r, rockAngle, tint,
    });
  }
}

// First sighting of a bullet: flash at the muzzle it came from, following the owner's ship.
function spawnMuzzleFlash(b) {
  if (b.g == null) return;
  const owner = fxPlayer(b.ownerId);
  if (!owner || !fxOnScreen(owner.x, owner.y)) return;
  if (Math.hypot(torusDelta(b.x, owner.x, WORLD_W), torusDelta(b.y, owner.y, WORLD_H)) > MUZZLE_MAX_DIST) return;
  const gun = shipType(owner.shipType).guns?.[b.g];
  if (!gun) return;
  const big = gun.bullet === 'sniper';
  pushFx({ kind: 'muzzle', layer: 'top', life: MUZZLE_FLASH_TIME * (big ? MUZZLE_SNIPER_MULT : 1),
    ownerId: b.ownerId, shipType: owner.shipType, gun: b.g, mult: big ? MUZZLE_SNIPER_MULT : 1 });
}

// Server pickup events: the coin/XP flies into the collecting ship while shrinking in steps.
function handlePickupEvents(events) {
  for (const ev of events) {
    const list = ev.kind === 'gold' ? serverGems : serverXpDrops;
    const idx = list.findIndex(o => o.id === ev.pickupId);
    const item = idx >= 0 ? list[idx] : null;
    if (idx >= 0) list.splice(idx, 1);
    if (ev.kind === 'xp' && ev.playerId === myId) xpBarPulseAge = 0;
    const x = item?.x ?? ev.x, y = item?.y ?? ev.y;
    if (!fxOnScreen(x, y)) continue;
    let img, size;
    if (ev.kind === 'gold') {
      const type = item?.coinType || 'small';
      img = coinImgs[type]; size = COIN_SIZES[type] ?? 12;
    } else {
      const type = item?.xpType || 'small';
      img = xpImgs[type][(item?.xpVariant || 1) - 1]; size = XP_SIZES[type] ?? 16;
    }
    pushFx({ kind: 'pickup', layer: 'world', life: PICKUP_POP_TIME, x, y, playerId: ev.playerId, img, size });
  }
}

// Engine trails: while a ship thrusts, each engine's world position is recorded every frame into
// its ribbon; when thrust stops (or the ship dies/leaves) the ribbon detaches and fades out.
// Points are stored unwrapped (each relative to the previous via torusDelta), so a ribbon stays
// continuous across the world seam instead of streaking across the map.
function updateEngineTrails(fdt) {
  fxClock += fdt;
  const seen = new Set();
  const detach = (key, rb) => {
    trailRibbons.delete(key);
    if (rb.points.length >= 2) detachedTrails.push({ points: rb.points, color: rb.color, fadeAge: 0 });
  };
  const record = (id, x, y, angle, shipId, color, thrusting) => {
    if (!thrusting) return;
    const engines = shipType(shipId).engines || [];
    const back = angle + Math.PI;
    for (let i = 0; i < engines.length; i++) {
      const key = `${id}:${i}`;
      const e = enginePoint(shipTypes, shipId, i, x, y, angle);
      const px = e.x + Math.cos(back) * TRAIL_BACK_OFFSET, py = e.y + Math.sin(back) * TRAIL_BACK_OFFSET;
      seen.add(key);
      let rb = trailRibbons.get(key);
      const last = rb && rb.points[rb.points.length - 1];
      const dx = last ? torusDelta(px, last.x, WORLD_W) : 0, dy = last ? torusDelta(py, last.y, WORLD_H) : 0;
      if (rb && Math.hypot(dx, dy) > TRAIL_MAX_JUMP) { detach(key, rb); rb = null; }
      if (!rb) { rb = { points: [], color }; trailRibbons.set(key, rb); }
      rb.color = color;
      const prev = rb.points[rb.points.length - 1];
      if (prev && Math.hypot(dx, dy) < TRAIL_MIN_STEP) { prev.x += dx; prev.y += dy; continue; } // head follows the engine
      rb.points.push(prev ? { x: prev.x + dx, y: prev.y + dy, t: fxClock } : { x: px, y: py, t: fxClock });
    }
  };
  if (myId !== null && !localPlayer.dead) {
    record(myId, localPlayer.x, localPlayer.y, localPlayer.angle, localPlayer.shipType, localPlayer.color || '#ffffff', currentThrust > 0);
  }
  for (const [, p] of remotePlayers) {
    if (!p.dead) record(p.id, p.renderX ?? p.x, p.renderY ?? p.y, p.angle, p.shipType, p.color || '#ffffff', !!p.th);
  }
  for (const [key, rb] of trailRibbons) {
    if (!seen.has(key)) { detach(key, rb); continue; }
    while (rb.points.length > 2 && fxClock - rb.points[0].t > TRAIL_HISTORY) rb.points.shift();
  }
  // Detached: the kept window shrinks to nothing over TRAIL_FADE_TIME (shortens from the tail) while fading.
  for (let i = detachedTrails.length - 1; i >= 0; i--) {
    const d = detachedTrails[i];
    d.fadeAge += fdt;
    const windowS = TRAIL_HISTORY * (1 - d.fadeAge / TRAIL_FADE_TIME);
    while (d.points.length && fxClock - d.points[0].t > windowS) d.points.shift();
    if (d.fadeAge >= TRAIL_FADE_TIME || d.points.length < 2) detachedTrails.splice(i, 1);
  }
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// One ribbon as a single filled shape: edges smoothed with quadratic curves through the points,
// width tapering from TRAIL_WIDTH at the head to 0 at the tail, opacity fading along its length.
function drawTrailRibbon(points, color, fade, camX, camY) {
  const n = points.length;
  if (n < 2 || fade <= 0) return;
  const head = points[n - 1];
  const hx = canvas.width / 2 + torusDelta(head.x, camX, WORLD_W), hy = canvas.height / 2 + torusDelta(head.y, camY, WORLD_H);
  const pts = points.map(p => [hx + (p.x - head.x), hy + (p.y - head.y)]); // unwrapped → continuous on screen
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  if (maxX < -TRAIL_WIDTH || minX > canvas.width + TRAIL_WIDTH || maxY < -TRAIL_WIDTH || minY > canvas.height + TRAIL_WIDTH) return;

  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[n - 1];
  if (total < 1) return;
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl; ty /= tl;
    const hw = TRAIL_WIDTH / 2 * (cum[i] / total);
    left.push([pts[i][0] - ty * hw, pts[i][1] + tx * hw]);
    right.push([pts[i][0] + ty * hw, pts[i][1] - tx * hw]);
  }
  const smooth = (edge) => { // quadratic curves through midpoints: no corners or seams
    for (let i = 1; i < edge.length - 1; i++) {
      ctx.quadraticCurveTo(edge[i][0], edge[i][1], (edge[i][0] + edge[i + 1][0]) / 2, (edge[i][1] + edge[i + 1][1]) / 2);
    }
    ctx.lineTo(edge[edge.length - 1][0], edge[edge.length - 1][1]);
  };
  const [r, g, b] = hexToRgb(color);
  const grad = ctx.createLinearGradient(pts[0][0], pts[0][1], pts[n - 1][0], pts[n - 1][1]);
  grad.addColorStop(0, `rgba(${r},${g},${b},0)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},${(TRAIL_ALPHA * fade).toFixed(3)})`);
  ctx.beginPath();
  ctx.moveTo(left[0][0], left[0][1]);
  smooth(left);
  const rev = right.slice().reverse();
  ctx.lineTo(rev[0][0], rev[0][1]);
  smooth(rev);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
}

function drawEngineTrails(camX, camY) {
  ctx.save();
  for (const [, rb] of trailRibbons) drawTrailRibbon(rb.points, rb.color, 1, camX, camY);
  for (const d of detachedTrails) drawTrailRibbon(d.points, d.color, 1 - d.fadeAge / TRAIL_FADE_TIME, camX, camY);
  ctx.restore();
}

// The ship's texture tinted with a color (same technique as drawShip), on its own canvas.
function tintedShipCanvas(shipId, color) {
  const img = texImg(shipType(shipId).texture);
  if (!img._loaded) return null;
  const w = Math.max(1, Math.round(img.naturalWidth * shipTextureScale));
  const h = Math.max(1, Math.round(img.naturalHeight * shipTextureScale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, w, h);
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = color;
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(img, 0, 0, w, h);
  return { canvas: c, w, h };
}

// Server says a ship died: shatter its tinted image from our local copy (no jump), like a rock.
function handlePlayerDiedEvents(events) {
  for (const ev of events) {
    let x = ev.x, y = ev.y, angle = ev.angle;
    if (ev.id === myId) { x = localPlayer.x; y = localPlayer.y; angle = localPlayer.angle; }
    else {
      const rp = remotePlayers.get(ev.id);
      if (rp) { x = rp.renderX ?? rp.x; y = rp.renderY ?? rp.y; angle = rp.angle ?? angle; }
    }
    const art = tintedShipCanvas(ev.shipType, ev.color || '#ffffff');
    if (!art) continue;
    spawnShatter(
      { x, y, r: shipType(ev.shipType).r, vx: ev.vx, vy: ev.vy, angle: angle + Math.PI / 2 }, // texture up = nose
      { hitX: x + torusDelta(ev.hx, ev.x, WORLD_W), hitY: y + torusDelta(ev.hy, ev.y, WORLD_H),
        img: art.canvas, w: art.w, h: art.h, silhouette: color => getShipSilhouette(ev.shipType, color),
        piecesMin: SHATTER_PIECES_MIN + SHIP_SHATTER_EXTRA_PIECES, piecesMax: SHATTER_PIECES_MAX + SHIP_SHATTER_EXTRA_PIECES });
  }
}

// Dead → alive since the last tick? Starts the respawn appear effect; returns true on that tick.
function trackRespawn(p) {
  const prev = lastDeadState.get(p.id);
  lastDeadState.set(p.id, !!p.dead);
  if (prev === true && !p.dead) { respawnFx.set(p.id, 0); return true; }
  return false;
}

// Respawn draw state: ease-out scale and fade-in, plus a white silhouette fading out over its first part.
function respawnDrawState(id) {
  const age = respawnFx.get(id);
  if (age === undefined) return { scale: 1, white: 0, alpha: 1 };
  const e = easeOutCubic(age / RESPAWN_FX_TIME);
  return {
    scale: RESPAWN_SCALE_FROM + (1 - RESPAWN_SCALE_FROM) * e,
    alpha: e,
    white: Math.max(0, 1 - age / RESPAWN_WHITE_FADE),
  };
}

// Level-up burst for any visible player whose level went up since the last tick.
function trackLevelUp(p) {
  const prev = lastLevels.get(p.id);
  lastLevels.set(p.id, p.level);
  if (prev === undefined || !(p.level > prev) || p.dead) return;
  const pos = p.id === myId ? localPlayer : { x: p.x, y: p.y };
  if (!fxOnScreen(pos.x, pos.y, FX_CULL_PAD + 100)) return;
  pushFx({ kind: 'ring', layer: 'world', life: LEVEL_RING_TIME, playerId: p.id });
  pushFx({ kind: 'levelText', layer: 'top', life: LEVEL_TEXT_TIME, playerId: p.id, text: `level ${p.level}` });
}

function xpBarPulseScale() {
  if (xpBarPulseAge >= XP_BAR_PULSE_TIME) return 1;
  return XP_BAR_PULSE_SCALES[Math.min(XP_BAR_PULSE_SCALES.length - 1, Math.floor(xpBarPulseAge / XP_BAR_PULSE_TIME * XP_BAR_PULSE_SCALES.length))];
}

function updateFx(dt) {
  const fdt = dt / FX_SLOW;
  for (const [id, t] of hitFlashPlayers) { if (t - fdt <= 0) hitFlashPlayers.delete(id); else hitFlashPlayers.set(id, t - fdt); }
  for (const [id, k] of rockKnocks) { k.age += fdt; if (k.age >= KNOCK_STEP_TIME * 2) rockKnocks.delete(id); }
  for (const [id, a] of respawnFx) { if (a + fdt >= RESPAWN_FX_TIME) respawnFx.delete(id); else respawnFx.set(id, a + fdt); }
  updateEngineTrails(fdt);
  xpBarPulseAge += fdt;
  for (let i = fxList.length - 1; i >= 0; i--) {
    const e = fxList[i];
    e.age += fdt;
    if (e.age >= e.life) { fxList.splice(i, 1); continue; }
    if (e.kind === 'spark' || e.kind === 'chip') {
      e.x += e.vx * fdt; e.y += e.vy * fdt;
      const d = Math.exp(-(e.kind === 'chip' ? CHIP_DRAG : SPARK_DRAG) * fdt);
      e.vx *= d; e.vy *= d;
      if (e.kind === 'chip') e.rot += e.spin * fdt;
    }
  }
}

function drawFx(camX, camY, layer) {
  const toScreen = (x, y) => [canvas.width / 2 + torusDelta(x, camX, WORLD_W), canvas.height / 2 + torusDelta(y, camY, WORLD_H)];
  const visible = (sx, sy, pad = FX_CULL_PAD) => sx > -pad && sx < canvas.width + pad && sy > -pad && sy < canvas.height + pad;
  ctx.save();
  for (const e of fxList) {
    if (e.layer !== layer) continue;
    const t = e.age / e.life;

    if (e.kind === 'spark') {
      const [sx, sy] = toScreen(e.x, e.y);
      if (!visible(sx, sy)) continue;
      const size = Math.max(1, Math.round(e.size * fxShrink(e.age, e.life)));
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.round(sx - size / 2), Math.round(sy - size / 2), size, size);

    } else if (e.kind === 'muzzle') {
      // Attached to the gun: same shared placement as the server's bullet spawn, every frame.
      const o = fxPlayer(e.ownerId);
      if (!o || o.shipType !== e.shipType) continue;
      const m = gunMuzzle(shipTypes, o.shipType, e.gun, o.x, o.y, o.angle);
      if (!m) continue;
      const [sx, sy] = toScreen(m.x, m.y);
      if (!visible(sx, sy)) continue;
      const [fw, fl] = MUZZLE_FLASH_FRAMES[Math.min(MUZZLE_FLASH_FRAMES.length - 1, Math.floor(t * MUZZLE_FLASH_FRAMES.length))];
      const w = Math.round(fw * e.mult), len = Math.round(fl * e.mult);
      // Snap only the center, then draw in the gun's frame (texture-up = forward), so the shape is
      // identical at every ship angle: a short flame from the muzzle out along the firing direction.
      ctx.save();
      ctx.translate(Math.round(sx), Math.round(sy));
      ctx.rotate(m.angle + Math.PI / 2);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-w / 2, -len, w, len);
      ctx.restore();

    } else if (e.kind === 'chip') {
      const [sx, sy] = toScreen(e.x, e.y);
      if (!visible(sx, sy)) continue;
      const shrink = fxShrink(e.age, e.life);
      ctx.save();
      ctx.translate(Math.round(sx), Math.round(sy));
      ctx.rotate(e.rot);
      ctx.scale(shrink, shrink);
      ctx.beginPath();
      ctx.moveTo(e.poly[0][0], e.poly[0][1]);
      for (let k = 1; k < e.poly.length; k++) ctx.lineTo(e.poly[k][0], e.poly[k][1]);
      ctx.closePath();
      ctx.clip();
      ctx.translate(e.texOffX, e.texOffY);
      ctx.rotate(e.rockAngle);
      ctx.drawImage(e.img, -e.r, -e.r, e.r * 2, e.r * 2);

      if (e.tint) { // alpha-masked silhouette, same rect and clip: only the rock's own pixels
        ctx.globalAlpha = e.tint.alpha;
        ctx.drawImage(e.tint.silhouette, -e.r, -e.r, e.r * 2, e.r * 2);
      }

      ctx.restore();

    } else if (e.kind === 'pickup') {
      const o = fxPlayer(e.playerId);
      const ease = 1 - Math.pow(1 - t, 3);
      const tx = o ? e.x + torusDelta(o.x, e.x, WORLD_W) * ease : e.x;
      const ty = o ? e.y + torusDelta(o.y, e.y, WORLD_H) * ease : e.y;
      const [sx, sy] = toScreen(tx, ty);
      if (!visible(sx, sy)) continue;
      const size = Math.max(1, Math.round(e.size * fxShrink(e.age, e.life, PICKUP_POP_STEPS)));
      if (e.img && e.img._loaded) ctx.drawImage(e.img, Math.round(sx - size / 2), Math.round(sy - size / 2), size, size);

    } else if (e.kind === 'ring') {
      const o = fxPlayer(e.playerId);
      if (!o) continue;
      const [sx, sy] = toScreen(o.x, o.y);
      const r0 = shipType(o.shipType).r, r1 = r0 * LEVEL_RING_MAX_MULT;
      if (!visible(sx, sy, r1 + FX_CULL_PAD)) continue;
      const k = Math.min(LEVEL_RING_STEPS - 1, Math.floor(t * LEVEL_RING_STEPS));
      const r = r0 + (r1 - r0) * (k + 1) / LEVEL_RING_STEPS;
      ctx.strokeStyle = o.color || '#ffffff';
      ctx.lineWidth = LEVEL_RING_WIDTH;
      ctx.beginPath();
      ctx.arc(Math.round(sx), Math.round(sy), Math.round(r), 0, Math.PI * 2);
      ctx.stroke();

    } else if (e.kind === 'levelText') {
      const o = fxPlayer(e.playerId);
      if (!o) continue;
      const [sx, sy] = toScreen(o.x, o.y);
      if (!visible(sx, sy, 200)) continue;
      const rise = LEVEL_TEXT_RISE * Math.floor(t * LEVEL_TEXT_STEPS) / LEVEL_TEXT_STEPS;
      ctx.fillStyle = o.color || '#ffffff';
      ctx.font = `${LEVEL_TEXT_FONT_PX}px Ticketing`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(e.text, Math.round(sx), Math.round(sy - shipType(o.shipType).r - LEVEL_TEXT_ABOVE - rise));
    }
  }
  ctx.restore();
}

function drawGems(camX, camY) {
  for (const g of serverGems) {
    const dx = torusDelta(g.x, camX, WORLD_W);
    const dy = torusDelta(g.y, camY, WORLD_H);
    const sx = canvas.width  / 2 + dx;
    const sy = canvas.height / 2 + dy;

    const margin = 20;
    if (sx < -margin || sx > canvas.width + margin || sy < -margin || sy > canvas.height + margin) continue;

    const coinType = g.coinType || 'small';
    const size = COIN_SIZES[coinType] ?? 12;
    const half = size / 2;
    const img = coinImgs[coinType];
    if (img && img._loaded) {
      ctx.drawImage(img, sx - half, sy - half, size, size);
    } else {
      ctx.beginPath();
      ctx.arc(sx, sy, half, 0, Math.PI * 2);
      ctx.fillStyle = '#facc15';
      ctx.fill();
    }
  }
}

function drawXpDrops(camX, camY) {
  for (const x of serverXpDrops) {
    const dx = torusDelta(x.x, camX, WORLD_W);
    const dy = torusDelta(x.y, camY, WORLD_H);
    const sx = canvas.width  / 2 + dx;
    const sy = canvas.height / 2 + dy;

    const margin = 20;
    if (sx < -margin || sx > canvas.width + margin || sy < -margin || sy > canvas.height + margin) continue;

    const type = x.xpType || 'small';
    const variant = ((x.xpVariant || 1) - 1);
    const img = xpImgs[type][variant];
    const size = XP_SIZES[type] ?? 16;
    const half = size / 2;
    if (img._loaded) {
      ctx.drawImage(img, sx - half, sy - half, size, size);
    } else {
      ctx.beginPath();
      ctx.arc(sx, sy, 2, 0, Math.PI * 2);
      ctx.fillStyle = '#4ade80';
      ctx.fill();
    }
  }
}

// Bullet texture by type (`t`), drawn at the ship texture scale.
function getBulletAsset(type) {
  const bt = bulletTypes[type] || bulletTypes.basic;
  const img = texImg(bt.texture);
  return { img, ready: img._loaded, bw: img.naturalWidth * shipTextureScale, bh: img.naturalHeight * shipTextureScale };
}

// Bullet art in a player color, same technique as tintedShipCanvas, cached per texture/color/size.
const tintedBulletCache = new Map(); // `${texture}|${color}|${w}x${h}` → canvas
function tintedBulletCanvas(img, texture, color, w, h) {
  const key = `${texture}|${color}|${w}x${h}`;
  let c = tintedBulletCache.get(key);
  if (c) return c;
  if (tintedBulletCache.size > 64) tintedBulletCache.clear(); // colors come and go with players
  c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, w, h);
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = color;
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(img, 0, 0, w, h);
  tintedBulletCache.set(key, c);
  return c;
}

function drawBullets(camX, camY) {
  for (const b of serverBullets) {
    const dx = torusDelta(b.x, camX, WORLD_W);
    const dy = torusDelta(b.y, camY, WORLD_H);
    const sx = canvas.width  / 2 + dx;
    const sy = canvas.height / 2 + dy;

    const { img, ready, bw, bh } = getBulletAsset(b.t);
    if (ready) {
      const color = b.ownerId === myId
        ? localPlayer.color
        : (remotePlayers.get(b.ownerId)?.color ?? '#ffffff');
      const art = tintedBulletCanvas(img, (bulletTypes[b.t] || bulletTypes.basic).texture, color,
        Math.max(1, Math.ceil(bw)), Math.max(1, Math.ceil(bh)));
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate((b.angle ?? 0) + Math.PI / 2);
      ctx.drawImage(art, -bw / 2, -bh / 2, bw, bh);
      ctx.restore();
    } else {
      ctx.save();
      ctx.beginPath();
      ctx.arc(sx, sy, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#fde047';
      ctx.fill();
      ctx.restore();
    }
  }
}

// Debug overlay (?debughit=1): rock polygon (red), hull (yellow), ship circles (cyan), hit points.
function drawHitDebug(camX, camY) {
  const toScreen = (x, y) => [canvas.width / 2 + torusDelta(x, camX, WORLD_W), canvas.height / 2 + torusDelta(y, camY, WORLD_H)];
  const strokePoly = (poly, ox, oy) => {
    ctx.beginPath();
    ctx.moveTo(ox + poly[0][0], oy + poly[0][1]);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(ox + poly[i][0], oy + poly[i][1]);
    ctx.closePath();
    ctx.stroke();
  };
  ctx.save();
  ctx.lineWidth = 1;
  for (const rock of serverRocks) {
    const shape = rockShape(rock);
    if (!shape) continue;
    const [sx, sy] = toScreen(rock.x, rock.y);
    if (sx < -shape.boundR || sx > canvas.width + shape.boundR || sy < -shape.boundR || sy > canvas.height + shape.boundR) continue;
    ctx.strokeStyle = '#ffd400';
    strokePoly(shape.hull, sx, sy);
    ctx.strokeStyle = '#ff2d2d';
    strokePoly(shape.poly, sx, sy);
  }
  ctx.strokeStyle = '#00e5ff';
  const ships = [[localPlayer.x, localPlayer.y, localPlayer.dead, localPlayer.shipType]];
  for (const [, p] of remotePlayers) ships.push([p.renderX ?? p.x, p.renderY ?? p.y, p.dead, p.shipType]);
  for (const [x, y, dead, id] of ships) {
    if (dead) continue;
    const [sx, sy] = toScreen(x, y);
    ctx.beginPath();
    ctx.arc(sx, sy, shipType(id).r, 0, Math.PI * 2);
    ctx.stroke();
  }
  const now = performance.now();
  while (debugHits.length && now - debugHits[0].t > DEBUG_HIT_LIFE) debugHits.shift();
  ctx.strokeStyle = '#ff40ff';
  ctx.lineWidth = 2;
  for (const h of debugHits) {
    const [sx, sy] = toScreen(h.x, h.y);
    ctx.beginPath();
    ctx.moveTo(sx - 5, sy - 5); ctx.lineTo(sx + 5, sy + 5);
    ctx.moveTo(sx + 5, sy - 5); ctx.lineTo(sx - 5, sy + 5);
    ctx.stroke();
  }
  ctx.restore();
}

function drawNickname(centerX, aboveY, name) {
  ctx.font = '12px Ticketing';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText(name, centerX, aboveY - 2);
}

function drawRemotePlayers(camX, camY) {
  for (const [, p] of remotePlayers) {
    if (p.dead) continue;

    const rx = p.renderX ?? p.x;
    const ry = p.renderY ?? p.y;
    const dx = torusDelta(rx, camX, WORLD_W);
    const dy = torusDelta(ry, camY, WORLD_H);
    const sx = canvas.width / 2 + dx;
    const sy = canvas.height / 2 + dy;

    const pr = shipType(p.shipType).r;
    const margin = pr + 60;
    if (sx < -margin || sx > canvas.width + margin || sy < -margin || sy > canvas.height + margin) continue;

    const rs = respawnDrawState(p.id);
    drawShip(sx, sy, p.angle, p.color, p.shipType, hitFlashPlayers.has(p.id), rs.scale, rs.white, rs.alpha);
    const hpTopY = sy - pr - 12;
    drawNickname(sx, hpTopY, p.name || 'Player');
    drawHealthBar(sx, hpTopY, pr, p.hp, p.maxHp);
    drawXpBar(sx, sy + pr + 6, pr, p.totalXpEarned ?? 0);
  }
}

// XP rock marker used by every map: rhombus in the rock's accent color, thin white outline,
// gently pulsing in size (smooth, XP_MARKER_PULSE_PERIOD cycle). halfW = half width at rest.
function drawXpRockMarker(x, y, halfW, color) {
  const k = 1 + XP_MARKER_PULSE * Math.sin(performance.now() / 1000 * Math.PI * 2 / XP_MARKER_PULSE_PERIOD);
  const hw = halfW * k, hh = hw * 5 / 3;
  ctx.beginPath();
  ctx.moveTo(x, y - hh);
  ctx.lineTo(x + hw, y);
  ctx.lineTo(x, y + hh);
  ctx.lineTo(x - hw, y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  ctx.stroke();
}

// Current minimap rect (animates between normal and expanded), for drawing and click consumption.
function minimapRect() {
  const t = easeOutCubic(minimapExpandAnim / MAP_ANIM_TIME);
  const size = Math.round(MINIMAP_SIZE * (1 + (MINIMAP_EXPANDED_SIZE_MULT - 1) * t));
  return { x: canvas.width - CORNER_PAD - size, y: canvas.height - CORNER_PAD - size, size, t };
}

function drawMinimap() {
  const { x: mx, y: my, size, t } = minimapRect();
  const half = size / 2;
  // World half-extent shown: normal view → MINIMAP_EXPANDED_CHUNKS chunks each way when expanded.
  const halfWorld = MINIMAP_HALF_WORLD + (MINIMAP_EXPANDED_CHUNKS * CHUNK_SIZE - MINIMAP_HALF_WORLD) * t;
  const scale = half / halfWorld;
  const k = size / MINIMAP_SIZE; // frame-relative sizes (inset, corner radius) scale with the minimap

  const camX = localPlayer.x;
  const camY = localPlayer.y;
  const toMini = (x, y) => [mx + half + torusDelta(x, camX, WORLD_W) * scale, my + half + torusDelta(y, camY, WORLD_H) * scale];
  const inside = (sx, sy) => sx >= mx && sx <= mx + size && sy >= my && sy <= my + size;

  // Track death point transitions
  if (localPlayer.dead && !prevDead) deathPoint = { x: localPlayer.x, y: localPlayer.y };
  if (!localPlayer.dead && prevDead) deathPoint = null;
  prevDead = localPlayer.dead;

  // Clip contents to rounded frame shape
  ctx.save();
  roundRect(ctx, mx + 4 * k, my + 4 * k, size - 8 * k, size - 8 * k, 12 * k);
  ctx.clip();

  // Background, then the biome tint of the camera's position (same weights as the world view). Inside
  // the rounded clip, so no square corners show outside the frame.
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(mx, my, size, size);
  const [mr, mg, mb] = biomeMixRGB('minimapTint', BIOMES.wasteland.minimapTint);
  ctx.fillStyle = `rgba(${mr}, ${mg}, ${mb}, 0.4)`;
  ctx.fillRect(mx, my, size, size);

  // Expanded view: current chunk highlight and chunk grid (fade in with the expansion).
  if (t > 0) {
    ctx.save();
    ctx.globalAlpha = t;
    const cur = worldToChunk(camX, camY);
    const b = chunkBounds(cur.cx, cur.cy);
    const [hx, hy] = toMini(b.x0, b.y0);
    ctx.fillStyle = MAP_CURRENT_FILL;
    ctx.fillRect(Math.round(hx), Math.round(hy), Math.ceil(CHUNK_SIZE * scale), Math.ceil(CHUNK_SIZE * scale));
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(255,255,255,${MAP_GRID_MAJOR_ALPHA})`;
    ctx.beginPath();
    // Chunk boundaries in view, walked relative to the camera (no wrap issues).
    for (let bx = Math.ceil((camX - halfWorld) / CHUNK_SIZE) * CHUNK_SIZE; bx <= camX + halfWorld; bx += CHUNK_SIZE) {
      const gx = Math.round(mx + half + (bx - camX) * scale) + 0.5;
      ctx.moveTo(gx, my); ctx.lineTo(gx, my + size);
    }
    for (let by = Math.ceil((camY - halfWorld) / CHUNK_SIZE) * CHUNK_SIZE; by <= camY + halfWorld; by += CHUNK_SIZE) {
      const gy = Math.round(my + half + (by - camY) * scale) + 0.5;
      ctx.moveTo(mx, gy); ctx.lineTo(mx + size, gy);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Rocks: normal ones first, XP rock markers on top.
  ctx.fillStyle = '#ffffff';
  for (const rock of serverRocks) {
    if (rock.k === 'xp') continue;
    const [sx, sy] = toMini(rock.x, rock.y);
    if (!inside(sx, sy)) continue;
    const rr = Math.min(6, Math.max(2, rock.r * scale));
    ctx.beginPath();
    ctx.arc(sx, sy, rr, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const rock of serverRocks) {
    if (rock.k !== 'xp') continue;
    const [sx, sy] = toMini(rock.x, rock.y);
    if (!inside(sx, sy)) continue;
    drawXpRockMarker(Math.round(sx), Math.round(sy), XP_MARKER_HALF_W * (1 + 0.5 * t),
      rockAccentCache.get(rock.texturePath) || XP_PARTICLE_FALLBACK);
  }

  // Remote players (normal minimap only; fade out when expanding)
  if (t < 1) {
    ctx.save();
    ctx.globalAlpha = 1 - t;
    for (const [, p] of remotePlayers) {
      if (p.dead) continue;
      const [sx, sy] = toMini(p.x, p.y);
      if (!inside(sx, sy)) continue;
      ctx.beginPath();
      ctx.arc(sx, sy, 3, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
    }
    ctx.restore();
  }

  // Self: dot on the normal minimap, cross-fading to a facing arrow when expanded.
  ctx.save();
  ctx.globalAlpha = 1 - t;
  ctx.beginPath();
  ctx.arc(mx + half, my + half, 4, 0, Math.PI * 2);
  ctx.fillStyle = localPlayer.color || '#ffffff';
  ctx.fill();
  if (t > 0 && !localPlayer.dead) {
    const L = MAP_SHIP_SIZE;
    ctx.globalAlpha = t;
    ctx.translate(Math.round(mx + half), Math.round(my + half));
    ctx.rotate(localPlayer.angle);
    ctx.beginPath();
    ctx.moveTo(L * 0.6, 0);
    ctx.lineTo(-L * 0.4, L * 0.4);
    ctx.lineTo(-L * 0.15, 0);
    ctx.lineTo(-L * 0.4, -L * 0.4);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // Death point (inside minimap)
  if (deathPoint) {
    const [dsx, dsy] = toMini(deathPoint.x, deathPoint.y);
    if (inside(dsx, dsy)) {
      ctx.beginPath();
      ctx.arc(dsx, dsy, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ef4444';
      ctx.fill();
    }
  }

  ctx.restore();

  // Frame
  if (minimapFrameReady) {
    ctx.drawImage(minimapFrameImg, mx, my, size, size);
  }

  // Coordinates + ping above minimap
  ctx.save();
  ctx.font = "13px Ticketing";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.fillText(
    `X: ${Math.round(localPlayer.x)}; Y: ${Math.round(localPlayer.y)} | PING: ${ping}`,
    mx + half,
    my - 8
  );
  ctx.restore();

  // Death point outside minimap — dot on the contour pointing toward it
  if (deathPoint) {
    const ddx = torusDelta(deathPoint.x, camX, WORLD_W);
    const ddy = torusDelta(deathPoint.y, camY, WORLD_H);
    const [dsx, dsy] = toMini(deathPoint.x, deathPoint.y);
    if (!inside(dsx, dsy)) {
      const angle = Math.atan2(ddy, ddx);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const margin = 5 * k;
      let tt = Infinity;
      if (cos > 0)  tt = Math.min(tt, (half - margin) / cos);
      if (cos < 0)  tt = Math.min(tt, (-half + margin) / cos);
      if (sin > 0)  tt = Math.min(tt, (half - margin) / sin);
      if (sin < 0)  tt = Math.min(tt, (-half + margin) / sin);
      const ex = mx + half + cos * tt;
      const ey = my + half + sin * tt;
      ctx.beginPath();
      ctx.arc(ex, ey, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ef4444';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

function roundRect(cx, x, y, w, h, r) {
  cx.beginPath();
  cx.moveTo(x + r, y);
  cx.lineTo(x + w - r, y);
  cx.quadraticCurveTo(x + w, y, x + w, y + r);
  cx.lineTo(x + w, y + h - r);
  cx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  cx.lineTo(x + r, y + h);
  cx.quadraticCurveTo(x, y + h, x, y + h - r);
  cx.lineTo(x, y + r);
  cx.quadraticCurveTo(x, y, x + r, y);
  cx.closePath();
}

const UPGRADE_BAR_XS = [17, 25, 33, 41, 49, 57];

function drawUpgradeBar() {
  if (!myId || localPlayer.dead) return;

  const upgrades = localPlayer.upgrades;
  const btnW  = 80;
  const btnH  = 112;
  const gap   = 16;
  const SLOTS = UPGRADE_DEFS_CLIENT.length;
  const totalW = SLOTS * btnW + (SLOTS - 1) * gap;
  const minimapX = canvas.width - CORNER_PAD - MINIMAP_SIZE;
  const startX = minimapX - 32 - totalW;

  // Auto-show/hide only on transition so manual toggle isn't overridden every frame
  const hasPoints = localPlayer.upgradePoints > 0;
  if (hasPoints && _prevUpgradePoints === 0) upgradeBarHidden = false;
  if (!hasPoints && _prevUpgradePoints > 0) upgradeBarHidden = true;
  _prevUpgradePoints = localPlayer.upgradePoints;

  const slideTarget = upgradeBarHidden ? btnH + CORNER_PAD : 0;
  upgradeBarSlideY += (slideTarget - upgradeBarSlideY) * 0.15;

  const startY = canvas.height - CORNER_PAD - btnH + upgradeBarSlideY;

  // Label travels with the bar; when fully hidden it sits 8px above screen bottom
  ctx.save();
  ctx.font = '16px Ticketing';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillText(
    `press "U" to ${upgradeBarHidden ? 'open' : 'hide'}  |  ${localPlayer.upgradePoints ?? 0} points available`,
    startX + totalW, Math.min(startY - 8, canvas.height - CORNER_PAD)
  );
  ctx.restore();

  upgradeHitBoxes.length = 0;

  if (upgradeBarSlideY >= btnH + CORNER_PAD - 2) return;

  // Dim shadow behind all upgrade buttons
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  roundRect(ctx, startX - 10, startY - 10, totalW + 20, btnH + 20, 18);
  ctx.fill();

  for (let i = 0; i < SLOTS; i++) {
    const def = UPGRADE_DEFS_CLIENT[i];
    const bx = startX + i * (btnW + gap);
    const by = startY;

    const level     = (upgrades && upgrades[def.id]) || 0;
    const maxed     = level >= MAX_UPGRADE_LEVEL;
    const hasPoint  = localPlayer.upgradePoints >= 1;
    const canAfford = !maxed && hasPoint;
    const hovered   = mouseX >= bx && mouseX <= bx + btnW && mouseY >= by && mouseY <= by + btnH;

    ctx.globalAlpha = (!hasPoint && !maxed) ? 0.35 : 1;

    // Base texture
    const img = upgradeImgs[def.id];
    if (img && img._loaded) {
      ctx.drawImage(img, bx, by, btnW, btnH);
    } else {
      ctx.fillStyle = 'rgba(0,0,0,0.85)';
      roundRect(ctx, bx, by, btnW, btnH, 14);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 2;
      roundRect(ctx, bx, by, btnW, btnH, 14);
      ctx.stroke();
    }

    // Erase baked static dots from SVG artwork
    ctx.fillStyle = '#000000';
    ctx.fillRect(bx + 14, by + 66, 52, 11);

    // Progress bar pills
    for (let d = 0; d < MAX_UPGRADE_LEVEL; d++) {
      const barImg = d < level ? fullUpgradeImg : emptyUpgradeImg;
      if (barImg._loaded) {
        ctx.drawImage(barImg, bx + UPGRADE_BAR_XS[d], by + 67, 6, 16);
      } else {
        roundRect(ctx, bx + UPGRADE_BAR_XS[d], by + 67, 6, 16, 3);
        if (d < level) { ctx.fillStyle = '#D9D9D9'; ctx.fill(); }
        else { ctx.strokeStyle = 'rgba(217,217,217,0.35)'; ctx.lineWidth = 1; ctx.stroke(); }
      }
    }

    // Hover highlight
    if (hovered) {
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      roundRect(ctx, bx + 2, by + 2, 76, 108, 12);
      ctx.fill();
    }

    // State border overlay
    if (maxed) {
      ctx.strokeStyle = 'rgba(255,215,0,0.85)';
      ctx.lineWidth = 3;
      roundRect(ctx, bx + 2, by + 2, 76, 108, 12);
      ctx.stroke();
    } else if (canAfford) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2;
      roundRect(ctx, bx + 2, by + 2, 76, 108, 12);
      ctx.stroke();
    }

    // Keypress flash
    const flashAlpha = Math.max(0, 0.45 - (performance.now() - upgradeFlashTime[i]) / 250 * 0.45);
    if (flashAlpha > 0) {
      ctx.fillStyle = `rgba(255,255,255,${flashAlpha.toFixed(2)})`;
      roundRect(ctx, bx + 2, by + 2, 76, 108, 12);
      ctx.fill();
    }

    // Status label at bottom
    ctx.font = '10px Ticketing';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (maxed) {
      ctx.fillStyle = 'rgba(255,215,0,0.85)';
      ctx.fillText('MAX', bx + btnW / 2, by + 101);
    }

    upgradeHitBoxes.push({ x: bx, y: by, w: btnW, h: btnH, id: def.id });
    ctx.globalAlpha = 1;
  }

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
}

function drawHUD() {
  const pad = 16;

  ctx.font = "20px Ticketing";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#facc15";
  ctx.fillText(`Gold: ${localPlayer.gemCount}`, pad, pad);

  ctx.fillStyle = "#4ade80";
  ctx.fillText(`XP: ${localPlayer.xpCount}`, pad, pad + 28);

  const { level: localLevel } = getLevelInfo(localPlayer.totalXpEarned ?? 0);
  ctx.fillStyle = "#60a5fa";
  ctx.fillText(`Lv. ${localLevel}`, pad, pad + 56);

  ctx.font = "14px Ticketing";
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.fillText(`Players online: ${onlineCount}`, pad, pad + 84);

  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillText(`X: ${Math.floor(localPlayer.x)}  Y: ${Math.floor(localPlayer.y)}`, canvas.width - pad, pad);
  ctx.font = "14px Ticketing";
  ctx.fillStyle = fps >= 55 ? "rgba(74,222,128,0.8)" : fps >= 30 ? "rgba(250,204,21,0.8)" : "rgba(239,68,68,0.8)";
  ctx.fillText(`${fps} fps`, canvas.width - pad, pad + 28);
  ctx.textAlign = "left";
}

function drawDeathScreen() {
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.font = "bold 64px Ticketing";
  ctx.fillStyle = "#ef4444";
  ctx.fillText("YOU DIED", canvas.width / 2, canvas.height / 2 - 44);

  ctx.font = "24px Ticketing";
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.fillText(
    `Respawning in ${Math.ceil(Math.max(0, localPlayer.respawnTimer))}s...`,
    canvas.width / 2, canvas.height / 2 + 20
  );

  ctx.textAlign = "left";
  ctx.textBaseline = "top";
}

function drawConnecting() {
  ctx.fillStyle = "rgba(0,0,0,0.85)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "28px Ticketing";
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.fillText("Connecting to server...", canvas.width / 2, canvas.height / 2);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
}

// Biome mist: a full-screen wash of the biome's color over the background, below every world object.
// Alpha is weight × BACKGROUND_TINT_ALPHA, clamped, so it is exactly 0 in the neutral zone.
function drawBiomeMist() {
  for (const id of ['frost', 'ember']) {
    const alpha = Math.min(BACKGROUND_TINT_ALPHA, Math.max(0, biomeW[id] * BACKGROUND_TINT_ALPHA));
    if (!(alpha > 0)) continue;
    const [r, g, b] = BIOMES[id].biomeTint;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }
}

// --- Frame safety ---
// One broken layer must never blank the screen: every layer runs in its own try/catch, logs its first
// error (with the camera position) once, and the rest of the frame (and the HUD) still draws.
// ctx.save/restore are counted so a layer that throws mid-save can be unwound.
let ctxSaveDepth = 0;
{
  const save = ctx.save.bind(ctx), restore = ctx.restore.bind(ctx);
  ctx.save = () => { ctxSaveDepth++; save(); };
  ctx.restore = () => { if (ctxSaveDepth > 0) ctxSaveDepth--; restore(); };
}

function resetCtxState() {
  while (ctxSaveDepth > 0) ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

const loggedLayerErrors = new Set();
function safeLayer(name, fn) {
  const depth = ctxSaveDepth;
  ctx.save(); // each layer is isolated: its canvas state never reaches the next layer
  try {
    fn();
    while (ctxSaveDepth > depth) ctx.restore();
  } catch (err) {
    if (!loggedLayerErrors.has(name)) {
      loggedLayerErrors.add(name);
      console.error(`[frame] "${name}" threw at x=${localPlayer.x}, y=${localPlayer.y}; skipping it, rest of the frame continues`, err);
    }
    while (ctxSaveDepth > depth) ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

// Camera/player position guard: a NaN/Infinity position would break every world draw, so fall back to
// the last valid values (logged once per incident).
let lastValidPos = { x: 0, y: 0 };
let posGuardTripped = false;
function guardPlayerPosition() {
  const p = localPlayer;
  if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
    lastValidPos = { x: p.x, y: p.y };
    posGuardTripped = false;
  } else {
    if (!posGuardTripped) console.error(`[frame] player position became x=${p.x}, y=${p.y}; restoring last valid (${lastValidPos.x}, ${lastValidPos.y})`);
    posGuardTripped = true;
    p.x = lastValidPos.x;
    p.y = lastValidPos.y;
  }
  if (!Number.isFinite(p.vx) || !Number.isFinite(p.vy)) { p.vx = 0; p.vy = 0; }
  if (!Number.isFinite(p.angle)) p.angle = 0;
}

function draw() {
  // Fresh canvas state every frame, so nothing drawn last frame can leak into this one.
  resetCtxState();

  // Biome-tinted background: black → the biome's darkest color by weight. Plain fill, can't throw.
  const [bgR, bgG, bgB] = biomeMixRGB('bgDarkest', [0, 0, 0]);
  ctx.fillStyle = `rgb(${bgR}, ${bgG}, ${bgB})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const camX = localPlayer.x;
  const camY = localPlayer.y;

  safeLayer('stars', () => drawStars(camX, camY));
  safeLayer('shootingStars', () => drawShootingStars(camX, camY));

  if (!connected || myId === null) {
    safeLayer('connecting', drawConnecting);
    return;
  }

  safeLayer('biomeMist', drawBiomeMist);
  safeLayer('rocks', () => drawRocks(camX, camY));
  safeLayer('xpParticles', () => drawXpParticles(camX, camY));
  safeLayer('shatter', () => drawShatterEffects(camX, camY));
  safeLayer('gems', () => drawGems(camX, camY));
  safeLayer('xpDrops', () => drawXpDrops(camX, camY));
  safeLayer('engineTrails', () => drawEngineTrails(camX, camY)); // engine ribbons: below ships
  safeLayer('fxWorld', () => drawFx(camX, camY, 'world')); // sparks, pickup pops, level rings: above rocks and loot, below ships
  safeLayer('bullets', () => drawBullets(camX, camY));
  safeLayer('remotePlayers', () => drawRemotePlayers(camX, camY));

  if (!localPlayer.dead) safeLayer('localShip', () => {
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const pr = shipType(localPlayer.shipType).r;
    const rs = respawnDrawState(myId);
    drawShip(cx, cy, localPlayer.angle, localPlayer.color, localPlayer.shipType, hitFlashPlayers.has(myId), rs.scale, rs.white, rs.alpha);
    const hpTopY = cy - pr - 12;
    drawNickname(cx, hpTopY, localPlayer.nickname || 'Player');
    drawHealthBar(cx, hpTopY, pr, localPlayer.hp, localPlayer.maxHp);
    drawXpBar(cx, cy + pr + 6, pr, localPlayer.totalXpEarned, xpBarPulseScale());
  });

  safeLayer('fxTop', () => drawFx(camX, camY, 'top')); // muzzle flashes and level text: above ships, below the HUD

  if (DEBUG_HIT) safeLayer('hitDebug', () => drawHitDebug(camX, camY));

  safeLayer('hud', drawHUD);
  safeLayer('upgradeBar', drawUpgradeBar);
  safeLayer('minimap', drawMinimap);

  safeLayer('classMenu', drawClassMenu);
  safeLayer('worldMap', drawWorldMap);

  if (localPlayer.dead) safeLayer('deathScreen', drawDeathScreen);
}

// Parallax star layers, tinted toward the biome's star color by weight.
function drawStars(camX, camY) {
  const [starR, starG, starB] = biomeMixRGB('starTint', BIOMES.wasteland.starTint);

  for (const layer of starLayers) {
    const ox = ((camX * layer.parallax) % PARALLAX_TILE + PARALLAX_TILE) % PARALLAX_TILE;
    const oy = ((camY * layer.parallax) % PARALLAX_TILE + PARALLAX_TILE) % PARALLAX_TILE;
    for (const s of layer.stars) {
      const a = (s.alpha * (0.7 + 0.3 * Math.sin(s.phase))).toFixed(2);
      for (let tx = -1; tx <= 1; tx++) {
        for (let ty = -1; ty <= 1; ty++) {
          const sx = s.x - ox + tx * PARALLAX_TILE;
          const sy = s.y - oy + ty * PARALLAX_TILE;
          if (sx < -s.r || sx > canvas.width + s.r || sy < -s.r || sy > canvas.height + s.r) continue;
          ctx.beginPath();
          ctx.arc(sx, sy, s.r, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${Math.round(starR)},${Math.round(starG)},${Math.round(starB)},${a})`;
          ctx.fill();
        }
      }
    }
  }
}

// --- Class upgrade menu ---
// The server decides what is pending (shared/classes.js tree); this only shows it and sends the pick.
// Layout measured from public/textures/interface/classes/demoscreenupgrade.svg at 1920×1080 and
// scaled with the viewport. Values are reference pixels at that size. Cards are click-only.

const CLASS_MENU_REF_W       = 1920;
const CLASS_MENU_REF_H       = 1080;
const CLASS_CARD_SCALE       = 1 / 1.5; // cards (art, border, radius, name, gap) vs the mockup's 256×224
const CLASS_CARD_W           = 256 * CLASS_CARD_SCALE; // outer size incl. the border (≈171×149)
const CLASS_CARD_H           = 224 * CLASS_CARD_SCALE;
const CLASS_CARD_GAP         = 32 * CLASS_CARD_SCALE;
const CLASS_CARD_BORDER      = 4 * CLASS_CARD_SCALE;
const CLASS_CARD_RADIUS      = 14 * CLASS_CARD_SCALE;
const CLASS_CARD_FILL        = 'rgba(0,0,0,0.5)'; // world shows through; border/name/art stay opaque
const CLASS_NAME_FONT_PX     = 32 * CLASS_CARD_SCALE;
const CLASS_NAME_RIGHT       = 241.5 * CLASS_CARD_SCALE; // card-relative right edge of the class name
const CLASS_NAME_BASELINE    = 208 * CLASS_CARD_SCALE;   // card-relative baseline of the class name
const CLASS_CARD_TOP         = 64;    // cards' top edge; the menu is centered horizontally
const CLASS_TITLE_BASELINES  = [32, 55];
const CLASS_FONT_PX          = 32;    // title (Ticketing cap height 0.66em → 21px letters, as in the mockup)
const CLASS_HINT_FONT_PX     = 20;
const CLASS_SOON_FONT_PX     = 16;    // "soon" label on classes without a ship yet
const CLASS_HINT_GAP         = 32;    // hint baseline below the cards
// Appear: each part (title, then each card) slides down and fades in; cards are staggered.
const CLASS_APPEAR_SLIDE     = 24;    // px slid down while appearing
const CLASS_APPEAR_TIME      = 0.3;   // s per part
const CLASS_APPEAR_STAGGER   = 0.07;  // s between parts
const CLASS_DISAPPEAR_SPEED  = CLASS_APPEAR_TIME / 0.2; // reverse ~200ms per part
// Hover: scale up and lift, eased.
const CLASS_HOVER_SCALE      = 1.05;
const CLASS_HOVER_LIFT       = 4;     // px
const CLASS_HOVER_TIME       = 0.12;  // s
const CLASS_FLASH_TIME       = 0.15;  // s the chosen card flashes before the pick is sent

const easeOutCubic = t => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);

const classMenu = {
  options: [],     // [{ id, available, ...CLASS_TREE entry }]
  shown: false,    // target state; `clock` runs toward the end (shown) or back to 0 (hidden)
  clock: 0,        // animation time in s; parts appear at clock = i * CLASS_APPEAR_STAGGER
  hover: {},       // id → hover progress 0..1 (linear; eased when drawn)
  pressId: null,   // card under a consumed mousedown
  flash: null,     // { id, t, sent }
  rects: [],       // drawn card rects for hit tests
  tinted: new Map(), // icon → { key, canvas } player-color tinted art
};

function classMenuEndTime() {
  return classMenu.options.length * CLASS_APPEAR_STAGGER + CLASS_APPEAR_TIME;
}

function setClassMenuOptions(options) {
  if (options && options.length) {
    classMenu.options = options.map(o => ({ ...classById(o.id), ...o }));
    classMenu.shown = true;
    classMenu.flash = null;
  } else {
    classMenu.shown = false;
  }
}

function classMenuInteractive() {
  return classMenu.shown && classMenu.clock >= classMenuEndTime() && !classMenu.flash;
}

// Visible card under a screen point (even while animating or unavailable, so the click is still consumed).
function classCardAt(x, y) {
  return classMenu.rects.find(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) || null;
}

function chooseClassCard(id) {
  const opt = classMenu.options.find(o => o.id === id);
  if (!opt || !opt.available || !classMenuInteractive()) return;
  classMenu.flash = { id, t: performance.now(), sent: false };
}

function updateClassMenu(dt) {
  const f = classMenu.flash;
  if (f && !f.sent && performance.now() - f.t >= CLASS_FLASH_TIME * 1000) {
    f.sent = true;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'chooseClass', id: f.id }));
    classMenu.shown = false; // animate out; the server confirms by clearing the choice
  }
  const end = classMenuEndTime();
  classMenu.clock = classMenu.shown
    ? Math.min(end, classMenu.clock + dt)
    : Math.max(0, classMenu.clock - dt * CLASS_DISAPPEAR_SPEED);

  // Hover progress per card (the hovered card is found from last frame's rects).
  const hovered = classMenuInteractive() ? classCardAt(mouseX, mouseY) : null;
  const hoverId = hovered && classMenu.options.find(o => o.id === hovered.id)?.available ? hovered.id : null;
  for (const opt of classMenu.options) {
    const cur = classMenu.hover[opt.id] || 0;
    const step = dt / CLASS_HOVER_TIME;
    classMenu.hover[opt.id] = opt.id === hoverId ? Math.min(1, cur + step) : Math.max(0, cur - step);
  }
  // Pointer over a card; '' falls back to the canvas's CSS crosshair cursor.
  const cursor = hoverId ? 'pointer' : '';
  if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;

  if (classMenu.clock === 0 && !classMenu.shown) {
    classMenu.rects = [];
    classMenu.flash = null;
    classMenu.hover = {};
  }
}

// Icon art tinted with the player's color, same technique as drawShip: draw, multiply by the color,
// then clip back to the art's alpha. White → color, black stays black. Cached per icon; rebuilt when
// the color or the drawn size changes, so color changes show up live.
function tintedClassArt(icon, color, w, h) {
  const img = texImg(icon);
  if (!img._loaded) return null;
  const key = `${color}|${w}x${h}`;
  let entry = classMenu.tinted.get(icon);
  if (!entry || entry.key !== key) {
    const c = entry?.canvas || document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, h);
    g.globalCompositeOperation = 'source-over';
    g.drawImage(img, 0, 0, w, h);
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = color;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(img, 0, 0, w, h);
    entry = { key, canvas: c };
    classMenu.tinted.set(icon, entry);
  }
  return entry.canvas;
}

// Appear progress of part i (0 = title, 1.. = cards), eased: 0 hidden → 1 fully in.
function classPartProgress(i) {
  return easeOutCubic((classMenu.clock - i * CLASS_APPEAR_STAGGER) / CLASS_APPEAR_TIME);
}

function drawClassMenu() {
  classMenu.rects = [];
  if (classMenu.clock === 0 || !classMenu.options.length) return;

  const s  = Math.min(canvas.width / CLASS_MENU_REF_W, canvas.height / CLASS_MENU_REF_H);
  const px = v => Math.round(v * s);
  const n  = classMenu.options.length;
  const menuW = n * CLASS_CARD_W + (n - 1) * CLASS_CARD_GAP;
  const x0 = Math.round(canvas.width / 2 - (menuW * s) / 2);
  const level = classMenu.options[0].level;
  const color = localPlayer.color || '#ffffff';

  ctx.save();
  ctx.textBaseline = 'alphabetic';

  // Title (part 0).
  const tp = classPartProgress(0);
  if (tp > 0) {
    const ty = -px(CLASS_APPEAR_SLIDE) * (1 - tp);
    ctx.globalAlpha = tp;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.font = `${px(CLASS_FONT_PX)}px Ticketing`;
    ctx.fillText(`you've reached level ${level}!`, x0, Math.round(ty) + px(CLASS_TITLE_BASELINES[0]));
    ctx.fillText('choose an upgrade:', x0, Math.round(ty) + px(CLASS_TITLE_BASELINES[1]));
  }

  let hoverHint = null;
  classMenu.options.forEach((opt, i) => {
    const cp = classPartProgress(i + 1);
    if (cp <= 0) return;
    const w = px(CLASS_CARD_W), h = px(CLASS_CARD_H);
    const x = x0 + px(i * (CLASS_CARD_W + CLASS_CARD_GAP));
    const y = px(CLASS_CARD_TOP) - Math.round(px(CLASS_APPEAR_SLIDE) * (1 - cp));
    classMenu.rects.push({ id: opt.id, x, y, w, h });

    const hv = easeOutCubic(classMenu.hover[opt.id] || 0);
    if (hv > 0) hoverHint = opt.hint;
    const scale = 1 + (CLASS_HOVER_SCALE - 1) * hv;
    const lift = CLASS_HOVER_LIFT * s * hv;

    ctx.save();
    ctx.globalAlpha = cp * (opt.available ? 1 : 0.35); // same dimming as unaffordable stat cards
    // Hover: scale around the card center and lift.
    ctx.translate(x + w / 2, y + h / 2 - lift);
    ctx.scale(scale, scale);
    ctx.translate(-(x + w / 2), -(y + h / 2));

    // Frame (mockup: rect inset by half the border, white stroke, rounded).
    const inset = CLASS_CARD_BORDER / 2 * s;
    ctx.fillStyle = CLASS_CARD_FILL;
    roundRect(ctx, x + inset, y + inset, w - inset * 2, h - inset * 2, CLASS_CARD_RADIUS * s);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1, CLASS_CARD_BORDER * s);
    ctx.stroke();

    const art = opt.icon ? tintedClassArt(opt.icon, color, w, h) : null;
    if (art) ctx.drawImage(art, x, y, w, h);

    ctx.fillStyle = '#ffffff';
    ctx.font = `${px(CLASS_NAME_FONT_PX)}px Ticketing`;
    ctx.textAlign = 'right';
    ctx.fillText(opt.name, x + px(CLASS_NAME_RIGHT), y + px(CLASS_NAME_BASELINE));
    if (!opt.available) {
      ctx.font = `${px(CLASS_SOON_FONT_PX)}px Ticketing`;
      ctx.fillText('soon', x + w - px(12), y + px(24));
    }

    // Hover tint + click flash, same as the stat upgrade cards.
    const innerInset = CLASS_CARD_BORDER * s;
    const innerR = Math.max(0, CLASS_CARD_RADIUS * s - innerInset / 2);
    if (hv > 0) {
      ctx.fillStyle = `rgba(255,255,255,${(0.07 * hv).toFixed(3)})`;
      roundRect(ctx, x + innerInset, y + innerInset, w - innerInset * 2, h - innerInset * 2, innerR);
      ctx.fill();
    }
    const f = classMenu.flash;
    if (f && f.id === opt.id) {
      const a = Math.max(0, 0.45 - (performance.now() - f.t) / 250 * 0.45);
      if (a > 0) {
        ctx.fillStyle = `rgba(255,255,255,${a.toFixed(2)})`;
        roundRect(ctx, x + innerInset, y + innerInset, w - innerInset * 2, h - innerInset * 2, innerR);
        ctx.fill();
      }
    }
    ctx.restore();
  });

  if (hoverHint) {
    ctx.globalAlpha = classPartProgress(n);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.font = `${px(CLASS_HINT_FONT_PX)}px Ticketing`;
    ctx.fillText(hoverHint, x0, px(CLASS_CARD_TOP + CLASS_CARD_H + CLASS_HINT_GAP));
  }
  ctx.restore();
}

// --- World map (M) ---
// Client-only overview of the whole world: chunk grid, origin, your current chunk, the rocks you can see,
// your ship and death point. Styled like the class-upgrade menu. Values are reference pixels at
// 1920×1080, scaled with the viewport.

const MAP_MARGIN          = 48;    // panel distance from the screen edges
const MAP_PAD             = 20;    // map square inset from the panel border
const MAP_HEADER          = 44;    // header row (title + current chunk) above the map square
const MAP_BORDER          = 4;
const MAP_RADIUS          = 14;
const MAP_FILL            = 'rgba(0,0,0,0.8)';
const MAP_TITLE_FONT_PX   = 32;
const MAP_INFO_FONT_PX    = 20;
const MAP_TIP_FONT_PX     = 16;
const MAP_GRID_ALPHA      = 0.12;  // chunk lines
const MAP_GRID_MAJOR      = 4;     // every 4 chunks...
const MAP_GRID_MAJOR_ALPHA = 0.3;  // ...a stronger line
const MAP_CURRENT_FILL    = 'rgba(255,255,255,0.22)';
const MAP_ROCK_MIN_R      = 1.5;   // px; rock dots are sized by rock radius at map scale, at least this
const MAP_SHIP_SIZE       = 12;    // arrow length
const MAP_SHIP_BLINK_HZ   = 1.2;   // gentle pulse between MAP_SHIP_BLINK_MIN and full opacity
const MAP_SHIP_BLINK_MIN  = 0.55;
const MAP_ANIM_TIME       = 0.25;  // s open/close (fade + slide)
const MAP_SLIDE           = 24;    // px

const worldMap = {
  open: false,
  anim: 0,                 // 0 closed … MAP_ANIM_TIME open
  panel: null,             // last drawn panel rect, for click consumption
};

// M cycles: 0 = normal minimap → 1 = expanded minimap → 2 = full world map → 0. Escape → 0.
let mapMode = 0;
let minimapExpandAnim = 0; // 0 normal … MAP_ANIM_TIME expanded

function setMapMode(mode) {
  mapMode = mode;
  worldMap.open = mode === 2;
}

// On a map? Clicks there are swallowed so they never fire: the full-map panel when shown, and the
// minimap (normal or expanded) always.
function mapHit(x, y) {
  const r = worldMap.panel;
  if (worldMap.open && r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return true;
  if (myId === null) return false;
  const m = minimapRect();
  return x >= m.x && x <= m.x + m.size && y >= m.y && y <= m.y + m.size;
}

function updateWorldMap(dt) {
  worldMap.anim = worldMap.open ? Math.min(MAP_ANIM_TIME, worldMap.anim + dt) : Math.max(0, worldMap.anim - dt);
  minimapExpandAnim = mapMode === 1 ? Math.min(MAP_ANIM_TIME, minimapExpandAnim + dt) : Math.max(0, minimapExpandAnim - dt);
}

function drawWorldMap() {
  worldMap.panel = null;
  if (worldMap.anim === 0 || myId === null) return;

  const s = Math.min(canvas.width / 1920, canvas.height / 1080);
  const px = v => Math.round(v * s);
  const t = easeOutCubic(worldMap.anim / MAP_ANIM_TIME);

  // Square map area fitted to the screen, panel around it.
  const side = Math.floor(Math.min(
    canvas.width  - 2 * px(MAP_MARGIN) - 2 * px(MAP_PAD),
    canvas.height - 2 * px(MAP_MARGIN) - px(MAP_HEADER) - px(MAP_PAD)));
  if (side < 64) return;
  const cell = side / CHUNKS_PER_AXIS;
  const panelW = side + 2 * px(MAP_PAD), panelH = side + px(MAP_HEADER) + px(MAP_PAD);
  const panelX = Math.round((canvas.width - panelW) / 2);
  const panelY = Math.round((canvas.height - panelH) / 2 - px(MAP_SLIDE) * (1 - t));
  const mapX = panelX + px(MAP_PAD), mapY = panelY + px(MAP_HEADER);
  worldMap.panel = { x: panelX, y: panelY, w: panelW, h: panelH };

  // World → map pixels (world is centered on the origin; chunk (cx, cy) spans cell index cx - CHUNK_MIN).
  const toMapX = x => mapX + (wrapX(x) - WORLD_MIN) / WORLD_W * side;
  const toMapY = y => mapY + (wrapY(y) - WORLD_MIN) / WORLD_H * side;
  const cellX = cx => mapX + (cx - CHUNK_MIN) * cell;
  const cellY = cy => mapY + (cy - CHUNK_MIN) * cell;

  ctx.save();
  ctx.globalAlpha = t;

  // Panel (class-menu style).
  ctx.fillStyle = MAP_FILL;
  roundRect(ctx, panelX, panelY, panelW, panelH, px(MAP_RADIUS));
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(1, px(MAP_BORDER));
  ctx.stroke();

  // Biome background per chunk (draw before current chunk highlight and grid).
  for (let cx = CHUNK_MIN; cx < CHUNK_MIN + CHUNKS_PER_AXIS; cx++) {
    for (let cy = CHUNK_MIN; cy < CHUNK_MIN + CHUNKS_PER_AXIS; cy++) {
      const biome = getBiomeForChunk(cx, cy);
      if (biome.mapColor && biome.mapColor !== '#000000') {
        ctx.fillStyle = biome.mapColor;
        ctx.fillRect(Math.round(cellX(cx)), Math.round(cellY(cy)), Math.ceil(cell), Math.ceil(cell));
      }
    }
  }

  // Current chunk.
  const cur = worldToChunk(localPlayer.x, localPlayer.y);
  if (!localPlayer.dead) {
    ctx.fillStyle = MAP_CURRENT_FILL;
    ctx.fillRect(Math.round(cellX(cur.cx)), Math.round(cellY(cur.cy)), Math.ceil(cell), Math.ceil(cell));
  }

  // Chunk grid: thin lines, stronger every MAP_GRID_MAJOR chunks. Half-pixel offsets keep 1px lines crisp.
  ctx.lineWidth = 1;
  for (let i = 0; i <= CHUNKS_PER_AXIS; i++) {
    const major = (i + CHUNK_MIN) % MAP_GRID_MAJOR === 0;
    ctx.strokeStyle = `rgba(255,255,255,${major ? MAP_GRID_MAJOR_ALPHA : MAP_GRID_ALPHA})`;
    const gx = Math.round(mapX + i * cell) + 0.5, gy = Math.round(mapY + i * cell) + 0.5;
    ctx.beginPath();
    ctx.moveTo(gx, mapY); ctx.lineTo(gx, mapY + side);
    ctx.moveTo(mapX, gy); ctx.lineTo(mapX + side, gy);
    ctx.stroke();
  }

  // Origin (0, 0): a white cross with a small square at the center.
  const ox = Math.round(toMapX(0)), oy = Math.round(toMapY(0)), oa = Math.max(6, px(12));
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(1, px(2));
  ctx.beginPath();
  ctx.moveTo(ox - oa, oy); ctx.lineTo(ox + oa, oy);
  ctx.moveTo(ox, oy - oa); ctx.lineTo(ox, oy + oa);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  const os = Math.max(3, px(6));
  ctx.fillRect(ox - os / 2, oy - os / 2, os, os);

  // Rocks the client currently knows about (in view range; same data the game draws), live.
  // White dots sized by rock radius; XP rocks on top as outlined, pulsing accent-color rhombi (2×).
  const mapScale = side / WORLD_W;
  ctx.fillStyle = '#ffffff';
  for (const rock of serverRocks) {
    if (rock.k === 'xp') continue;
    ctx.beginPath();
    ctx.arc(toMapX(rock.x), toMapY(rock.y), Math.max(MAP_ROCK_MIN_R, rock.r * mapScale), 0, Math.PI * 2);
    ctx.fill();
  }
  for (const rock of serverRocks) {
    if (rock.k !== 'xp') continue;
    drawXpRockMarker(toMapX(rock.x), toMapY(rock.y), 2 * Math.max(MAP_ROCK_MIN_R, rock.r * mapScale),
      rockAccentCache.get(rock.texturePath) || XP_PARTICLE_FALLBACK);
  }

  // Death point (same rule as the minimap marker).
  if (deathPoint) {
    ctx.beginPath();
    ctx.arc(toMapX(deathPoint.x), toMapY(deathPoint.y), Math.max(3, px(6)), 0, Math.PI * 2);
    ctx.fillStyle = '#ef4444';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Your ship: an arrow in your color, pointing where you face, gently pulsing.
  if (!localPlayer.dead) {
    const pulse = MAP_SHIP_BLINK_MIN + (1 - MAP_SHIP_BLINK_MIN) * (0.5 + 0.5 * Math.cos(performance.now() / 1000 * Math.PI * 2 * MAP_SHIP_BLINK_HZ));
    const L = Math.max(8, px(MAP_SHIP_SIZE));
    ctx.save();
    ctx.globalAlpha = t * pulse;
    ctx.translate(Math.round(toMapX(localPlayer.x)), Math.round(toMapY(localPlayer.y)));
    ctx.rotate(localPlayer.angle);
    ctx.beginPath();
    ctx.moveTo(L * 0.6, 0);
    ctx.lineTo(-L * 0.4, L * 0.4);
    ctx.lineTo(-L * 0.15, 0);
    ctx.lineTo(-L * 0.4, -L * 0.4);
    ctx.closePath();
    ctx.fillStyle = localPlayer.color || '#ffffff';
    ctx.fill();
    ctx.restore();
  }

  // Header: title left, current chunk + coordinates right (lowercase).
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `${px(MAP_TITLE_FONT_PX)}px Ticketing`;
  ctx.textAlign = 'left';
  ctx.fillText('map', mapX, panelY + px(MAP_HEADER) - px(12));
  ctx.font = `${px(MAP_INFO_FONT_PX)}px Ticketing`;
  ctx.textAlign = 'right';
  ctx.fillText(`chunk ${cur.cx}, ${cur.cy}  ·  x ${Math.round(localPlayer.x)}  y ${Math.round(localPlayer.y)}`,
    mapX + side, panelY + px(MAP_HEADER) - px(14));

  // Hovered chunk: outline + tooltip with chunk coords and world range.
  if (worldMap.open && mouseX >= mapX && mouseX < mapX + side && mouseY >= mapY && mouseY < mapY + side) {
    const hcx = Math.floor((mouseX - mapX) / cell) + CHUNK_MIN;
    const hcy = Math.floor((mouseY - mapY) / cell) + CHUNK_MIN;
    const b = chunkBounds(hcx, hcy);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1, px(2));
    ctx.strokeRect(Math.round(cellX(hcx)) + 0.5, Math.round(cellY(hcy)) + 0.5, Math.round(cell), Math.round(cell));

    const lines = [`chunk ${hcx}, ${hcy}`, `x ${b.x0}…${b.x1}  y ${b.y0}…${b.y1}`];
    const hoverBiome = getBiomeForChunk(hcx, hcy);
    if (hoverBiome.name) lines.push(hoverBiome.name);
    ctx.font = `${px(MAP_TIP_FONT_PX)}px Ticketing`;
    const lh = px(MAP_TIP_FONT_PX) + px(4), padT = px(8);
    const tw = Math.max(...lines.map(l => ctx.measureText(l).width)) + padT * 2, th = lh * lines.length + padT * 2 - px(4);
    let tx = Math.round(mouseX + px(16)), ty = Math.round(mouseY + px(16));
    if (tx + tw > canvas.width) tx = Math.round(mouseX - px(16) - tw);
    if (ty + th > canvas.height) ty = Math.round(mouseY - px(16) - th);
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    roundRect(ctx, tx, ty, tw, th, px(8));
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1, px(2));
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, tx + padT, ty + padT + i * lh));
  }

  ctx.restore();
}

let last = performance.now();
let fpsFrames = 0, fpsTime = 0, fps = 0;
function loop(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  fpsFrames++;
  fpsTime += dt;
  if (fpsTime >= 0.5) { fps = Math.round(fpsFrames / fpsTime); fpsFrames = 0; fpsTime = 0; }
  requestAnimationFrame(loop); // scheduled first: nothing below can stop the game loop
  safeLayer('update', () => update(dt));
  guardPlayerPosition();
  safeLayer('updateBiomeWeights', () => updateBiomeWeights(dt));
  safeLayer('updateShatter', () => updateShatterEffects(dt));
  safeLayer('updateXpParticles', () => updateXpParticles(dt));
  safeLayer('updateFx', () => updateFx(dt));
  safeLayer('updateClassMenu', () => updateClassMenu(dt));
  safeLayer('updateWorldMap', () => updateWorldMap(dt));
  draw();
}
requestAnimationFrame(loop);

// --- Main menu ---

document.getElementById('btn-play').addEventListener('click', () => {
  const storedName = localStorage.getItem('starship_username');
  const nickname = storedName || document.getElementById('nickname').value.trim();
  document.getElementById('menu').style.display = 'none';
  document.getElementById('menu-topleft').style.display = 'none';
  connectToGame(nickname);
});

document.getElementById('nickname').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-play').click();
});

// --- Color picker ---
const SHIP_COLORS = [
  '#ef4444','#f97316','#eab308','#22c55e',
  '#06b6d4','#3b82f6','#a855f7','#ec4899',
  '#14b8a6','#f59e0b','#FCAFFF','#ffffff',
];

let selectedColor = localStorage.getItem('starship_color') || '#FCAFFF';
const colorBtn    = document.getElementById('btn-color');
const colorPopup  = document.getElementById('color-picker-popup');

function applyColor(c) {
  selectedColor = c;
  colorBtn.style.background = c;
  localStorage.setItem('starship_color', c);
  document.querySelectorAll('.color-swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.color === c);
  });
}

SHIP_COLORS.forEach(c => {
  const sw = document.createElement('button');
  sw.className = 'color-swatch';
  sw.dataset.color = c;
  sw.style.background = c;
  sw.addEventListener('click', () => { applyColor(c); colorPopup.classList.remove('open'); });
  colorPopup.appendChild(sw);
});

applyColor(selectedColor);

colorBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  colorPopup.classList.toggle('open');
  if (colorPopup.classList.contains('open')) {
    const rect = colorBtn.getBoundingClientRect();
    colorPopup.style.left = rect.left + 'px';
    colorPopup.style.top  = (rect.top - colorPopup.offsetHeight - 8) + 'px';
  }
});
document.addEventListener('click', () => colorPopup.classList.remove('open'));

// --- Account modal ---

const accountModal  = document.getElementById('account-modal');
const accountAuth   = document.getElementById('account-auth');
const accountLoggedIn = document.getElementById('account-loggedin');
const authError     = document.getElementById('auth-error');
const authUsername  = document.getElementById('auth-username');
const authPassword  = document.getElementById('auth-password');
const btnSubmit     = document.getElementById('btn-auth-submit');
const tabLogin      = document.getElementById('tab-login');
const tabRegister   = document.getElementById('tab-register');

let authMode = 'login';

function setAuthMode(mode) {
  authMode = mode;
  tabLogin.classList.toggle('active', mode === 'login');
  tabRegister.classList.toggle('active', mode === 'register');
  btnSubmit.textContent = mode === 'login' ? 'LOGIN' : 'REGISTER';
  authError.textContent = '';
}

function openAccountModal() {
  const token = localStorage.getItem('starship_token');
  const uname = localStorage.getItem('starship_username');
  if (token && uname) {
    accountAuth.style.display = 'none';
    accountLoggedIn.style.display = '';
    document.getElementById('account-display-name').textContent = uname;
  } else {
    accountAuth.style.display = '';
    accountLoggedIn.style.display = 'none';
  }
  accountModal.classList.add('open');
}

document.getElementById('btn-account').addEventListener('click', openAccountModal);
document.getElementById('btn-close-account').addEventListener('click', () => accountModal.classList.remove('open'));
accountModal.addEventListener('click', e => { if (e.target === accountModal) accountModal.classList.remove('open'); });

tabLogin.addEventListener('click',    () => setAuthMode('login'));
tabRegister.addEventListener('click', () => setAuthMode('register'));

btnSubmit.addEventListener('click', async () => {
  const username = authUsername.value.trim();
  const password = authPassword.value;
  authError.textContent = '';
  if (!username || !password) { authError.textContent = 'Fill in both fields.'; return; }

  const endpoint = authMode === 'login' ? '/auth/login' : '/auth/register';
  try {
    const res  = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { authError.textContent = data.error || 'Error'; return; }

    localStorage.setItem('starship_token',    data.token);
    localStorage.setItem('starship_username', data.username);

    // Update nickname field to account name
    document.getElementById('nickname').value = data.username;

    accountModal.classList.remove('open');
  } catch {
    authError.textContent = 'Network error.';
  }
});

document.getElementById('btn-logout').addEventListener('click', () => {
  localStorage.removeItem('starship_token');
  localStorage.removeItem('starship_username');
  document.getElementById('nickname').value = '';
  accountModal.classList.remove('open');
});

// Pre-fill nickname if already logged in
const savedUsername = localStorage.getItem('starship_username');
if (savedUsername) document.getElementById('nickname').value = savedUsername;

// Custom placeholder show/hide
const nicknameInput = document.getElementById('nickname');
const nicknamePlaceholder = document.getElementById('nickname-placeholder');
function syncPlaceholder() {
  nicknamePlaceholder.style.display = nicknameInput.value ? 'none' : 'block';
}
nicknameInput.addEventListener('input', syncPlaceholder);
syncPlaceholder();
