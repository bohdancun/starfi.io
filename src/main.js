const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

const shipImg = new Image();
let shipImgReady = false;
shipImg.onload = () => { shipImgReady = true; };
shipImg.src = '/textures/ships/basic_ship/shipbasic1.svg';

const shipOffscreen = document.createElement('canvas');
const shipOffCtx = shipOffscreen.getContext('2d');

const minimapFrameImg = new Image();
let minimapFrameReady = false;
minimapFrameImg.onload = () => { minimapFrameReady = true; };
minimapFrameImg.src = '/textures/minimapframe.svg';

const bulletImg = new Image();
let bulletImgReady = false;
bulletImg.onload = () => { bulletImgReady = true; };
bulletImg.src = '/textures/ships/basic_ship/shipbasic1bullet.svg';

const prototwinkImg = new Image();
let prototwinkImgReady = false;
prototwinkImg.onload = () => { prototwinkImgReady = true; };
prototwinkImg.src = '/textures/ships/prototwink/prototwink.svg';

const prototwinkShortBulletImg = new Image();
let prototwinkShortBulletImgReady = false;
prototwinkShortBulletImg.onload = () => { prototwinkShortBulletImgReady = true; };
prototwinkShortBulletImg.src = '/textures/ships/prototwink/prototwinkshortbullet.svg';

const prototwinkLongBulletImg = new Image();
let prototwinkLongBulletImgReady = false;
prototwinkLongBulletImg.onload = () => { prototwinkLongBulletImgReady = true; };
prototwinkLongBulletImg.src = '/textures/ships/prototwink/prototwinklongbullet.svg';

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

const rockImgCache = new Map(); // path → HTMLImageElement

function loadRockTexture(path) {
  if (rockImgCache.has(path)) return rockImgCache.get(path);
  const img = new Image();
  img._loaded = false;
  img.onload = () => { img._loaded = true; };
  img.src = path;
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
      if (rock.texturePath) {
        loadRockTexture(rock.texturePath);
        getRockPoly(rock.texturePath); // kick off async poly fetch
      }
    } else if (rock.angle != null) {
      cur.angle = rock.angle; // keep in sync with authoritative server angle
    }
  }
  for (const [id] of rockAppearance) {
    if (!seen.has(id)) rockAppearance.delete(id);
  }
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
const WORLD_W = 4000;
const WORLD_H = 4000;
const PLAYER_R = 30;
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

// --- Polygon collision helpers (mirrors server.js exactly) ---
function parseSvgPathD(d) {
  const verts = [];
  let cx = 0, cy = 0;
  const re = /([MLHVZ])([^MLHVZ]*)/gi;
  let m;
  while ((m = re.exec(d)) !== null) {
    const cmd = m[1].toUpperCase();
    const args = m[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if      (cmd === 'M') { cx = args[0]; cy = args[1]; verts.push([cx, cy]); }
    else if (cmd === 'L') { cx = args[0]; cy = args[1]; verts.push([cx, cy]); }
    else if (cmd === 'H') { cx = args[0];               verts.push([cx, cy]); }
    else if (cmd === 'V') {               cy = args[0]; verts.push([cx, cy]); }
    else if (cmd === 'Z') break;
  }
  return verts;
}

function convexHull(pts) {
  if (pts.length <= 3) return pts.slice();
  let l = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i][0] < pts[l][0]) l = i;
  const hull = [];
  let p = l;
  do {
    hull.push(pts[p]);
    let q = (p + 1) % pts.length;
    for (let r = 0; r < pts.length; r++) {
      const cross = (pts[q][0] - pts[p][0]) * (pts[r][1] - pts[p][1])
                  - (pts[q][1] - pts[p][1]) * (pts[r][0] - pts[p][0]);
      if (cross < 0) q = r;
    }
    p = q;
  } while (p !== l && hull.length <= pts.length);
  return hull;
}

function buildNormalizedPoly(svgText, texW, texH) {
  const dm = svgText.match(/\bd="([^"]+)"/);
  if (!dm) return null;
  const raw = parseSvgPathD(dm[1]);
  if (raw.length < 3) return null;
  const hull = convexHull(raw);
  const cx = texW / 2, cy = texH / 2;
  return hull.map(([x, y]) => [x - cx, y - cy]);
}

