import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT       = process.env.PORT       || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const DB_PATH    = process.env.DB_PATH    || join(__dirname, 'game.db');

const TICK_RATE = 60;
const DT = 1 / TICK_RATE;

const WORLD_W = 4000;
const WORLD_H = 4000;

// --- Database ---
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS player_data (
    user_id        INTEGER PRIMARY KEY REFERENCES users(id),
    level          INTEGER DEFAULT 1,
    total_xp       INTEGER DEFAULT 0,
    upgrade_points INTEGER DEFAULT 0,
    gold           INTEGER DEFAULT 0,
    xp_count       INTEGER DEFAULT 0,
    upgrades       TEXT DEFAULT '{}',
    updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// --- Ship type stencils ---
const SHIP_TYPES = {
  basic: {
    name: 'Basic',
    r: 30,
    maxHp: 100,
    regenRate: 6,
    regenDelay: 2.0,
    fireCooldown: 0.25,
    bulletSpeed: 1000,
    bulletDamage: 12.5,
    maxSpeed: 650,
    accel: 900,
    fwdDrag: 0.8,
    latDrag: 7.0,
    turnSpeed: 3.0,
    bodyDamageScale: 1.0,
    collisionShieldFrac: 0.0,
    collisionPunchMult: 1.0,
    // Gun positions in world units derived from sprite coords:
    // sprite x=28 → side=-16.875, sprite x=100 → side=+16.875 (36 px × 60/128)
    guns: [
      { side: -16.875, forward: 0 },
      { side:  16.875, forward: 0 },
    ],
  },

  // TEST SHIP — offered at level 5 as a dev/test trigger (low threshold, temporary).
  // Real class-tree gates are at levels 15/35 and not yet wired.
  prototwink: {
    name: 'Prototwink',
    r: 30,
    maxHp: 100,
    regenRate: 6,
    regenDelay: 2.0,
    fireCooldown: 0.25,
    bulletSpeed: 700,   // unused — muzzles[] overrides per-bullet speed/damage
    bulletDamage: 25,
    maxSpeed: 650,
    accel: 900,
    fwdDrag: 0.8,
    latDrag: 7.0,
    turnSpeed: 3.0,
    bodyDamageScale: 1.0,
    collisionShieldFrac: 0.0,
    collisionPunchMult: 1.0,
    // Sprite: 128×144, center at (64, 72).
    // x=pixel offset from center (positive = sprite-right); y=0 = center line.
    // Short guns (x=52/76 in sprite → ±12 from center).
    // Long guns (x=12/116 in sprite → ±52 from center).
    muzzles: [
      { x: -12, y: 0, bulletType: 'short' },
      { x:  12, y: 0, bulletType: 'short' },
      { x: -52, y: 0, bulletType: 'long'  },
      { x:  52, y: 0, bulletType: 'long'  },
    ],
  },
};

// --- Upgrade system ---
const MAX_UPGRADE_LEVEL = 6;
const UPGRADE_XP_PER_LEVEL = 50;

const UPGRADE_IDS = [
  'healthCap', 'healthRegen', 'bulletReload', 'bulletSpeed',
  'bulletDamage', 'shipSpeed', 'shipAgility', 'bodyDamage', 'collisionShield',
];

function computeStats(p) {
  const base = SHIP_TYPES[p.shipType] || SHIP_TYPES.basic;
  const L = k => p.upgrades[k] || 0;
  return {
    r: base.r,
    maxHp:               Math.round(base.maxHp * (1 + L('healthCap') * 0.20)),
    regenRate:           base.regenRate * (1 + L('healthRegen') * 0.35),
    regenDelay:          base.regenDelay * Math.max(0.15, 1 - L('healthRegen') * 0.12),
    fireCooldown:        base.fireCooldown / (1 + L('bulletReload') * 0.20),
    bulletSpeed:         base.bulletSpeed * (1 + L('bulletSpeed') * 0.15),
    bulletDamage:        base.bulletDamage * (1 + L('bulletDamage') * 0.20),
    maxSpeed:            base.maxSpeed * (1 + L('shipSpeed') * 0.12),
    accel:               base.accel * (1 + L('shipSpeed') * 0.10),
    fwdDrag:             base.fwdDrag,
    latDrag:             base.latDrag * Math.max(0.3, 1 - L('shipAgility') * 0.09),
    turnSpeed:           base.turnSpeed * (1 + L('shipAgility') * 0.15),
    bodyDamageScale:     base.bodyDamageScale * (1 + L('bodyDamage') * 0.50),
    collisionShieldFrac: Math.min(0.60, L('collisionShield') * 0.08),
    collisionPunchMult:  1 + L('collisionShield') * 0.20,
  };
}

// --- Level & upgrade point system ---
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

function getLevel(totalXp) {
  for (let i = 0; i < MAX_LEVEL - 1; i++)
    if (totalXp < LEVEL_THRESHOLDS[i + 1]) return i + 1;
  return MAX_LEVEL;
}

// Returns the shortest signed angle from `from` to `to` in [-π, π].
function shortestAngleDelta(from, to) {
  let diff = (to - from) % (Math.PI * 2);
  if (diff > Math.PI)  diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

// --- Polygon collision helpers (broad=circle, narrow=SAT / segment-poly) ---
// All functions operate on flat arrays of [x,y] pairs in world / local space.

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

// Parse SVG text → normalized polygon centered at (texW/2, texH/2).
function buildNormalizedPoly(svgText, texW, texH) {
  const dm = svgText.match(/\bd="([^"]+)"/);
  if (!dm) return null;
  const raw = parseSvgPathD(dm[1]);
  if (raw.length < 3) return null;
  const hull = convexHull(raw);
  const cx = texW / 2, cy = texH / 2;
  return hull.map(([x, y]) => [x - cx, y - cy]);
}

// Transform a normalized polygon to world/local space.
// rotAngle: p.angle + PI/2 for ships, rock.angle for rocks.
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

// SAT with MTv — returns null (separated) or { nx, ny, depth } (minimum translation vector).
// nx,ny are a unit normal; sign is not yet determined — caller flips based on desired direction.
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

// Bool wrapper used by rock-rock collision (keeps circle physics response).
function satOverlap(A, B) { return satOverlapMTV(A, B) !== null; }

function ptInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segSeg(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1x = bx - ax, d1y = by - ay, d2x = dx - cx, d2y = dy - cy;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-10) return false;
  const t = ((cx - ax) * d2y - (cy - ay) * d2x) / denom;
  const u = ((cx - ax) * d1y - (cy - ay) * d1x) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

// Minimum distance from point (px,py) to segment (ax,ay)→(bx,by).
function ptSegDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-10) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / len2));
  return Math.hypot(px - (ax + t * abx), py - (ay + t * aby));
}