function worldPoly(normPoly, scale, rotAngle, px, py) {
  const ca = Math.cos(rotAngle), sa = Math.sin(rotAngle);
  return normPoly.map(([nx, ny]) => {
    const sx = nx * scale, sy = ny * scale;
    return [px + sx * ca - sy * sa, py + sx * sa + sy * ca];
  });
}

function projPoly(poly, ax, ay) {
  let lo = Infinity, hi = -Infinity;
  for (const [x, y] of poly) { const p = x * ax + y * ay; if (p < lo) lo = p; if (p > hi) hi = p; }
  return [lo, hi];
}

function satOverlapMTV(A, B) {
  let minDepth = Infinity, minNx = 0, minNy = 0;
  for (const poly of [A, B]) {
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
      let nx = -(by - ay), ny = bx - ax;
      const len = Math.hypot(nx, ny);
      if (len < 1e-10) continue;
      nx /= len; ny /= len;
      const [loA, hiA] = projPoly(A, nx, ny);
      const [loB, hiB] = projPoly(B, nx, ny);
      if (hiA < loB - 1e-10 || hiB < loA - 1e-10) return null;
      const depth = Math.min(hiA - loB, hiB - loA);
      if (depth < minDepth) { minDepth = depth; minNx = nx; minNy = ny; }
    }
  }
  return { nx: minNx, ny: minNy, depth: minDepth };
}

function satOverlap(A, B) { return satOverlapMTV(A, B) !== null; }

function ptInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Async fetch + parse SVG polygon for a given texture path (rocks — lazy per-path).
const rockPolyCache = new Map(); // texturePath → normalized poly (or null)
async function getRockPoly(texturePath) {
  if (rockPolyCache.has(texturePath)) return rockPolyCache.get(texturePath);
  try {
    const resp = await fetch(texturePath);
    const svg = await resp.text();
    // Size comes from the folder: /textures/rocks/<size>/<file>.svg (mirrors server loader).
    const fm = texturePath.match(/\/rocks\/(\d+)\//);
    const size = fm ? parseInt(fm[1]) : 128;
    const poly = buildNormalizedPoly(svg, size, size);
    rockPolyCache.set(texturePath, poly);
    return poly;
  } catch { rockPolyCache.set(texturePath, null); return null; }
}

// Ship polys (fetched once at startup, keyed by shipType).
const shipPolyCache = new Map(); // shipType → { poly, texW }
async function loadShipPolyClient(shipType, svgPath) {
  if (shipPolyCache.has(shipType)) return;
  try {
    const resp = await fetch(svgPath);
    const svg = await resp.text();
    const wm = svg.match(/width="(\d+)"/);
    const texW = wm ? parseInt(wm[1]) : 128;
    const poly = buildNormalizedPoly(svg, texW, texW);
    shipPolyCache.set(shipType, { poly, texW });
  } catch { shipPolyCache.set(shipType, null); }
}
// Prefetch ship polygons in background.
loadShipPolyClient('basic',      '/textures/ships/basic_ship/shipbasic1.svg');
loadShipPolyClient('prototwink', '/textures/ships/prototwink/prototwink.svg');

const FIRE_COOLDOWN = 0.25;
const MINIMAP_SIZE = 144;

// --- Ship/bullet type mirrors (must match server) ---
// Bullet types used by muzzle-based ships (prototwink).
const BULLET_TYPES_CLIENT = {
  short: { speed: 600, damage: 18 },
  long:  { speed: 850, damage: 35 },
};
// Muzzle layouts for ships that use the muzzles[] system.
const SHIP_MUZZLES_CLIENT = {
  prototwink: [
    { x: -12, y: 0, bulletType: 'short' },
    { x:  12, y: 0, bulletType: 'short' },
    { x: -52, y: 0, bulletType: 'long'  },
    { x:  52, y: 0, bulletType: 'long'  },
  ],
};
const MINIMAP_HALF_WORLD = 1000;
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

function torusDelta(a, b, size) {
  let d = a - b;
  if (d > size / 2) d -= size;
  if (d < -size / 2) d += size;
  return d;
}

// --- WebSocket ---

let connected = false;
let myId = null;
let ws = null;
let ping = 0;
let pingT = 0;
let pingInterval = null;

function connectToGame(nickname) {
  localPlayer.nickname = nickname || 'Player';

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token    = localStorage.getItem('starship_token') || '';
  const params   = new URLSearchParams();
  if (token) params.set('token', token);
  params.set('color', selectedColor);
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
  x: WORLD_W / 2, y: WORLD_H / 2,
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
  fireCooldown: 0,
  shipType: 'basic',
  upgrades: Object.fromEntries(UPGRADE_DEFS_CLIENT.map(d => [d.id, 0])),
  turnSpeed: TURN_SPEED,
};

let deathPoint = null;
let prevDead = false;
let shipChoiceOptions = null; // non-null while the ship-choice overlay is pending

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
  const upgradeIdx = parseInt(e.key) - 1;
  if (upgradeIdx >= 0 && upgradeIdx < UPGRADE_DEFS_CLIENT.length) {
    sendUpgrade(UPGRADE_DEFS_CLIENT[upgradeIdx].id);
    upgradeFlashTime[upgradeIdx] = performance.now();
  }
  if (e.key === 'u' || e.key === 'U') {
    upgradeBarHidden = !upgradeBarHidden;
  }
  keys.add(e.key.toLowerCase());
  if (e.key === ' ') e.preventDefault();
});
window.addEventListener("keyup", e => keys.delete(e.key.toLowerCase()));