// Minimum edge-to-edge distance between two convex polygons (0 if overlapping).
function polyPolyDist(A, B) {
  if (satOverlapMTV(A, B) !== null) return 0;
  let minD = Infinity;
  for (const [px, py] of A) {
    for (let i = 0; i < B.length; i++) {
      const [bx, by] = B[i], [cx, cy] = B[(i + 1) % B.length];
      const d = ptSegDist(px, py, bx, by, cx, cy);
      if (d < minD) minD = d;
    }
  }
  for (const [px, py] of B) {
    for (let i = 0; i < A.length; i++) {
      const [ax, ay] = A[i], [cx, cy] = A[(i + 1) % A.length];
      const d = ptSegDist(px, py, ax, ay, cx, cy);
      if (d < minD) minD = d;
    }
  }
  return minD;
}

// Segment (x0,y0)→(x1,y1) vs closed polygon — catches tunnelling bullets.
function segIntersectsPoly(x0, y0, x1, y1, poly) {
  if (ptInPoly(x0, y0, poly) || ptInPoly(x1, y1, poly)) return true;
  for (let i = 0; i < poly.length; i++) {
    const [px, py] = poly[i], [qx, qy] = poly[(i + 1) % poly.length];
    if (segSeg(x0, y0, x1, y1, px, py, qx, qy)) return true;
  }
  return false;
}

// --- Network optimisation constants ---
const VIEW_RANGE = 1600; // world units sent to each client
const NET_RATE   = 2;    // send every Nth physics tick → 30 Hz
const SLOW_RATE  = 4;    // rocks/gems/xp every Nth → 15 Hz
let   physTick   = 0;

// --- Rock texture manifest ---
// One subfolder per size: public/textures/rocks/<size>/*.svg (folder name = texture width in px).
const ROCK_DIR = join(__dirname, 'public/textures/rocks');

function loadRockTexture(folder, file, r) {
  const size = r * 2;
  const src = readFileSync(join(ROCK_DIR, folder, file), 'utf8');
  const poly = buildNormalizedPoly(src, size, size);
  return { path: `/textures/rocks/${folder}/${file}`, r, poly, texSize: size };
}

const ROCK_SIZES = readdirSync(ROCK_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && /^\d+$/.test(d.name))
  .map(d => {
    const size = parseInt(d.name);
    const r = size / 2;
    const textures = readdirSync(join(ROCK_DIR, d.name))
      .filter(f => f.endsWith('.svg'))
      .sort()
      .map(f => loadRockTexture(d.name, f, r));
    return { size, r, textures };
  })
  .filter(s => s.textures.length > 0)
  .sort((a, b) => a.size - b.size);

const ROCK_TEXTURES = ROCK_SIZES.flatMap(s => s.textures);

// O(1) lookup: texturePath → rock tex entry (poly, r, texSize)
const rockTexByPath = new Map(ROCK_TEXTURES.map(t => [t.path, t]));

// Ship polygons keyed by shipType string, loaded once at startup.
function loadShipPoly(relPath) {
  try {
    const src = readFileSync(join(__dirname, 'public', relPath), 'utf8');
    const wm = src.match(/width="(\d+)"/);
    const hm = src.match(/height="(\d+)"/);
    const texW = wm ? parseInt(wm[1]) : 128;
    const texH = hm ? parseInt(hm[1]) : texW;
    const poly = buildNormalizedPoly(src, texW, texH);
    return { poly, texW, texH };
  } catch { return null; }
}
const SHIP_POLYS = {
  basic:      loadShipPoly('textures/ships/basic_ship/shipbasic1.svg'),
  prototwink: loadShipPoly('textures/ships/prototwink/prototwink.svg'),
};

console.log(`Loaded ${ROCK_TEXTURES.length} rock textures in ${ROCK_SIZES.length} sizes:`);
for (const s of ROCK_SIZES) {
  const polys = s.textures.map(t => `${t.path.split('/').pop()}=${t.poly ? t.poly.length + 'pts' : 'none'}`);
  console.log(`  size=${s.size} r=${s.r} variants=${s.textures.length} [${polys.join(', ')}]`);
}

// --- World constants ---
const PLAYER_R = 30;
const SPAWN_CLEARANCE = 64; // px of edge-to-edge gap required between ship hull and any rock hull

const ROCK_COUNT = 100;
const ROCK_DRAG = 1.8;
const ROCK_MAX_SPEED = 220;
const COLLISION_DAMAGE_SCALE = 0.06;
const COLLISION_MIN_DAMAGE = 2;
const COLLISION_PLAYER_DMG_MULT = 0.15; // share of collision damage the player takes
const COLLISION_ROCK_DMG_DIV = 3;       // collision damage dealt to rocks is divided by this

// Rock loot scales with how many basic-ship bullets the rock takes to kill.
const GOLD_PER_BULLET = 0.9;
const XP_PER_BULLET   = 0.35;
const BULLET_LIFE = 0.85;

// Per-bullet-type balance (used by muzzle-based ships like prototwink).
// long must remain faster AND higher damage than short.
const BULLET_TYPES = {
  short: { speed: 600, damage: 18, life: BULLET_LIFE },
  long:  { speed: 850, damage: 35, life: BULLET_LIFE },
};
const RESPAWN_TIME = 3.0;

const GEM_RADIUS = 6;
const GEM_DESPAWN = 20;
const GEM_MAGNET_RADIUS = 220;
const GEM_MAGNET_FORCE = 900;

const XP_RADIUS = 5;
const XP_DESPAWN = 25;
const XP_MAGNET_RADIUS = 400;
const XP_MAGNET_FORCE = 1800;

const PLAYER_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#3b82f6', '#a855f7', '#ec4899',
  '#14b8a6', '#f59e0b',
];

let nextId = 1;
let nextRockId = 1;
let nextGemId = 1;
let nextXpId = 1;
let nextBulletId = 1;

const players = new Map();
const rocks = [];
const gems = [];
const xpDrops = [];
const bullets = [];

// --- helpers ---

function rand(min, max) { return Math.random() * (max - min) + min; }

function torusDelta(a, b, size) {
  let d = a - b;
  if (d > size / 2) d -= size;
  if (d < -size / 2) d += size;
  return d;
}

function torusDist(x1, y1, x2, y2) {
  return Math.hypot(torusDelta(x1, x2, WORLD_W), torusDelta(y1, y2, WORLD_H));
}

function wrapX(x) { return ((x % WORLD_W) + WORLD_W) % WORLD_W; }
function wrapY(y) { return ((y % WORLD_H) + WORLD_H) % WORLD_H; }
function wsReady(ws) { return ws.readyState === 1; }

function send(ws, data) {
  if (wsReady(ws)) ws.send(JSON.stringify(data));
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const [, p] of players) {
    if (wsReady(p.ws)) p.ws.send(msg);
  }
}

// --- rock / gem / xp spawning ---

// Spawn weight per size folder (not per variant): small rocks are more common.
function rockSizeWeight(r) {
  if (r <= 48) return 1.5;
  if (r <= 88) return 1.0;
  return 0.7;
}

function pickRockSize() {
  let total = 0;
  for (const s of ROCK_SIZES) total += rockSizeWeight(s.r);
  let roll = Math.random() * total;
  for (const s of ROCK_SIZES) {
    roll -= rockSizeWeight(s.r);
    if (roll < 0) return s;
  }
  return ROCK_SIZES[ROCK_SIZES.length - 1];
}

function spawnRock() {
  const sizeEntry = pickRockSize();
  const tex = sizeEntry.textures[Math.floor(Math.random() * sizeEntry.textures.length)];
  const r = tex.r;
  const texturePath = tex.path;
  const maxHp = Math.round(r * r / 64 + r / 2);

  let x = rand(0, WORLD_W);
  let y = rand(0, WORLD_H);
  for (let tries = 0; tries < 200; tries++) {
    x = rand(0, WORLD_W);
    y = rand(0, WORLD_H);
    let ok = true;
    for (const [, p] of players) {
      if (!p.dead && torusDist(x, y, p.x, p.y) < 300 + r + PLAYER_R) {
        ok = false;
        break;
      }
    }
    if (ok) break;
  }

  const angle = Math.random() * Math.PI * 2;
  return { id: nextRockId++, x, y, r, texturePath, maxHp, hp: maxHp, vx: 0, vy: 0, angle };
}

function serializeRock(rock) {
  return {
    id: rock.id, x: rock.x, y: rock.y, r: rock.r,
    hp: rock.hp, maxHp: rock.maxHp, vx: rock.vx, vy: rock.vy,
    texturePath: rock.texturePath, angle: rock.angle,
  };
}

function spawnCoinsAt(x, y, totalGold) {
  const bigCount = Math.floor(totalGold / 5);
  let remaining = totalGold - bigCount * 5;
  const medCount = Math.floor(remaining / 2);
  const smallCount = remaining - medCount * 2;

  function pushCoin(coinType, value) {
    const angle = Math.random() * Math.PI * 2;
    const speed = rand(40, 140);
    gems.push({ id: nextGemId++, x, y, r: GEM_RADIUS,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      life: GEM_DESPAWN, value, coinType });
  }
  for (let i = 0; i < bigCount;   i++) pushCoin('big',    5);
  for (let i = 0; i < medCount;   i++) pushCoin('medium', 2);
  for (let i = 0; i < smallCount; i++) pushCoin('small',  1);
}

function spawnXpAt(x, y, amount) {
  const bigCount   = Math.floor(amount / 3);
  const smallCount = amount - bigCount * 3;

  function pushXp(xpType, value) {
    const angle = Math.random() * Math.PI * 2;
    const speed = rand(30, 100);
    xpDrops.push({
      id: nextXpId++, x, y, r: XP_RADIUS,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      life: XP_DESPAWN, value, xpType, xpVariant: Math.floor(Math.random() * 3) + 1,
    });
  }
  for (let i = 0; i < bigCount;   i++) pushXp('big',   3);
  for (let i = 0; i < smallCount; i++) pushXp('small', 1);
}

// Round x up or down at random so the expected value equals x.
function stochRound(x) {
  const f = Math.floor(x);
  return f + (Math.random() < x - f ? 1 : 0);
}