let mouseX = canvas.width / 2;
let mouseY = canvas.height / 2;
let leftMouseDown = false;
let rightMouseDown = false;
let pendingShoot = false;
let aimAngle = 0;
let currentThrust = 0;

window.addEventListener("mousemove", e => {
  mouseX = e.clientX;
  mouseY = e.clientY;
  aimAngle = Math.atan2(mouseY - canvas.height / 2, mouseX - canvas.width / 2);
});
window.addEventListener("contextmenu", e => e.preventDefault());
window.addEventListener("mousedown", e => {
  if (e.button === 0) leftMouseDown = true;
  if (e.button === 2) rightMouseDown = true;
});
window.addEventListener("mouseup", e => {
  if (e.button === 0) leftMouseDown = false;
  if (e.button === 2) rightMouseDown = false;
});

// --- Server messages ---

function handleMessage(event) {
  const msg = JSON.parse(event.data);

  if (msg.type === 'init') {
    myId = msg.id;
    localPlayer.x = msg.x;
    localPlayer.y = msg.y;
    localPlayer.color = msg.color;
    serverRocks = msg.rocks;
    serverGems = msg.gems;
    syncRockAppearance(serverRocks);
    for (const p of msg.players) {
      if (p.id !== myId) remotePlayers.set(p.id, p);
    }
  }

  else if (msg.type === 'tick') {
    if (msg.rocks   !== undefined) { serverRocks = msg.rocks; syncRockAppearance(serverRocks); }
    if (msg.gems    !== undefined) serverGems    = msg.gems;
    if (msg.xpDrops !== undefined) serverXpDrops = msg.xpDrops || [];

    // Merge bullets — preserve existing extrapolated positions for bullets we already know
    if (msg.bullets) {
      const incoming = new Map(msg.bullets.map(b => [b.id, b]));
      serverBullets = msg.bullets.map(b => {
        const old = serverBullets.find(ob => ob.id === b.id);
        return old ? { ...b, x: old.x, y: old.y } : b;
      });
    }

    const seen = new Set();
    for (const p of msg.players) {
      if (p.id === myId) {
        localPlayer.x += torusDelta(p.x, localPlayer.x, WORLD_W) * 0.15;
        localPlayer.y += torusDelta(p.y, localPlayer.y, WORLD_H) * 0.15;
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
          renderX: existing ? existing.renderX : p.x,
          renderY: existing ? existing.renderY : p.y,
        });
        seen.add(p.id);
      }
    }
    for (const [id] of remotePlayers) {
      if (!seen.has(id)) remotePlayers.delete(id);
    }
  }

  else if (msg.type === 'shipChoice') {
    shipChoiceOptions = msg.options;
  }

  else if (msg.type === 'pong') {
    ping = Math.round(performance.now() - pingT);
  }

  else if (msg.type === 'playerLeft') {
    remotePlayers.delete(msg.id);
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

  ws.send(JSON.stringify({
    type: 'input',
    angle: aimAngle,
    thrust: currentThrust,
    shoot: pendingShoot,
  }));

  pendingShoot = false;
}