function dropRockLoot(rock) {
  const bullets   = Math.ceil(rock.maxHp / SHIP_TYPES.basic.bulletDamage);
  const sizeBonus = 0.75 + rock.r / 256;
  const gold = Math.max(1, stochRound(bullets * GOLD_PER_BULLET * sizeBonus));
  const xp   = stochRound(bullets * XP_PER_BULLET * sizeBonus);
  spawnCoinsAt(rock.x, rock.y, gold);
  if (xp > 0) spawnXpAt(rock.x, rock.y, xp);
}

function initRocks() {
  for (let i = 0; i < ROCK_COUNT; i++) rocks.push(spawnRock());
}

// --- player lifecycle ---

// Find a spawn position with at least SPAWN_CLEARANCE px of edge-to-edge gap from every rock.
// Two-phase: broad circle prefilter → narrow polygon distance.
// Falls back to best-effort if no clear spot is found within the attempt budget.
function findSpawnPosition(shipType) {
  const base       = SHIP_TYPES[shipType] || SHIP_TYPES.basic;
  const shipEntry  = SHIP_POLYS[shipType] ?? SHIP_POLYS.basic;
  const shipScale  = shipEntry?.poly ? (base.r * 2) / shipEntry.texW : null;
  const spawnAngle = 0; // fixed; actual facing set later, clearance check doesn't need to match

  let bestX = rand(200, WORLD_W - 200);
  let bestY = rand(200, WORLD_H - 200);
  let bestClearance = -Infinity;

  for (let tries = 0; tries < 200; tries++) {
    const cx = rand(200, WORLD_W - 200);
    const cy = rand(200, WORLD_H - 200);
    let minClearance = Infinity;
    let rejected = false;

    for (const rock of rocks) {
      const d = torusDist(cx, cy, rock.x, rock.y);
      // Broad phase: circle sum + buffer → if comfortably clear, skip narrow phase.
      if (d >= base.r + rock.r + SPAWN_CLEARANCE) continue;

      // Narrow phase: polygon edge-to-edge distance in rock-local frame.
      let clearance;
      const rockTex = rockTexByPath.get(rock.texturePath);
      if (shipEntry?.poly && shipScale !== null && rockTex?.poly) {
        const ddx = torusDelta(cx, rock.x, WORLD_W);
        const ddy = torusDelta(cy, rock.y, WORLD_H);
        const shipPoly = worldPoly(shipEntry.poly, shipScale, spawnAngle + Math.PI / 2, ddx, ddy);
        const rockPoly = worldPoly(rockTex.poly,   1.0,       rock.angle,               0,   0);
        clearance = polyPolyDist(shipPoly, rockPoly);
      } else {
        clearance = d - base.r - rock.r; // no polygon available — circle edge-to-edge
      }

      if (clearance < minClearance) minClearance = clearance;
      if (clearance < SPAWN_CLEARANCE) { rejected = true; break; } // early exit on first violation
    }

    if (!rejected) return { x: cx, y: cy }; // all rocks cleared

    if (minClearance > bestClearance) {
      bestClearance = minClearance;
      bestX = cx; bestY = cy;
    }
  }

  console.warn(`[spawn] no clear spawn for ${shipType} after 200 tries — best clearance ${bestClearance.toFixed(1)}px`);
  return { x: bestX, y: bestY };
}

function createPlayer(ws, id, userId = null, name = null, savedData = null, preferredColor = null) {
  const color = (preferredColor && /^#[0-9a-fA-F]{6}$/.test(preferredColor))
    ? preferredColor
    : PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length];
  const shipType = 'basic';
  const base     = SHIP_TYPES[shipType];

  const gemCount   = savedData ? savedData.gold           : 0;
  const xpCount    = savedData ? savedData.xp_count       : 0;
  const totalXp    = savedData ? savedData.total_xp       : 0;
  const level      = savedData ? savedData.level          : 1;
  const upPoints   = savedData ? savedData.upgrade_points : 0;
  const upgrades   = savedData
    ? JSON.parse(savedData.upgrades)
    : Object.fromEntries(UPGRADE_IDS.map(k => [k, 0]));

  const spawnPos = findSpawnPosition(shipType);
  return {
    id, ws, userId,
    name: name || 'Player',
    x: spawnPos.x, y: spawnPos.y,
    vx: 0, vy: 0, angle: 0,
    hp: base.maxHp, maxHp: base.maxHp,
    color, shipType,
    upgrades,
    gemCount, xpCount, totalXpEarned: totalXp,
    level, upgradePoints: upPoints,
    fireCooldown: 0, regenCooldown: 0,
    dead: false, respawnTimer: 0,
    shipChoiceOffered: false,  // reset each life; guards level-5 one-shot trigger
    input: { angle: 0, thrust: 0, shoot: false },
  };
}

function savePlayerData(p) {
  if (!p.userId) return;
  db.prepare(`
    INSERT INTO player_data (user_id, level, total_xp, upgrade_points, gold, xp_count, upgrades, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      level          = excluded.level,
      total_xp       = excluded.total_xp,
      upgrade_points = excluded.upgrade_points,
      gold           = excluded.gold,
      xp_count       = excluded.xp_count,
      upgrades       = excluded.upgrades,
      updated_at     = excluded.updated_at
  `).run(p.userId, p.level, p.totalXpEarned, p.upgradePoints, p.gemCount, p.xpCount, JSON.stringify(p.upgrades));
}

function serialize(p) {
  const stats = computeStats(p);
  return {
    id: p.id, x: p.x, y: p.y, vx: p.vx, vy: p.vy,
    angle: p.angle, hp: p.hp, maxHp: stats.maxHp,
    color: p.color, gemCount: p.gemCount, xpCount: p.xpCount,
    totalXpEarned: p.totalXpEarned || 0,
    level: p.level || 1, upgradePoints: p.upgradePoints || 0,
    dead: p.dead, respawnTimer: p.dead ? p.respawnTimer : 0,
    shipType: p.shipType, upgrades: p.upgrades, turnSpeed: stats.turnSpeed,
    name: p.name || 'Player',
  };
}

function killPlayer(p) {
  if (p.dead) return;
  p.dead = true;
  p.hp = 0;
  p.respawnTimer = RESPAWN_TIME;
  const drop = Math.min(10, Math.floor(p.gemCount / 2));
  p.gemCount = Math.floor(p.gemCount / 2);
  if (drop > 0) spawnCoinsAt(p.x, p.y, drop);
  const xpDrop = Math.floor(p.xpCount / 2);
  if (xpDrop > 0) spawnXpAt(p.x, p.y, xpDrop);
  p.xpCount = Math.floor(p.xpCount / 2);
}

function respawnPlayer(p) {
  p.dead = false;
  p.shipType = 'basic';
  p.shipChoiceOffered = false;
  const stats = computeStats(p);
  p.hp = stats.maxHp;
  p.maxHp = stats.maxHp;
  const spawnPos = findSpawnPosition(p.shipType);
  p.x = spawnPos.x; p.y = spawnPos.y;
  p.vx = 0; p.vy = 0;
  p.fireCooldown = 0;
  p.regenCooldown = 0;
}

// --- Express app ---

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'dist')));

app.post('/auth/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Missing fields' });
  if (username.length < 2 || username.length > 20)
    return res.status(400).json({ error: 'Username must be 2–20 characters' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
    const token = jwt.sign({ userId: result.lastInsertRowid, username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username });
  } catch (e) {
    if (e.message.includes('UNIQUE'))
      return res.status(409).json({ error: 'Username already taken' });
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Missing fields' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid username or password' });
  const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: user.username });
});

// --- HTTP + WebSocket server ---

const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/ws')) {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

httpServer.listen(PORT, () => {
  console.log(`Starship.io server running on port ${PORT}`);
});