// --- Client-side collision prediction (mirrors server checkPlayerRockCollisions, no damage) ---

let _prevContactNormalsClient = new Map(); // rock.id → { nx, ny }
let _curContactNormalsClient  = new Map();

function checkLocalPlayerRockCollisions() {
  _curContactNormalsClient = new Map();

  for (const rock of serverRocks) {
    const cdx = torusDelta(localPlayer.x, rock.x, WORLD_W);
    const cdy = torusDelta(localPlayer.y, rock.y, WORLD_H);
    const dist = Math.hypot(cdx, cdy);
    const minDist = PLAYER_R + rock.r;

    if (dist >= minDist || dist <= 0) continue;

    // Narrow phase: derive contact normal + penetration depth from polygon MTv.
    const shipType     = localPlayer.shipType || 'basic';
    const shipEntry    = shipPolyCache.get(shipType) ?? shipPolyCache.get('basic');
    const rockNormPoly = rockPolyCache.get(rock.texturePath);
    const rockAngle    = (rockAppearance.get(rock.id)?.angle) ?? 0;

    let nx, ny, overlap;
    if (shipEntry?.poly && rockNormPoly) {
      const shipScale = (PLAYER_R * 2) / shipEntry.texW;
      const shipP = worldPoly(shipEntry.poly, shipScale, localPlayer.angle + Math.PI / 2, cdx, cdy);
      const rockP = worldPoly(rockNormPoly,   1.0,       rockAngle,                       0,   0);
      const mtv = satOverlapMTV(shipP, rockP);
      if (!mtv) continue;

      if (mtv.nx * cdx + mtv.ny * cdy < 0) { mtv.nx = -mtv.nx; mtv.ny = -mtv.ny; }

      // Stabilize normal (mirrors server logic).
      const prev = _prevContactNormalsClient.get(rock.id);
      if (prev && prev.nx * mtv.nx + prev.ny * mtv.ny > 0.9) {
        mtv.nx = prev.nx; mtv.ny = prev.ny;
      }
      _curContactNormalsClient.set(rock.id, { nx: mtv.nx, ny: mtv.ny });

      nx = mtv.nx; ny = mtv.ny; overlap = mtv.depth;
    } else {
      nx = cdx / dist; ny = cdy / dist; overlap = minDist - dist;
    }

    const mP = PLAYER_R * PLAYER_R;
    const mR = rock.r * rock.r;
    const invSum = 1 / (mP + mR);

    localPlayer.x = ((localPlayer.x + nx * overlap * (mR * invSum)) % WORLD_W + WORLD_W) % WORLD_W;
    localPlayer.y = ((localPlayer.y + ny * overlap * (mR * invSum)) % WORLD_H + WORLD_H) % WORLD_H;

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

  _prevContactNormalsClient = _curContactNormalsClient;
}

// --- Client-side prediction ---

function update(dt) {
  if (localPlayer.dead || myId === null) {
    inputTimer += dt;
    if (inputTimer >= INPUT_INTERVAL) { sendInput(); inputTimer = 0; }
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

  // Shoot
  if (localPlayer.fireCooldown > 0) localPlayer.fireCooldown -= dt;
  if ((leftMouseDown || keys.has(' ')) && localPlayer.fireCooldown <= 0) {
    pendingShoot = true;
    localPlayer.fireCooldown = FIRE_COOLDOWN;
  }

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

  localPlayer.x += localPlayer.vx * dt;
  localPlayer.y += localPlayer.vy * dt;
  if (localPlayer.x < 0) localPlayer.x += WORLD_W;
  else if (localPlayer.x > WORLD_W) localPlayer.x -= WORLD_W;
  if (localPlayer.y < 0) localPlayer.y += WORLD_H;
  else if (localPlayer.y > WORLD_H) localPlayer.y -= WORLD_H;

  inputTimer += dt;
  if (inputTimer >= INPUT_INTERVAL) { sendInput(); inputTimer = 0; }

  // Interpolate remote players toward server-authoritative position
  for (const [, p] of remotePlayers) {
    if (p.renderX === undefined) { p.renderX = p.x; p.renderY = p.y; continue; }
    p.renderX += torusDelta(p.x, p.renderX, WORLD_W) * Math.min(1, 14 * dt);
    p.renderY += torusDelta(p.y, p.renderY, WORLD_H) * Math.min(1, 14 * dt);
  }

  // Extrapolate bullets client-side
  for (const b of serverBullets) {
    b.x = ((b.x + b.vx * dt) % WORLD_W + WORLD_W) % WORLD_W;
    b.y = ((b.y + b.vy * dt) % WORLD_H + WORLD_H) % WORLD_H;
  }

  // Extrapolate gems with drag
  for (const g of serverGems) {
    if (g.vx === undefined) continue;
    g.x = ((g.x + g.vx * dt) % WORLD_W + WORLD_W) % WORLD_W;
    g.y = ((g.y + g.vy * dt) % WORLD_H + WORLD_H) % WORLD_H;
    g.vx *= Math.exp(-3 * dt);
    g.vy *= Math.exp(-3 * dt);
  }

  // Extrapolate xp drops with drag
  for (const x of serverXpDrops) {
    if (x.vx === undefined) continue;
    x.x = ((x.x + x.vx * dt) % WORLD_W + WORLD_W) % WORLD_W;
    x.y = ((x.y + x.vy * dt) % WORLD_H + WORLD_H) % WORLD_H;
    x.vx *= Math.exp(-3 * dt);
    x.vy *= Math.exp(-3 * dt);
  }

  // Extrapolate rocks with drag
  for (const r of serverRocks) {
    if (!r.vx && !r.vy) continue;
    r.x = ((r.x + r.vx * dt) % WORLD_W + WORLD_W) % WORLD_W;
    r.y = ((r.y + r.vy * dt) % WORLD_H + WORLD_H) % WORLD_H;
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
const CHEATS = ['hesoyam'];
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

function drawXpBar(centerX, topY, radius, totalXp) {
  const { level, progress } = getLevelInfo(totalXp);
  const w = Math.max(34, radius * 2.2);
  const h = 6;
  const x = centerX - w / 2;

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
}

function getShipAsset(shipType) {
  if (shipType === 'prototwink') return { img: prototwinkImg, ready: prototwinkImgReady };
  return { img: shipImg, ready: shipImgReady };
}

function drawShip(sx, sy, angle, color, r, shipType) {
  const { img, ready } = getShipAsset(shipType);
  // Maintain the sprite's aspect ratio; width is always r*2 to match hitbox.
  const drawW = r * 2;
  const drawH = img.naturalHeight && img.naturalWidth
    ? drawW * img.naturalHeight / img.naturalWidth
    : drawW;

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

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(angle + Math.PI / 2);
    ctx.drawImage(shipOffscreen, -drawW / 2, -drawH / 2);
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

function drawRocks(camX, camY) {
  for (const rock of serverRocks) {
    const dx = torusDelta(rock.x, camX, WORLD_W);
    const dy = torusDelta(rock.y, camY, WORLD_H);
    const sx = canvas.width / 2 + dx;
    const sy = canvas.height / 2 + dy;

    const margin = rock.r + 40;
    if (sx < -margin || sx > canvas.width + margin || sy < -margin || sy > canvas.height + margin) continue;

    const drawSize = rock.r * 2;
    const angle = rockAppearance.get(rock.id)?.angle ?? 0;

    // Lazy-loaded on first sight; skip drawing until the image is ready.
    const img = rock.texturePath ? loadRockTexture(rock.texturePath) : null;
    if (!img || !img._loaded) continue;

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(angle);
    ctx.drawImage(img, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
    ctx.restore();
  }
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

function getBulletAsset(variant) {
  const s = PLAYER_R * 2 / 128;
  if (variant === 'short') return { img: prototwinkShortBulletImg, ready: prototwinkShortBulletImgReady, bw: 24 * s, bh: 32 * s };
  if (variant === 'long')  return { img: prototwinkLongBulletImg,  ready: prototwinkLongBulletImgReady,  bw: 24 * s, bh: 56 * s };
  return { img: bulletImg, ready: bulletImgReady, bw: 24 * s, bh: 32 * s };
}

function drawBullets(camX, camY) {
  for (const b of serverBullets) {
    const dx = torusDelta(b.x, camX, WORLD_W);
    const dy = torusDelta(b.y, camY, WORLD_H);
    const sx = canvas.width  / 2 + dx;
    const sy = canvas.height / 2 + dy;

    const { img, ready, bw, bh } = getBulletAsset(b.variant);
    if (ready) {
      const color = b.ownerId === myId
        ? localPlayer.color
        : (remotePlayers.get(b.ownerId)?.color ?? '#ffffff');
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate((b.angle ?? 0) + Math.PI / 2);
      ctx.drawImage(img, -bw / 2, -bh / 2, bw, bh);
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = color;
      ctx.fillRect(-bw / 2, -bh / 2, bw, bh);
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(sx, sy, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#fde047';
      ctx.fill();
    }
  }
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

    const margin = PLAYER_R + 60;
    if (sx < -margin || sx > canvas.width + margin || sy < -margin || sy > canvas.height + margin) continue;

    drawShip(sx, sy, p.angle, p.color, PLAYER_R, p.shipType);
    const hpTopY = sy - PLAYER_R - 12;
    drawNickname(sx, hpTopY, p.name || 'Player');
    drawHealthBar(sx, hpTopY, PLAYER_R, p.hp, p.maxHp);
    drawXpBar(sx, sy + PLAYER_R + 6, PLAYER_R, p.totalXpEarned ?? 0);
  }
}

function drawMinimap() {
  const mx = canvas.width  - CORNER_PAD - MINIMAP_SIZE;
  const my = canvas.height - CORNER_PAD - MINIMAP_SIZE;
  const half = MINIMAP_SIZE / 2;
  const scale = half / MINIMAP_HALF_WORLD;

  const camX = localPlayer.x;
  const camY = localPlayer.y;

  // Track death point transitions
  if (localPlayer.dead && !prevDead) deathPoint = { x: localPlayer.x, y: localPlayer.y };
  if (!localPlayer.dead && prevDead) deathPoint = null;
  prevDead = localPlayer.dead;

  // Background
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(mx, my, MINIMAP_SIZE, MINIMAP_SIZE);

  // Clip contents to rounded frame shape
  ctx.save();
  roundRect(ctx, mx + 4, my + 4, MINIMAP_SIZE - 8, MINIMAP_SIZE - 8, 12);
  ctx.clip();

  // Rocks
  for (const rock of serverRocks) {
    const dx = torusDelta(rock.x, camX, WORLD_W);
    const dy = torusDelta(rock.y, camY, WORLD_H);
    const sx = mx + half + dx * scale;
    const sy = my + half + dy * scale;
    if (sx < mx || sx > mx + MINIMAP_SIZE || sy < my || sy > my + MINIMAP_SIZE) continue;
    const rr = Math.min(6, Math.max(2, rock.r * scale));
    ctx.beginPath();
    ctx.arc(sx, sy, rr, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }

  // Remote players
  for (const [, p] of remotePlayers) {
    if (p.dead) continue;
    const dx = torusDelta(p.x, camX, WORLD_W);
    const dy = torusDelta(p.y, camY, WORLD_H);
    const sx = mx + half + dx * scale;
    const sy = my + half + dy * scale;
    if (sx < mx || sx > mx + MINIMAP_SIZE || sy < my || sy > my + MINIMAP_SIZE) continue;
    ctx.beginPath();
    ctx.arc(sx, sy, 3, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
  }

  // Self
  ctx.beginPath();
  ctx.arc(mx + half, my + half, 4, 0, Math.PI * 2);
  ctx.fillStyle = localPlayer.color || '#ffffff';
  ctx.fill();

  // Death point (inside minimap)
  if (deathPoint) {
    const ddx = torusDelta(deathPoint.x, camX, WORLD_W);
    const ddy = torusDelta(deathPoint.y, camY, WORLD_H);
    const dsx = mx + half + ddx * scale;
    const dsy = my + half + ddy * scale;
    if (dsx >= mx && dsx <= mx + MINIMAP_SIZE && dsy >= my && dsy <= my + MINIMAP_SIZE) {
      ctx.beginPath();
      ctx.arc(dsx, dsy, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ef4444';
      ctx.fill();
    }
  }

  ctx.restore();

  // Frame
  if (minimapFrameReady) {
    ctx.drawImage(minimapFrameImg, mx, my, MINIMAP_SIZE, MINIMAP_SIZE);
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
    const dsx = mx + half + ddx * scale;
    const dsy = my + half + ddy * scale;
    const outside = dsx < mx || dsx > mx + MINIMAP_SIZE || dsy < my || dsy > my + MINIMAP_SIZE;
    if (outside) {
      const angle = Math.atan2(ddy, ddx);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const margin = 5;
      let t = Infinity;
      if (cos > 0)  t = Math.min(t, (half - margin) / cos);
      if (cos < 0)  t = Math.min(t, (-half + margin) / cos);
      if (sin > 0)  t = Math.min(t, (half - margin) / sin);
      if (sin < 0)  t = Math.min(t, (-half + margin) / sin);
      const ex = mx + half + cos * t;
      const ey = my + half + sin * t;
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
  ctx.fillText(`Players online: ${remotePlayers.size + 1}`, pad, pad + 84);

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

function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const camX = localPlayer.x;
  const camY = localPlayer.y;
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
          ctx.fillStyle = `rgba(200,210,255,${a})`;
          ctx.fill();
        }
      }
    }
  }
  drawShootingStars(camX, camY);

  if (!connected || myId === null) {
    drawConnecting();
    return;
  }

  drawRocks(camX, camY);
  drawGems(camX, camY);
  drawXpDrops(camX, camY);
  drawBullets(camX, camY);
  drawRemotePlayers(camX, camY);

  if (!localPlayer.dead) {
    const cx = canvas.width / 2, cy = canvas.height / 2;
    drawShip(cx, cy, localPlayer.angle, localPlayer.color, PLAYER_R, localPlayer.shipType);
    const hpTopY = cy - PLAYER_R - 12;
    drawNickname(cx, hpTopY, localPlayer.nickname || 'Player');
    drawHealthBar(cx, hpTopY, PLAYER_R, localPlayer.hp, localPlayer.maxHp);
    drawXpBar(cx, cy + PLAYER_R + 6, PLAYER_R, localPlayer.totalXpEarned);
  }

  drawHUD();
  drawUpgradeBar();
  drawMinimap();

  if (localPlayer.dead) drawDeathScreen();
  if (shipChoiceOptions) drawShipChoiceOverlay();
}

// --- Ship choice overlay ---
// DEV TEST: triggered at level 5 (temporary low threshold).

const SHIP_LABELS = { prototwink: 'Prototwink' };
const SHIP_CHOICE_BTN_W = 200;
const SHIP_CHOICE_BTN_H = 48;

function shipChoiceBtnRect(i) {
  return {
    x: canvas.width  / 2 - SHIP_CHOICE_BTN_W / 2,
    y: canvas.height / 2 - 10 + i * (SHIP_CHOICE_BTN_H + 12),
    w: SHIP_CHOICE_BTN_W,
    h: SHIP_CHOICE_BTN_H,
  };
}

function drawShipChoiceOverlay() {
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.font = '22px Ticketing';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillText('Choose Your Ship', canvas.width / 2, canvas.height / 2 - 56);

  for (let i = 0; i < shipChoiceOptions.length; i++) {
    const { x, y, w, h } = shipChoiceBtnRect(i);
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#60a5fa';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.font = '18px Ticketing';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(SHIP_LABELS[shipChoiceOptions[i]] ?? shipChoiceOptions[i], x + w / 2, y + h / 2);
  }
}

canvas.addEventListener('click', e => {
  if (!shipChoiceOptions) return;
  for (let i = 0; i < shipChoiceOptions.length; i++) {
    const { x, y, w, h } = shipChoiceBtnRect(i);
    if (e.clientX >= x && e.clientX <= x + w && e.clientY >= y && e.clientY <= y + h) {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'selectShip', shipId: shipChoiceOptions[i] }));
      shipChoiceOptions = null;
    }
  }
});

let last = performance.now();
let fpsFrames = 0, fpsTime = 0, fps = 0;
function loop(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  fpsFrames++;
  fpsTime += dt;
  if (fpsTime >= 0.5) { fps = Math.round(fpsFrames / fpsTime); fpsFrames = 0; fpsTime = 0; }
  update(dt);
  draw();
  requestAnimationFrame(loop);
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