wss.on('connection', (ws, req) => {
  const url   = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');

  let userId   = null;
  let username = null;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      userId   = payload.userId;
      username = payload.username;
    } catch {}
  }

  const savedData = userId
    ? db.prepare('SELECT * FROM player_data WHERE user_id = ?').get(userId)
    : null;

  const colorParam = url.searchParams.get('color');
  const id = nextId++;
  const player = createPlayer(ws, id, userId, username, savedData, colorParam);
  players.set(id, player);

  send(ws, {
    type: 'init',
    id, color: player.color, x: player.x, y: player.y,
    name: player.name,
    rocks: rocks.map(serializeRock),
    gems: gems.map(g => ({ id: g.id, x: g.x, y: g.y, r: g.r, coinType: g.coinType })),
    xpDrops: xpDrops.map(x => ({ id: x.id, x: x.x, y: x.y, r: x.r, xpType: x.xpType, xpVariant: x.xpVariant })),
    players: Array.from(players.values()).map(serialize),
    upgradeIds: UPGRADE_IDS,
    xpPerLevel: UPGRADE_XP_PER_LEVEL,
    maxUpgradeLevel: MAX_UPGRADE_LEVEL,
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
      } else if (msg.type === 'input') {
        player.input = msg;
      } else if (msg.type === 'cheat') {
        if (msg.code === 'hesoyam') {
          const curLevel = getLevel(player.totalXpEarned);
          const newLevel = Math.min(curLevel + 10, MAX_LEVEL);
          if (newLevel > curLevel) {
            player.totalXpEarned = LEVEL_THRESHOLDS[newLevel - 1];
            for (let l = curLevel + 1; l <= newLevel; l++)
              if (AWARD_LEVELS.has(l)) player.upgradePoints++;
            player.level = newLevel;
            if (newLevel >= 5 && !player.shipChoiceOffered) {
              player.shipChoiceOffered = true;
              send(player.ws, { type: 'shipChoice', options: ['prototwink'] });
            }
          }
        }
      } else if (msg.type === 'upgrade') {
        const stat = msg.stat;
        if (!UPGRADE_IDS.includes(stat)) return;
        const currentLevel = player.upgrades[stat];
        if (currentLevel >= MAX_UPGRADE_LEVEL) return;
        if (player.upgradePoints < 1) return;
        player.upgradePoints--;
        player.upgrades[stat] = currentLevel + 1;
        const newStats = computeStats(player);
        player.maxHp = newStats.maxHp;
        if (player.hp > player.maxHp) player.hp = player.maxHp;
      } else if (msg.type === 'selectShip') {
        const { shipId } = msg;
        if (!SHIP_TYPES[shipId] || shipId === 'basic') return;
        player.shipType = shipId;
        const newStats = computeStats(player);
        player.maxHp = newStats.maxHp;
        if (player.hp > player.maxHp) player.hp = player.maxHp;
      }
    } catch {}
  });

  const cleanup = () => {
    savePlayerData(player);
    players.delete(id);
    broadcast({ type: 'playerLeft', id });
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

// --- physics ---

function updatePlayers() {
  for (const [, p] of players) {
    if (p.dead) {
      p.respawnTimer -= DT;
      if (p.respawnTimer <= 0) respawnPlayer(p);
      continue;
    }

    const stats = computeStats(p);
    p.maxHp = stats.maxHp;

    if (p.fireCooldown > 0) p.fireCooldown -= DT;
    if (p.regenCooldown > 0) p.regenCooldown -= DT;

    if (p.regenCooldown <= 0 && p.hp < stats.maxHp) {
      p.hp = Math.min(stats.maxHp, p.hp + stats.regenRate * DT);
    }

    // Turn toward target angle at turnSpeed rad/s — raise turnSpeed for snappier feel.
    const targetAngle = p.input.angle;
    const maxTurn = stats.turnSpeed * DT;
    const angleDiff = shortestAngleDelta(p.angle, targetAngle);
    if (Math.abs(angleDiff) <= maxTurn) {
      p.angle = targetAngle;
    } else {
      p.angle += Math.sign(angleDiff) * maxTurn;
    }
    const fx = Math.cos(p.angle), fy = Math.sin(p.angle);
    const lx = -fy, ly = fx;

    const thrust = p.input.thrust || 0;
    p.vx += fx * thrust * stats.accel * DT;
    p.vy += fy * thrust * stats.accel * DT;

    const fwdSpd = p.vx * fx + p.vy * fy;
    const latSpd = p.vx * lx + p.vy * ly;
    const fwdNew = fwdSpd * Math.exp(-stats.fwdDrag * DT);
    const latNew = latSpd * Math.exp(-stats.latDrag * DT);
    p.vx = fwdNew * fx + latNew * lx;
    p.vy = fwdNew * fy + latNew * ly;

    const spd = Math.hypot(p.vx, p.vy);
    if (spd > stats.maxSpeed) {
      p.vx *= stats.maxSpeed / spd;
      p.vy *= stats.maxSpeed / spd;
    }

    p.x = wrapX(p.x + p.vx * DT);
    p.y = wrapY(p.y + p.vy * DT);

    if (p.input.shoot && p.fireCooldown <= 0) {
      const ca = Math.cos(p.input.angle);
      const sa = Math.sin(p.input.angle);
      const shipBase = SHIP_TYPES[p.shipType] || SHIP_TYPES.basic;

      if (shipBase.muzzles) {
        // Muzzle-based firing: each entry specifies a sprite-pixel offset from center
        // and its own bullet type (speed/damage from BULLET_TYPES).
        // Scale: sprite is 128px wide; draw width = r*2.
        const scale = (shipBase.r * 2) / 128;
        for (const m of shipBase.muzzles) {
          const side = m.x * scale;   // world units lateral (sprite +x = visual right)
          const fwd  = -m.y * scale;  // world units forward  (sprite -y = toward nose)
          const bt   = BULLET_TYPES[m.bulletType];
          bullets.push({
            id: nextBulletId++,
            x: p.x + side * (-sa) + fwd * ca,
            y: p.y + side *   ca  + fwd * sa,
            vx: p.vx + ca * bt.speed,
            vy: p.vy + sa * bt.speed,
            life: bt.life,
            ownerId: p.id,
            damage: bt.damage,
            variant: m.bulletType,
          });
        }
      } else {
        // Legacy guns[] system (basic ship): world-unit offsets, single bullet type.
        for (const gun of shipBase.guns) {
          bullets.push({
            id: nextBulletId++,
            x: p.x + gun.side * (-sa) + gun.forward * ca,
            y: p.y + gun.side *   ca  + gun.forward * sa,
            vx: p.vx + ca * stats.bulletSpeed,
            vy: p.vy + sa * stats.bulletSpeed,
            life: BULLET_LIFE,
            ownerId: p.id,
            damage: stats.bulletDamage,
          });
        }
      }
      p.fireCooldown = stats.fireCooldown;
      p.input.shoot = false;
    }
  }
}

function updateRocks() {
  const df = Math.exp(-ROCK_DRAG * DT);
  for (const rock of rocks) {
    rock.vx *= df;
    rock.vy *= df;
    const rs = Math.hypot(rock.vx, rock.vy);
    if (rs > ROCK_MAX_SPEED) {
      rock.vx *= ROCK_MAX_SPEED / rs;
      rock.vy *= ROCK_MAX_SPEED / rs;
    }
    rock.x = wrapX(rock.x + rock.vx * DT);
    rock.y = wrapY(rock.y + rock.vy * DT);
  }
}

function checkRockRockCollisions() {
  for (let i = 0; i < rocks.length; i++) {
    for (let j = i + 1; j < rocks.length; j++) {
      const a = rocks[i];
      const b = rocks[j];
      const dx = torusDelta(a.x, b.x, WORLD_W);
      const dy = torusDelta(a.y, b.y, WORLD_H);
      const dist = Math.hypot(dx, dy);
      const minDist = a.r + b.r;

      if (dist < minDist && dist > 0) {
        // Narrow phase: skip physics if polygons don't actually overlap.
        const texA = rockTexByPath.get(a.texturePath);
        const texB = rockTexByPath.get(b.texturePath);
        if (texA?.poly && texB?.poly) {
          // Build polys in b's local frame (b at origin, a offset by torus delta)
          const polyA = worldPoly(texA.poly, 1.0, a.angle, dx, dy);
          const polyB = worldPoly(texB.poly, 1.0, b.angle, 0, 0);
          if (!satOverlap(polyA, polyB)) continue;
        }

        const overlap = minDist - dist;
        const nx = dx / dist;
        const ny = dy / dist;

        const mA = a.r * a.r;
        const mB = b.r * b.r;
        const invSum = 1 / (mA + mB);

        a.x = wrapX(a.x + nx * overlap * (mB * invSum));
        a.y = wrapY(a.y + ny * overlap * (mB * invSum));
        b.x = wrapX(b.x - nx * overlap * (mA * invSum));
        b.y = wrapY(b.y - ny * overlap * (mA * invSum));

        const relVx = a.vx - b.vx;
        const relVy = a.vy - b.vy;
        const relN = relVx * nx + relVy * ny;

        if (relN < 0) {
          const j = -(1 + 0.4) * relN / (1 / mA + 1 / mB);
          a.vx += (j / mA) * nx;
          a.vy += (j / mA) * ny;
          b.vx -= (j / mB) * nx;
          b.vy -= (j / mB) * ny;
        }
      }
    }
  }
}

function updateBullets() {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x = wrapX(b.x + b.vx * DT);
    b.y = wrapY(b.y + b.vy * DT);
    b.life -= DT;

    let hit = false;

    for (let r = rocks.length - 1; r >= 0; r--) {
      const rock = rocks[r];
      const bdx = torusDelta(b.x, rock.x, WORLD_W);
      const bdy = torusDelta(b.y, rock.y, WORLD_H);
      if (Math.hypot(bdx, bdy) < rock.r) {
        // Narrow phase: segment from prev bullet pos to current pos vs rock polygon
        const tex = rockTexByPath.get(rock.texturePath);
        if (tex?.poly) {
          const prevDx = bdx - b.vx * DT;
          const prevDy = bdy - b.vy * DT;
          const localPoly = worldPoly(tex.poly, 1.0, rock.angle, 0, 0);
          if (!segIntersectsPoly(prevDx, prevDy, bdx, bdy, localPoly)) continue;
        }
        rock.hp -= b.damage;
        hit = true;
        if (rock.hp <= 0) {
          dropRockLoot(rock);
          rocks.splice(r, 1);
          rocks.push(spawnRock());
        }
        break;
      }
    }

    if (!hit) {
      for (const [, p] of players) {
        if (p.id === b.ownerId || p.dead) continue;
        if (Math.hypot(torusDelta(b.x, p.x, WORLD_W), torusDelta(b.y, p.y, WORLD_H)) < PLAYER_R) {
          const pStats = computeStats(p);
          p.hp = Math.max(0, p.hp - b.damage);
          p.regenCooldown = pStats.regenDelay;
          hit = true;
          if (p.hp <= 0) killPlayer(p);
          break;
        }
      }
    }

    if (hit || b.life <= 0) bullets.splice(i, 1);
  }
}

function updateGems() {
  for (let i = gems.length - 1; i >= 0; i--) {
    const g = gems[i];
    g.x = wrapX(g.x + g.vx * DT);
    g.y = wrapY(g.y + g.vy * DT);
    g.vx *= Math.exp(-3 * DT);
    g.vy *= Math.exp(-3 * DT);
    g.life -= DT;

    let removed = false;
    for (const [, p] of players) {
      if (p.dead) continue;
      const mdx = torusDelta(p.x, g.x, WORLD_W);
      const mdy = torusDelta(p.y, g.y, WORLD_H);
      const mdist = Math.hypot(mdx, mdy);
      if (mdist < GEM_MAGNET_RADIUS && mdist > 1) {
        const force = (1 - mdist / GEM_MAGNET_RADIUS) * GEM_MAGNET_FORCE;
        g.vx += (mdx / mdist) * force * DT;
        g.vy += (mdy / mdist) * force * DT;
      }
      if (mdist <= PLAYER_R + g.r) {
        p.gemCount += g.value;
        gems.splice(i, 1);
        removed = true;
        break;
      }
    }
    if (!removed && g.life <= 0) gems.splice(i, 1);
  }
}

function updateXpDrops() {
  for (let i = xpDrops.length - 1; i >= 0; i--) {
    const x = xpDrops[i];
    x.x = wrapX(x.x + x.vx * DT);
    x.y = wrapY(x.y + x.vy * DT);
    x.vx *= Math.exp(-3 * DT);
    x.vy *= Math.exp(-3 * DT);
    x.life -= DT;

    let removed = false;
    for (const [, p] of players) {
      if (p.dead) continue;
      const mdx = torusDelta(p.x, x.x, WORLD_W);
      const mdy = torusDelta(p.y, x.y, WORLD_H);
      const mdist = Math.hypot(mdx, mdy);
      if (mdist < XP_MAGNET_RADIUS && mdist > 1) {
        const force = (1 - mdist / XP_MAGNET_RADIUS) * XP_MAGNET_FORCE;
        x.vx += (mdx / mdist) * force * DT;
        x.vy += (mdy / mdist) * force * DT;
      }
      if (mdist <= PLAYER_R + x.r) {
        p.xpCount += x.value;
        p.totalXpEarned += x.value;
        const newLevel = getLevel(p.totalXpEarned);
        if (newLevel > p.level) {
          for (let l = p.level + 1; l <= newLevel; l++)
            if (AWARD_LEVELS.has(l)) p.upgradePoints++;
          p.level = newLevel;
          // DEV TEST: low threshold for ship-choice testing; real gates are 15/35.
          if (newLevel >= 5 && !p.shipChoiceOffered) {
            p.shipChoiceOffered = true;
            send(p.ws, { type: 'shipChoice', options: ['prototwink'] });
          }
        }
        xpDrops.splice(i, 1);
        removed = true;
        break;
      }
    }
    if (!removed && x.life <= 0) xpDrops.splice(i, 1);
  }
}

// Per-contact normal stabilizer: swap each tick so we can compare against last tick's normals.
let _prevContactNormals = new Map(); // `${pid}_${rid}` → { nx, ny, ticks }

function checkPlayerRockCollisions() {
  const curContactNormals = new Map();

  for (const [, p] of players) {
    if (p.dead) continue;
    const stats = computeStats(p);
    const shipEntry = SHIP_POLYS[p.shipType] ?? SHIP_POLYS.basic;
    const shipScale  = shipEntry?.poly ? (PLAYER_R * 2) / shipEntry.texW : null;

    for (let i = rocks.length - 1; i >= 0; i--) {
      const rock = rocks[i];
      const cdx = torusDelta(p.x, rock.x, WORLD_W);
      const cdy = torusDelta(p.y, rock.y, WORLD_H);
      const dist = Math.hypot(cdx, cdy);
      const minDist = PLAYER_R + rock.r;

      if (dist >= minDist || dist <= 0) continue;

      // --- Narrow phase: derive contact normal + penetration depth from polygon MTv ---
      let nx, ny, overlap;
      const rockTex = rockTexByPath.get(rock.texturePath);
      if (shipEntry?.poly && rockTex?.poly && shipScale !== null) {
        const shipPoly = worldPoly(shipEntry.poly, shipScale, p.angle + Math.PI / 2, cdx, cdy);
        const rockPoly = worldPoly(rockTex.poly,   1.0,       rock.angle,             0,   0);
        const mtv = satOverlapMTV(shipPoly, rockPoly);
        if (!mtv) continue; // circles overlap but polygons don't

        // Flip MTv so it points from rock (origin) toward player (cdx,cdy).
        if (mtv.nx * cdx + mtv.ny * cdy < 0) { mtv.nx = -mtv.nx; mtv.ny = -mtv.ny; }

        // Stabilize: if this tick's SAT axis is within ~25° of last tick's, keep prior normal.
        const pairKey = `${p.id}_${rock.id}`;
        const prev = _prevContactNormals.get(pairKey);
        let ticks = 1;
        if (prev) {
          ticks = prev.ticks + 1;
          if (prev.nx * mtv.nx + prev.ny * mtv.ny > 0.9) {
            mtv.nx = prev.nx; mtv.ny = prev.ny; // hold steady
          }
          if (ticks > 5) {
            console.warn(`[col] p${p.id}/r${rock.id} stuck ${ticks} ticks depth=${mtv.depth.toFixed(2)}`);
          }
        }
        curContactNormals.set(pairKey, { nx: mtv.nx, ny: mtv.ny, ticks });

        nx = mtv.nx; ny = mtv.ny; overlap = mtv.depth;
      } else {
        // No polygon data — fall back to circle contact normal + circle penetration.
        nx = cdx / dist; ny = cdy / dist; overlap = minDist - dist;
      }

      const mP = PLAYER_R * PLAYER_R;
      const mR = rock.r * rock.r;
      const invSum = 1 / (mP + mR);

      // Positional correction: push objects apart by the actual polygon penetration depth.
      p.x = wrapX(p.x + nx * overlap * (mR * invSum));
      p.y = wrapY(p.y + ny * overlap * (mR * invSum));
      rock.x = wrapX(rock.x - nx * overlap * (mP * invSum));
      rock.y = wrapY(rock.y - ny * overlap * (mP * invSum));

      const relVx = p.vx - rock.vx;
      const relVy = p.vy - rock.vy;
      const relN = relVx * nx + relVy * ny;

      if (relN < 0) {
        const j = -(1 + 0.15) * relN / (1 / mP + 1 / mR);
        p.vx += (j / mP) * nx;
        p.vy += (j / mP) * ny;
        rock.vx -= (j * stats.collisionPunchMult * 3.0 / mR) * nx;
        rock.vy -= (j * stats.collisionPunchMult * 3.0 / mR) * ny;

        const impact = -relN;
        const baseDmg = Math.max(COLLISION_MIN_DAMAGE, impact / 10);
        const dmg = baseDmg + impact * COLLISION_DAMAGE_SCALE;
        const sizeRatio = rock.r / PLAYER_R;

        const playerDmg = dmg * Math.pow(Math.max(0.5, sizeRatio), 0.75) * COLLISION_PLAYER_DMG_MULT;
        p.hp = Math.max(0, p.hp - playerDmg * (1 - stats.collisionShieldFrac));
        p.regenCooldown = stats.regenDelay;

        const rockDmg = dmg * Math.max(1, 1 / sizeRatio) * stats.bodyDamageScale / COLLISION_ROCK_DMG_DIV;
        rock.hp = Math.max(0, rock.hp - rockDmg);

        if (p.hp <= 0) killPlayer(p);
        if (rock.hp <= 0) {
          dropRockLoot(rock);
          rocks.splice(i, 1);
          rocks.push(spawnRock());
        }
      }
    }
  }

  _prevContactNormals = curContactNormals;
}

// --- main loop ---

function tick() {
  physTick++;
  updatePlayers();
  updateRocks();
  checkRockRockCollisions();
  updateBullets();
  updateGems();
  updateXpDrops();
  checkPlayerRockCollisions();

  if (physTick % NET_RATE !== 0) return;

  const sendSlow   = physTick % SLOW_RATE === 0;
  const allPlayers = Array.from(players.values()).map(serialize);

  for (const [, p] of players) {
    if (!wsReady(p.ws)) continue;

    const msg = {
      type: 'tick',
      players: allPlayers,
      bullets: bullets
        .filter(b => torusDist(p.x, p.y, b.x, b.y) < VIEW_RANGE)
        .map(b => ({ id: b.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy, ownerId: b.ownerId, angle: Math.atan2(b.vy, b.vx), variant: b.variant })),
    };

    if (sendSlow) {
      msg.rocks = rocks
        .filter(r => torusDist(p.x, p.y, r.x, r.y) < VIEW_RANGE)
        .map(serializeRock);
      msg.gems = gems
        .filter(g => torusDist(p.x, p.y, g.x, g.y) < VIEW_RANGE)
        .map(g => ({ id: g.id, x: g.x, y: g.y, r: g.r, vx: g.vx, vy: g.vy, coinType: g.coinType }));
      msg.xpDrops = xpDrops
        .filter(x => torusDist(p.x, p.y, x.x, x.y) < VIEW_RANGE)
        .map(x => ({ id: x.id, x: x.x, y: x.y, r: x.r, vx: x.vx, vy: x.vy, xpType: x.xpType, xpVariant: x.xpVariant }));
    }

    send(p.ws, msg);
  }
}

initRocks();
setInterval(tick, 1000 / TICK_RATE);
