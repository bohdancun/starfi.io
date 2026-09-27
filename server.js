import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {
  polygonArea, transformPoly, convexHull, distPointToSegment,
  circleVsPolygon, segmentVsPolygon, polygonVsPolygonSAT,
} from './shared/geometry.js';
import { CLASS_TREE, classChoicesFor, classById } from './shared/classes.js';
import { gunMuzzle } from './shared/guns.js';
import {
  WORLD_W, WORLD_H, WORLD_MIN, WORLD_MAX, CHUNK_SIZE, CHUNKS_PER_AXIS, CHUNK_COUNT,
  wrapX, wrapY, torusDelta, torusDist, worldToChunk, chunkKey, chunkKeyAt, forEachChunkInRange,
} from './shared/world.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT       = process.env.PORT       || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const DB_PATH    = process.env.DB_PATH    || join(__dirname, 'game.db');

// Dev-only cheats (e.g. 'gotolvl' → level 15) are refused when NODE_ENV=production.
const DEV_CHEATS = process.env.NODE_ENV !== 'production';

const TICK_RATE = 60;
const DT = 1 / TICK_RATE;
const MAX_CATCHUP_TICKS = 4;   // after a stall, simulate at most this many ticks back-to-back, drop the rest
// Dev: DEBUG_FIRE=1 logs fire input and shots.
const DEBUG_FIRE = process.env.DEBUG_FIRE === '1';

// World size, wrap-around and chunks live in shared/world.js (16384² centered on the origin, 512 chunks).

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
// texture: relative to /textures/, drawn at SHIP_TEXTURE_SCALE (same pixel scale for every ship).
// guns: muzzle points in the texture's pixel coords (nose points up, toward y=0). Each gun has its own
// cooldown; bullet damage/speed/cooldown = the player's computed stats × the gun's multipliers.
// Converted to world offsets at load time (see resolveShipGuns).
const SHIP_TYPES = {
  basic: {
    name: 'Basic',
    texture: 'ships/basic_ship/shipbasic1.svg',
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
    // Same muzzles as before the refactor: 16.875 world units either side of center, on the center line.
    guns: [
      { x: 28,  y: 64, bullet: 'basic', cooldownMult: 1, damageMult: 1, speedMult: 1 },
      { x: 100, y: 64, bullet: 'basic', cooldownMult: 1, damageMult: 1, speedMult: 1 },
    ],
    // Engine trail emitters (visual only), texture pixels like guns.
    engines: [{ x: 64, y: 128 }],
  },

  // Tier-1 class (see shared/classes.js). Textures still live in ships/prototwink/.
  twink: {
    name: 'Twink',
    texture: 'ships/prototwink/prototwink.svg',
    r: 30,
    maxHp: 100,
    regenRate: 6,
    regenDelay: 2.0,
    fireCooldown: 0.25,
    bulletSpeed: 700,
    bulletDamage: 25,
    maxSpeed: 650,
    accel: 900,
    fwdDrag: 0.8,
    latDrag: 7.0,
    turnSpeed: 3.0,
    bodyDamageScale: 1.0,
    collisionShieldFrac: 0.0,
    collisionPunchMult: 1.0,
    // Sprite 128×144. Short guns ±12px from center, long guns ±52px. Multipliers reproduce the old
    // fixed values at base stats: short 600 speed / 18 dmg, long 850 speed / 35 dmg.
    guns: [
      { x: 52,  y: 72, bullet: 'short', cooldownMult: 1, damageMult: 18 / 25, speedMult: 600 / 700 },
      { x: 76,  y: 72, bullet: 'short', cooldownMult: 1, damageMult: 18 / 25, speedMult: 600 / 700 },
      { x: 12,  y: 72, bullet: 'long',  cooldownMult: 1, damageMult: 35 / 25, speedMult: 850 / 700 },
      { x: 116, y: 72, bullet: 'long',  cooldownMult: 1, damageMult: 35 / 25, speedMult: 850 / 700 },
    ],
    engines: [{ x: 28, y: 144 }, { x: 100, y: 144 }], // rear legs
  },

  // Tier-1 class (see shared/classes.js). Base stats = Basic.
  sniper: {
    name: 'Sniper',
    texture: 'ships/sniper/snipership.svg',
    // Drawn 60×67.5. Hull area ≈ basic's (area-equivalent radius 27.7 vs 27.5), so same r as basic;
    // only the two front prongs (38.6 from center) and the rear legs stick out past it.
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
    guns: [
      { x: 28,  y: 0,  bullet: 'basic',  cooldownMult: 1, damageMult: 1, speedMult: 1 },
      { x: 100, y: 0,  bullet: 'basic',  cooldownMult: 1, damageMult: 1, speedMult: 1 },
      { x: 64,  y: 32, bullet: 'sniper', cooldownMult: 4, damageMult: 3, speedMult: 1.8 },
    ],
    engines: [{ x: 52, y: 144 }, { x: 76, y: 144 }],
  },
};

// Every ship texture is drawn at this many world units per texture pixel (60 units across 128px).
const SHIP_TEXTURE_SCALE = 60 / 128;

// --- Upgrade system ---
const MAX_UPGRADE_LEVEL = 6;
const UPGRADE_XP_PER_LEVEL = 50;

const UPGRADE_IDS = [
  'healthCap', 'healthRegen', 'bulletReload', 'bulletSpeed',
  'bulletDamage', 'shipSpeed', 'shipAgility', 'bodyDamage', 'collisionShield',
];

// Collision radius of the player's current ship.
function shipR(p) {
  return (SHIP_TYPES[p.shipType] || SHIP_TYPES.basic).r;
}

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

// Raise a player to newLevel (never down), awarding upgrade points for every level passed.
function setPlayerLevel(p, newLevel) {
  const cur = getLevel(p.totalXpEarned);
  if (newLevel <= cur) return;
  p.totalXpEarned = LEVEL_THRESHOLDS[newLevel - 1];
  for (let l = cur + 1; l <= newLevel; l++)
    if (AWARD_LEVELS.has(l)) p.upgradePoints++;
  p.level = newLevel;
  offerClassChoices(p);
}

// Returns the shortest signed angle from `from` to `to` in [-π, π].
function shortestAngleDelta(from, to) {
  let diff = (to - from) % (Math.PI * 2);
  if (diff > Math.PI)  diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

// --- SVG polygon parsing (collision math itself lives in shared/geometry.js) ---

// Vertices of the first subpath of an SVG path "d" (M/L/H/V/Z, absolute or relative, decimals).
function parseSvgPathD(d) {
  const verts = [];
  let cx = 0, cy = 0;
  const re = /([MLHVZ])([^MLHVZ]*)/gi;
  let m;
  while ((m = re.exec(d)) !== null) {
    const cmd = m[1].toUpperCase();
    const rel = m[1] !== cmd;
    const args = m[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (cmd === 'Z') break;
    if (cmd === 'M' || cmd === 'L') {
      // Extra coordinate pairs after M/L are implicit L commands.
      for (let i = 0; i + 1 < args.length; i += 2) {
        cx = rel ? cx + args[i] : args[i];
        cy = rel ? cy + args[i + 1] : args[i + 1];
        verts.push([cx, cy]);
      }
    } else if (cmd === 'H') {
      for (const a of args) { cx = rel ? cx + a : a; verts.push([cx, cy]); }
    } else if (cmd === 'V') {
      for (const a of args) { cy = rel ? cy + a : a; verts.push([cx, cy]); }
    }
  }
  return verts;
}

// Drop repeated points (incl. the closing copy of the first point) and exactly collinear vertices.
function cleanPoly(pts) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.abs(p[0] - q[0]) > 1e-9 || Math.abs(p[1] - q[1]) > 1e-9) out.push(p);
  }
  while (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) < 1e-9 && Math.abs(out[0][1] - out[out.length - 1][1]) < 1e-9) out.pop();
  for (let i = 0; i < out.length && out.length > 3; ) {
    const a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-9) out.splice(i, 1); else i++;
  }
  return out;
}

// Outer silhouette of a rock SVG: the <path> with the largest area (Figma puts the outline path first,
// detail paths sit inside it). Points are relative to the texture center, positive winding.
function parseRockSilhouette(svgText, size) {
  let best = null, bestArea = 0;
  for (const m of svgText.matchAll(/<path\b[^>]*?\sd="([^"]+)"/g)) {
    const pts = cleanPoly(parseSvgPathD(m[1]));
    if (pts.length < 3) continue;
    const a = Math.abs(polygonArea(pts));
    if (a > bestArea) { bestArea = a; best = pts; }
  }
  if (!best) return null;
  const local = best.map(([x, y]) => [x - size / 2, y - size / 2]);
  return polygonArea(local) < 0 ? local.reverse() : local;
}

// Ship SVG → convex hull centered at (texW/2, texH/2). Only used for spawn clearance.
function buildNormalizedPoly(svgText, texW, texH) {
  const dm = svgText.match(/\bd="([^"]+)"/);
  if (!dm) return null;
  const raw = parseSvgPathD(dm[1]);
  if (raw.length < 3) return null;
  const cx = texW / 2, cy = texH / 2;
  return convexHull(raw).map(([x, y]) => [x - cx, y - cy]);
}

// Transform a normalized polygon: scale, rotate, translate. rotAngle: p.angle + PI/2 for ships.
function worldPoly(normPoly, scale, rotAngle, px, py) {
  return transformPoly(normPoly.map(([x, y]) => [x * scale, y * scale]), px, py, rotAngle);
}

// Minimum edge-to-edge distance between two convex polygons (0 if overlapping).
function polyPolyDist(A, B) {
  if (polygonVsPolygonSAT(A, B) !== null) return 0;
  let minD = Infinity;
  for (const [P, Q] of [[A, B], [B, A]]) {
    for (const [px, py] of P) {
      for (let i = 0; i < Q.length; i++) {
        const [bx, by] = Q[i], [cx, cy] = Q[(i + 1) % Q.length];
        const d = distPointToSegment(px, py, bx, by, cx, cy);
        if (d < minD) minD = d;
      }
    }
  }
  return minD;
}

// --- Network optimisation constants ---
const VIEW_RANGE = 1600; // world units sent to each client
const NET_RATE   = 2;    // send every Nth physics tick → 30 Hz
const SLOW_RATE  = 4;    // rocks/gems/xp every Nth → 15 Hz
let   physTick   = 0;

// --- Rock kinds + texture manifest ---
// Data-driven: a new kind is one entry here plus textures in public/textures/<dir>/<size>/*.svg
// (numeric folder name = texture width in px, r = size / 2). New sizes/variants need no code changes.
//   spawnChance: probability per spawn; the kind with spawnChance null takes the remainder.
//   sizeWeight(r): relative weight of each size folder within the kind (per folder, not per variant).
//   hpMult/massMult/goldMult/xpMult: relative to a normal rock of the same size.

// Spawn weight per size folder (not per variant): small rocks are more common.
function rockSizeWeight(r) {
  if (r <= 48) return 1.5;
  if (r <= 88) return 1.0;
  return 0.7;
}

const XP_ROCK_CHANCE = (() => {
  const v = parseFloat(process.env.XP_ROCK_CHANCE);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.05; // env override for testing
})();

const ROCK_KINDS = {
  normal: { dir: 'rocks',      spawnChance: null,           sizeWeight: rockSizeWeight, hpMult: 1, massMult: 1, goldMult: 1, xpMult: 1 },
  xp:     { dir: 'xporerocks', spawnChance: XP_ROCK_CHANCE, sizeWeight: () => 1,        hpMult: 2, massMult: 3, goldMult: 0, xpMult: 3 },
};

const TEXTURES_DIR = join(__dirname, 'public/textures');

// Per texture, precomputed once: exact outer silhouette (localPoly, may be concave), its convex hull,
// and boundR (max center→vertex distance, the broad-phase radius). r stays the balance radius.
// path is relative to /textures/ (e.g. "rocks/48/rock48.svg") so it is unambiguous across kinds.
function loadRockTexture(dir, folder, file, r) {
  const size = r * 2;
  const path = `${dir}/${folder}/${file}`;
  const src = readFileSync(join(TEXTURES_DIR, dir, folder, file), 'utf8');
  let localPoly = parseRockSilhouette(src, size);
  let fallback = false;
  if (!localPoly || localPoly.length < 3) {
    // Unusable SVG: fall back to a 16-gon of radius r so collisions still work.
    fallback = true;
    localPoly = Array.from({ length: 16 }, (_, i) => [Math.cos(i * Math.PI / 8) * r, Math.sin(i * Math.PI / 8) * r]);
  }
  const hull = convexHull(localPoly);
  const boundR = Math.max(...localPoly.map(([x, y]) => Math.hypot(x, y)));
  return { path, r, localPoly, hull, boundR, texSize: size, fallback };
}

// [{ size, r, textures }] for one kind's texture folder, sorted by size, empty folders skipped.
function loadRockSizes(dir) {
  const root = join(TEXTURES_DIR, dir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^\d+$/.test(d.name))
    .map(d => {
      const size = parseInt(d.name);
      const r = size / 2;
      const textures = readdirSync(join(root, d.name))
        .filter(f => f.endsWith('.svg'))
        .sort()
        .map(f => loadRockTexture(dir, d.name, f, r));
      return { size, r, textures };
    })
    .filter(s => s.textures.length > 0)
    .sort((a, b) => a.size - b.size);
}

for (const kind of Object.values(ROCK_KINDS)) kind.sizes = loadRockSizes(kind.dir);

const ROCK_TEXTURES = Object.values(ROCK_KINDS).flatMap(k => k.sizes.flatMap(s => s.textures));

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
const SHIP_POLYS = Object.fromEntries(Object.entries(SHIP_TYPES).map(([id, t]) => [id, loadShipPoly(`textures/${t.texture}`)]));

// Muzzle texture pixels → local offsets relative to the ship center, at the draw scale:
// side = (x - texW/2)·scale (+ = ship's right), forward = -(y - texH/2)·scale (+ = toward the nose).
// Applied with the same rotation as the drawn texture (texture up = facing direction).
function resolveShipGuns() {
  for (const [id, ship] of Object.entries(SHIP_TYPES)) {
    const tex = SHIP_POLYS[id];
    if (!tex) throw new Error(`ship ${id}: cannot read ${ship.texture}`);
    ship.texW = tex.texW; ship.texH = tex.texH;
    for (const g of ship.guns) {
      if (!BULLET_TYPES[g.bullet]) throw new Error(`ship ${id}: unknown bullet type ${g.bullet}`);
      g.side    =  (g.x - tex.texW / 2) * SHIP_TEXTURE_SCALE;
      g.forward = -(g.y - tex.texH / 2) * SHIP_TEXTURE_SCALE;
    }
    for (const e of ship.engines || []) {
      e.side    =  (e.x - tex.texW / 2) * SHIP_TEXTURE_SCALE;
      e.forward = -(e.y - tex.texH / 2) * SHIP_TEXTURE_SCALE;
    }
  }
}

console.log(`Loaded ${ROCK_TEXTURES.length} rock textures in ${Object.keys(ROCK_KINDS).length} kinds:`);
for (const [kindId, kind] of Object.entries(ROCK_KINDS)) {
  const chance = kind.spawnChance == null ? 'remainder' : `${(kind.spawnChance * 100).toFixed(1)}%`;
  console.log(`  kind=${kindId} dir=${kind.dir} spawn=${chance} hp×${kind.hpMult} mass×${kind.massMult} gold×${kind.goldMult} xp×${kind.xpMult}`);
  if (!kind.sizes.length) console.warn(`    WARNING kind ${kindId}: no textures in public/textures/${kind.dir}/ — it will never spawn`);
  for (const s of kind.sizes) {
    console.log(`    size=${s.size} r=${s.r} variants=${s.textures.length}`);
    for (const t of s.textures) {
      console.log(`      ${t.path.split('/').pop().padEnd(16)} points=${String(t.localPoly.length).padEnd(3)} hull=${String(t.hull.length).padEnd(3)} boundR=${t.boundR.toFixed(1)} (${(t.boundR / t.r * 100).toFixed(0)}% of r)`);
      if (t.fallback) console.warn(`      WARNING ${t.path}: no usable path (<3 points) — using a circle polygon`);
      if (t.boundR > t.r * 1.05) console.warn(`      WARNING ${t.path}: boundR ${t.boundR.toFixed(1)} exceeds r ${t.r} by more than 5%`);
    }
  }
}
{
  const explicit = Object.values(ROCK_KINDS).reduce((a, k) => a + (k.spawnChance ?? 0), 0);
  if (explicit > 1) console.warn(`WARNING rock kind spawn chances add up to ${explicit} (> 1)`);
}

// Shapes sent to clients once in 'init' so they never parse SVGs themselves.
const ROCK_SHAPES = Object.fromEntries(ROCK_TEXTURES.map(t => [t.path, { localPoly: t.localPoly, hull: t.hull, boundR: t.boundR }]));

// Per-kind values the client mirrors (collision prediction needs the same mass).
const ROCK_KINDS_CLIENT = Object.fromEntries(Object.entries(ROCK_KINDS).map(([id, k]) => [id, { massMult: k.massMult }]));

// --- World constants ---
const PLAYER_R = 30;
const SPAWN_CLEARANCE = 64; // px of edge-to-edge gap required between ship hull and any rock hull
const SPAWN_RADIUS = 3000;  // players spawn within this distance of the origin

// Rock density instead of a fixed count: same density as the old 4000² world (100 rocks ≈ 1.6/chunk).
const ROCKS_PER_CHUNK = 1.6;
const ROCK_COUNT = Math.round(ROCKS_PER_CHUNK * CHUNK_COUNT);
// Rocks in chunks with no living player within this many chunks sleep (no physics) until one comes near.
const ROCK_WAKE_CHUNKS = 2;
// Largest rock/ship radius: margins for chunk queries (entities are indexed by their center).
const MAX_ROCK_BOUND_R = Math.max(...ROCK_TEXTURES.map(t => t.boundR));
const MAX_SHIP_R = Math.max(...Object.values(SHIP_TYPES).map(t => t.r));
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
const BULLET_R = 3; // collision radius for bullets vs rock silhouettes (grazes within 3px count)

// Bullet types: texture (relative to /textures/, drawn at SHIP_TEXTURE_SCALE) and collision radius.
// Speed/damage come from the firing ship's stats × gun multipliers. Same lifetime for all types.
const BULLET_TYPES = {
  basic:  { texture: 'ships/sniper/basicbullet.svg',                 r: BULLET_R },
  sniper: { texture: 'ships/sniper/sniperbullet.svg',                r: 8 },
  short:  { texture: 'ships/prototwink/prototwinkshortbullet.svg',   r: BULLET_R },
  long:   { texture: 'ships/prototwink/prototwinklongbullet.svg',    r: BULLET_R },
};

resolveShipGuns();

// Per-ship values the client needs to draw ships and predict collisions with the right radius.
// Built after resolveShipGuns() so the muzzle offsets exist.
const SHIP_TYPES_CLIENT = Object.fromEntries(Object.entries(SHIP_TYPES).map(([id, t]) => [id, {
  name: t.name, texture: t.texture, r: t.r,
  guns: t.guns.map(g => ({ side: g.side, forward: g.forward, bullet: g.bullet })), // for muzzle flashes
  engines: (t.engines || []).map(e => ({ side: e.side, forward: e.forward })),      // for engine trails
}]));


console.log('Class tree:');
for (const c of CLASS_TREE) {
  console.log(`  ${c.fromClass} → ${c.id.padEnd(7)} at level ${c.level}  ${classImplemented(c.id) ? 'available' : 'NOT IMPLEMENTED (shown as "soon")'}  icon=${c.icon}  hint="${c.hint}"`);
}

console.log('Ship guns (world units; side + = right, forward + = nose):');
for (const [id, ship] of Object.entries(SHIP_TYPES)) {
  console.log(`  ${id.padEnd(10)} texture ${ship.texW}×${ship.texH} → drawn ${(ship.texW * SHIP_TEXTURE_SCALE).toFixed(2)}×${(ship.texH * SHIP_TEXTURE_SCALE).toFixed(2)}, r=${ship.r}`);
  for (const g of ship.guns) {
    console.log(`    ${g.bullet.padEnd(7)} px(${g.x},${g.y}) → side ${g.side.toFixed(3).padStart(8)} forward ${g.forward.toFixed(3).padStart(8)}  cooldown×${g.cooldownMult} dmg×${+g.damageMult.toFixed(3)} speed×${+g.speedMult.toFixed(3)}`);
  }
}
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

// --- Spatial index by chunk ---
// Entities are bucketed by the chunk of their center (entity._ck = chunk key) and re-bucketed via
// update() when they move. query() returns everything in the chunks overlapping a square around a
// point, wrap-aware; callers still do their own exact distance/shape checks.
class ChunkIndex {
  constructor() { this.buckets = new Map(); }
  insert(e) {
    const k = chunkKeyAt(e.x, e.y);
    e._ck = k;
    let b = this.buckets.get(k);
    if (!b) this.buckets.set(k, b = new Set());
    b.add(e);
  }
  remove(e) {
    const b = this.buckets.get(e._ck);
    if (b) { b.delete(e); if (!b.size) this.buckets.delete(e._ck); }
    e._ck = undefined;
  }
  update(e) {
    if (chunkKeyAt(e.x, e.y) !== e._ck) { this.remove(e); this.insert(e); }
  }
  inChunk(key) { return this.buckets.get(key); }
  query(x, y, r) {
    const out = [];
    forEachChunkInRange(x, y, r, k => { const b = this.buckets.get(k); if (b) for (const e of b) out.push(e); });
    return out;
  }
}

const rockIndex   = new ChunkIndex();
const playerIndex = new ChunkIndex();
const bulletIndex = new ChunkIndex();
const gemIndex    = new ChunkIndex();
const xpIndex     = new ChunkIndex();

// Entities within `range` of a point, via the index (exact torus distance).
function nearby(index, x, y, range) {
  return index.query(x, y, range).filter(e => torusDist(x, y, e.x, e.y) < range);
}

// --- helpers ---

function rand(min, max) { return Math.random() * (max - min) + min; }

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

// Normal rock HP for a radius; other kinds scale it by hpMult.
function rockMaxHp(r) {
  return Math.round(r * r / 64 + r / 2);
}

// Roll the kind first so replacement spawns keep the same ratio. Kinds without textures never spawn.
function pickRockKind() {
  let roll = Math.random();
  let fallback = 'normal';
  for (const [id, kind] of Object.entries(ROCK_KINDS)) {
    if (!kind.sizes.length) continue;
    if (kind.spawnChance == null) { fallback = id; continue; }
    if (roll < kind.spawnChance) return id;
    roll -= kind.spawnChance;
  }
  return fallback;
}

// Weighted pick of a size folder within a kind (weight per folder, not per variant).
function pickRockSize(kind) {
  let total = 0;
  for (const s of kind.sizes) total += kind.sizeWeight(s.r);
  let roll = Math.random() * total;
  for (const s of kind.sizes) {
    roll -= kind.sizeWeight(s.r);
    if (roll < 0) return s;
  }
  return kind.sizes[kind.sizes.length - 1];
}

function spawnRock() {
  const kindId = pickRockKind();
  const kind = ROCK_KINDS[kindId];
  const sizeEntry = pickRockSize(kind);
  const tex = sizeEntry.textures[Math.floor(Math.random() * sizeEntry.textures.length)];
  const r = tex.r;
  const texturePath = tex.path;
  const maxHp = Math.round(rockMaxHp(r) * kind.hpMult);
  const mass = r * r * kind.massMult; // used by every rock collision (player–rock and rock–rock)

  // Anywhere in the world, but not right next to a living player.
  const clear = 300 + r + PLAYER_R;
  let x = rand(WORLD_MIN, WORLD_MAX);
  let y = rand(WORLD_MIN, WORLD_MAX);
  for (let tries = 0; tries < 200; tries++) {
    x = rand(WORLD_MIN, WORLD_MAX);
    y = rand(WORLD_MIN, WORLD_MAX);
    if (!nearby(playerIndex, x, y, clear).some(p => !p.dead)) break;
  }

  const angle = Math.random() * Math.PI * 2;
  const rock = { id: nextRockId++, kind: kindId, x, y, r, mass, texturePath, maxHp, hp: maxHp, vx: 0, vy: 0, angle };
  attachRockShape(rock, tex);
  return rock;
}

// Rotated collision shapes, relative to the rock center (queries use torus deltas, so position is
// not baked in). Rocks never change angle, so this is computed once per rock instead of per tick.
// Call again if a rock's angle ever changes.
function attachRockShape(rock, tex = rockTexByPath.get(rock.texturePath)) {
  rock.poly   = transformPoly(tex.localPoly, 0, 0, rock.angle);
  rock.hull   = transformPoly(tex.hull, 0, 0, rock.angle);
  rock.boundR = tex.boundR;
}

function serializeRock(rock) {
  return {
    id: rock.id, k: rock.kind, x: Math.round(rock.x * 10) / 10, y: Math.round(rock.y * 10) / 10, r: rock.r,
    hp: Math.round(rock.hp), maxHp: rock.maxHp, vx: Math.round(rock.vx), vy: Math.round(rock.vy),
    texturePath: rock.texturePath, angle: Math.round(rock.angle * 1000) / 1000,
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
    const g = { id: nextGemId++, x, y, r: GEM_RADIUS,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      life: GEM_DESPAWN, value, coinType };
    gems.push(g);
    gemIndex.insert(g);
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
    const d = {
      id: nextXpId++, x, y, r: XP_RADIUS,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      life: XP_DESPAWN, value, xpType, xpVariant: Math.floor(Math.random() * 3) + 1,
    };
    xpDrops.push(d);
    xpIndex.insert(d);
  }
  for (let i = 0; i < bigCount;   i++) pushXp('big',   3);
  for (let i = 0; i < smallCount; i++) pushXp('small', 1);
}

// Round x up or down at random so the expected value equals x.
function stochRound(x) {
  const f = Math.floor(x);
  return f + (Math.random() < x - f ? 1 : 0);
}

// Loot is based on a NORMAL rock of the same size (not the kind's scaled HP), then scaled per kind.
function dropRockLoot(rock) {
  const kind      = ROCK_KINDS[rock.kind];
  const bullets   = Math.ceil(rockMaxHp(rock.r) / SHIP_TYPES.basic.bulletDamage);
  const sizeBonus = 0.75 + rock.r / 256;
  // Minimum 1 gold only for kinds that drop gold at all.
  const gold = kind.goldMult > 0 ? Math.max(1, stochRound(bullets * GOLD_PER_BULLET * sizeBonus * kind.goldMult)) : 0;
  const xp   = stochRound(bullets * XP_PER_BULLET * sizeBonus * kind.xpMult);
  if (gold > 0) spawnCoinsAt(rock.x, rock.y, gold);
  if (xp > 0) spawnXpAt(rock.x, rock.y, xp);
}

// Rocks destroyed since the last outgoing message. Flushed on the next send regardless of
// NET_RATE/SLOW_RATE tiers so clients never miss or delay a shatter effect.
const brokenRockQueue = [];

// Visual-feedback events since the last outgoing message. Like brokenRockQueue: flushed on the next
// send regardless of NET_RATE/SLOW_RATE, only to clients within VIEW_RANGE. Visual only.
const hitQueue = [];    // { x, y, targetType: 'rock'|'player', targetId, dirX, dirY, b? (bullet type if not basic) }
const pickupQueue = []; // { pickupId, kind: 'gold'|'xp', playerId, x, y }
const playerDiedQueue = []; // { id, x, y, angle, vx, vy, shipType, color, hx, hy } — ship death shatter
const RAM_HIT_FX_MIN_IMPACT = 80; // px/s closing speed before a ram counts as a visible hit (avoids spam while resting)

const round2 = v => Math.round(v * 100) / 100;

function queueHit(x, y, targetType, targetId, dirX, dirY, bulletType) {
  const len = Math.hypot(dirX, dirY) || 1;
  const e = { x: Math.round(wrapX(x)), y: Math.round(wrapY(y)), targetType, targetId, dirX: round2(dirX / len), dirY: round2(dirY / len) };
  if (bulletType && bulletType !== 'basic') e.b = bulletType;
  hitQueue.push(e);
}

// Remove a rock (loot + replacement anywhere in the world), announcing it with impact point (hx, hy).
function destroyRock(rock, hx, hy) {
  if (rock.removed) return;
  rock.removed = true;
  dropRockLoot(rock);
  brokenRockQueue.push({
    id: rock.id,
    x: Math.round(rock.x), y: Math.round(rock.y), r: rock.r,
    angle: Math.round(rock.angle * 100) / 100,
    vx: Math.round(rock.vx), vy: Math.round(rock.vy),
    texturePath: rock.texturePath,
    hx: Math.round(hx), hy: Math.round(hy),
  });
  const i = rocks.indexOf(rock);
  if (i >= 0) rocks.splice(i, 1);
  rockIndex.remove(rock);
  addRock(spawnRock());
}

function addRock(rock) {
  rocks.push(rock);
  rockIndex.insert(rock);
}

function initRocks() {
  for (let i = 0; i < ROCK_COUNT; i++) addRock(spawnRock());
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

  // Uniform over the disk of SPAWN_RADIUS around the origin.
  const randomSpawnPoint = () => {
    const a = Math.random() * Math.PI * 2, d = SPAWN_RADIUS * Math.sqrt(Math.random());
    return [wrapX(Math.cos(a) * d), wrapY(Math.sin(a) * d)];
  };
  let [bestX, bestY] = randomSpawnPoint();
  let bestClearance = -Infinity;

  for (let tries = 0; tries < 200; tries++) {
    const [cx, cy] = randomSpawnPoint();
    let minClearance = Infinity;
    let rejected = false;

    for (const rock of rockIndex.query(cx, cy, base.r + MAX_ROCK_BOUND_R + SPAWN_CLEARANCE)) {
      const d = torusDist(cx, cy, rock.x, rock.y);
      // Broad phase: circle sum + buffer → if comfortably clear, skip narrow phase.
      if (d >= base.r + rock.r + SPAWN_CLEARANCE) continue;

      // Narrow phase: polygon edge-to-edge distance in rock-local frame.
      let clearance;
      if (shipEntry?.poly && shipScale !== null) {
        const ddx = torusDelta(cx, rock.x, WORLD_W);
        const ddy = torusDelta(cy, rock.y, WORLD_H);
        const shipPoly = worldPoly(shipEntry.poly, shipScale, spawnAngle + Math.PI / 2, ddx, ddy);
        clearance = polyPolyDist(shipPoly, rock.hull);
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
    gunCooldowns: null, regenCooldown: 0, // per-gun timers, (re)built for the current ship
    dead: false, respawnTimer: 0,
    pendingClasses: null,      // class ids the player may pick right now (see offerClassChoices)
    input: { angle: 0, thrust: 0, shoot: false },
    lastFireSeq: 0, fireRequested: false, // press latch (see the 'input' handler)
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

const round1 = v => Math.round(v * 10) / 10;

// What other clients need to draw a player (sent only within view range). The owner gets serialize().
function serializeOther(p) {
  return {
    id: p.id, x: round1(p.x), y: round1(p.y), angle: Math.round(p.angle * 100) / 100,
    hp: Math.round(p.hp), maxHp: p.maxHp, dead: p.dead, color: p.color, name: p.name || 'Player',
    shipType: p.shipType, level: p.level || 1, totalXpEarned: p.totalXpEarned || 0,
    th: !p.dead && (p.input.thrust || 0) > 0 ? 1 : 0,
  };
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
    th: !p.dead && (p.input.thrust || 0) > 0 ? 1 : 0, // thrusting (engine trail)
    name: p.name || 'Player',
  };
}

// (hx, hy): the killing hit point, for the client's death shatter (ship center if unknown).
function killPlayer(p, hx = p.x, hy = p.y) {
  if (p.dead) return;
  p.fireRequested = false;
  playerDiedQueue.push({
    id: p.id, x: Math.round(p.x), y: Math.round(p.y), angle: Math.round(p.angle * 100) / 100,
    vx: Math.round(p.vx), vy: Math.round(p.vy), shipType: p.shipType, color: p.color,
    hx: Math.round(wrapX(hx)), hy: Math.round(wrapY(hy)),
  });
  clearClassChoices(p);
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

// --- Class upgrades (tree in shared/classes.js) ---

// A class is choosable only if its ship type exists with guns; others show as "soon" in the menu.
function classImplemented(id) {
  return !!SHIP_TYPES[id]?.guns?.length;
}

// If the player's current class unlocks choices at their level, mark them pending and tell only them.
function offerClassChoices(p) {
  if (p.dead || p.pendingClasses) return;
  const choices = classChoicesFor(p.shipType, p.level);
  if (!choices.length) return;
  p.pendingClasses = choices.filter(c => classImplemented(c.id)).map(c => c.id);
  if (!p.pendingClasses.length) { p.pendingClasses = null; return; }
  send(p.ws, { type: 'classChoice', options: choices.map(c => ({ id: c.id, available: classImplemented(c.id) })) });
}

function clearClassChoices(p) {
  if (!p.pendingClasses) return;
  p.pendingClasses = null;
  send(p.ws, { type: 'classChoice', options: [] });
}

// Switch to a pending class: keeps stat upgrades, HP ratio, XP and level. Invalid/repeat picks are ignored.
function chooseClass(p, id) {
  if (p.dead || !p.pendingClasses || !p.pendingClasses.includes(id) || !classImplemented(id)) return;
  const hpRatio = p.maxHp > 0 ? p.hp / p.maxHp : 1;
  p.shipType = id;
  const stats = computeStats(p);
  p.maxHp = stats.maxHp;
  p.hp = Math.max(1, Math.min(stats.maxHp, hpRatio * stats.maxHp));
  p.gunCooldowns = null;
  clearClassChoices(p);
  offerClassChoices(p); // a later tier may already be unlocked at this level
}

function respawnPlayer(p) {
  p.dead = false;
  p.shipType = 'basic';
  p.pendingClasses = null;
  const stats = computeStats(p);
  p.hp = stats.maxHp;
  p.maxHp = stats.maxHp;
  const spawnPos = findSpawnPosition(p.shipType);
  p.x = spawnPos.x; p.y = spawnPos.y;
  playerIndex.update(p);
  p.vx = 0; p.vy = 0;
  p.gunCooldowns = null;
  p.regenCooldown = 0;
  offerClassChoices(p); // back to basic: offer the tier-1 choice again if the level allows
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
  playerIndex.insert(player);

  send(ws, {
    type: 'init',
    id, color: player.color, x: player.x, y: player.y,
    name: player.name,
    rocks: nearby(rockIndex, player.x, player.y, VIEW_RANGE).map(serializeRock),
    rockShapes: ROCK_SHAPES,
    rockKinds: ROCK_KINDS_CLIENT,
    shipTypes: SHIP_TYPES_CLIENT,
    bulletTypes: BULLET_TYPES,
    shipTextureScale: SHIP_TEXTURE_SCALE,
    gems: nearby(gemIndex, player.x, player.y, VIEW_RANGE).map(g => ({ id: g.id, x: g.x, y: g.y, r: g.r, coinType: g.coinType })),
    xpDrops: nearby(xpIndex, player.x, player.y, VIEW_RANGE).map(x => ({ id: x.id, x: x.x, y: x.y, r: x.r, xpType: x.xpType, xpVariant: x.xpVariant })),
    players: Array.from(players.values()).map(serialize),
    upgradeIds: UPGRADE_IDS,
    xpPerLevel: UPGRADE_XP_PER_LEVEL,
    maxUpgradeLevel: MAX_UPGRADE_LEVEL,
  });
  offerClassChoices(player);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
      } else if (msg.type === 'input') {
        // Several input messages can arrive within one tick (a tap's press and release). The held state
        // is the latest message, but a new press (fs counter) is latched until a gun fires, so it can't be lost.
        const fs = Number(msg.fs) || 0;
        if (fs > player.lastFireSeq) { player.lastFireSeq = fs; player.fireRequested = true; }
        player.input = {
          angle: Number.isFinite(msg.angle) ? msg.angle : player.input.angle,
          thrust: Math.max(-0.5, Math.min(1, Number(msg.thrust) || 0)),
          shoot: !!msg.shoot,
        };
        if (DEBUG_FIRE) console.log(`[fire] p${player.id} input shoot=${player.input.shoot} fs=${fs} latched=${player.fireRequested}`);
      } else if (msg.type === 'cheat') {
        if (msg.code === 'hesoyam') {
          setPlayerLevel(player, Math.min(getLevel(player.totalXpEarned) + 10, MAX_LEVEL));
        } else if (msg.code === 'gotolvl' && DEV_CHEATS) {
          // Dev only: jump straight to the tier-1 class level.
          setPlayerLevel(player, Math.min(...CLASS_TREE.filter(c => c.fromClass === 'basic').map(c => c.level)));
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
      } else if (msg.type === 'chooseClass') {
        chooseClass(player, msg.id);
      }
    } catch {}
  });

  const cleanup = () => {
    if (!players.has(id)) return; // 'error' and 'close' can both fire
    savePlayerData(player);
    players.delete(id);
    playerIndex.remove(player);
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
    playerIndex.update(p);

    // Guns: each has its own cooldown and fires whenever it is ready while fire is held.
    // Bullets leave their own muzzle and fly straight along the ship's facing (p.angle, the angle it
    // is drawn at), placed by the shared gunMuzzle() that the client's muzzle flash also uses.
    const shipId = SHIP_TYPES[p.shipType] ? p.shipType : 'basic';
    const ship = SHIP_TYPES[shipId];
    if (!p.gunCooldowns || p.gunCooldowns.length !== ship.guns.length) p.gunCooldowns = ship.guns.map(() => 0);
    // Per gun: cooldown = max(0, cooldown - dt); fire only when it's 0, then set the full cooldown.
    // No accumulated credit, so no catch-up bursts; at most one bullet per gun per tick.
    const wantFire = p.input.shoot || p.fireRequested;
    let firedAny = false;
    for (let gi = 0; gi < ship.guns.length; gi++) {
      p.gunCooldowns[gi] = Math.max(0, p.gunCooldowns[gi] - DT);
      if (!wantFire || p.gunCooldowns[gi] > 1e-9) continue;
      const g = ship.guns[gi];
      const speed = stats.bulletSpeed * g.speedMult;
      const m = gunMuzzle(SHIP_TYPES, shipId, gi, p.x, p.y, p.angle);
      const bullet = {
        id: nextBulletId++,
        x: wrapX(m.x),
        y: wrapY(m.y),
        vx: p.vx + m.dirX * speed,
        vy: p.vy + m.dirY * speed,
        life: BULLET_LIFE,
        ownerId: p.id,
        damage: stats.bulletDamage * g.damageMult,
        type: g.bullet,
        gun: gi,
      };
      bullets.push(bullet);
      bulletIndex.insert(bullet);
      p.gunCooldowns[gi] = stats.fireCooldown * g.cooldownMult;
      firedAny = true;
      if (DEBUG_FIRE) console.log(`[fire] p${p.id} gun ${gi} fired (held=${p.input.shoot} latched=${p.fireRequested})`);
    }
    if (firedAny) p.fireRequested = false; // a latched tap has produced its volley
  }
}

// Rocks near a living player (within ROCK_WAKE_CHUNKS chunks) this tick; the rest sleep.
let awakeRocks = [];

function updateAwakeRocks() {
  const keys = new Set();
  for (const [, p] of players) {
    if (p.dead) continue;
    const { cx, cy } = worldToChunk(p.x, p.y);
    for (let dx = -ROCK_WAKE_CHUNKS; dx <= ROCK_WAKE_CHUNKS; dx++)
      for (let dy = -ROCK_WAKE_CHUNKS; dy <= ROCK_WAKE_CHUNKS; dy++) keys.add(chunkKey(cx + dx, cy + dy));
  }
  awakeRocks = [];
  for (const k of keys) {
    const bucket = rockIndex.inChunk(k);
    if (bucket) for (const r of bucket) { r.awakeTick = physTick; awakeRocks.push(r); }
  }
}

function updateRocks() {
  const df = Math.exp(-ROCK_DRAG * DT);
  for (const rock of awakeRocks) {
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

// Each awake rock against rocks in nearby chunks. A pair of awake rocks is handled once (from the
// lower id); an awake rock touching a sleeping one is handled from the awake side.
function checkRockRockCollisions() {
  for (const a of awakeRocks) {
    for (const b of rockIndex.query(a.x, a.y, a.boundR + MAX_ROCK_BOUND_R)) {
      if (b === a || (b.awakeTick === physTick && b.id < a.id)) continue;
      const dx = torusDelta(a.x, b.x, WORLD_W);
      const dy = torusDelta(a.y, b.y, WORLD_H);
      // Broad phase: bounding circles of the actual silhouettes.
      if (dx * dx + dy * dy >= (a.boundR + b.boundR) ** 2) continue;

      // Narrow phase: SAT on convex hulls in b's frame (a offset by the torus delta).
      // MTV normal points from b toward a.
      const hullA = a.hull.map(([x, y]) => [x + dx, y + dy]);
      const mtv = polygonVsPolygonSAT(hullA, b.hull);
      if (!mtv) continue;

      const overlap = mtv.depth;
      const nx = mtv.nx;
      const ny = mtv.ny;

      const mA = a.mass;
      const mB = b.mass;
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

function updateBullets() {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x = wrapX(b.x + b.vx * DT);
    b.y = wrapY(b.y + b.vy * DT);
    b.life -= DT;
    bulletIndex.update(b);

    let hit = false;
    const bRadius = (BULLET_TYPES[b.type] || BULLET_TYPES.basic).r;
    const segLen = Math.hypot(b.vx, b.vy) * DT;

    // Swept test: segment from last tick's position to this one, against the exact silhouette of
    // each rock in nearby chunks (in the rock's frame). The earliest hit along the segment wins.
    let best = null; // { rock, t, x, y } with x/y relative to that rock
    for (const rock of rockIndex.query(b.x, b.y, segLen + MAX_ROCK_BOUND_R + bRadius)) {
      const bdx = torusDelta(b.x, rock.x, WORLD_W);
      const bdy = torusDelta(b.y, rock.y, WORLD_H);
      const pdx = bdx - b.vx * DT;
      const pdy = bdy - b.vy * DT;
      // Broad phase: segment's closest approach to the rock center vs bounding circle.
      if (distPointToSegment(0, 0, pdx, pdy, bdx, bdy) >= rock.boundR + bRadius) continue;

      let h = segmentVsPolygon(pdx, pdy, bdx, bdy, rock.poly);
      if (!h) {
        // Grazing pass within the bullet's radius of an edge.
        const c = circleVsPolygon(bdx, bdy, bRadius, rock.poly);
        if (c) h = { x: c.x, y: c.y, t: 1 };
      }
      if (h && (!best || h.t < best.t)) best = { rock, t: h.t, x: h.x, y: h.y };
    }

    if (best) {
      const rock = best.rock;
      const hx = wrapX(rock.x + best.x);
      const hy = wrapY(rock.y + best.y);
      queueHit(hx, hy, 'rock', rock.id, b.vx, b.vy, b.type);
      rock.hp -= b.damage;
      hit = true;
      if (rock.hp <= 0) destroyRock(rock, hx, hy);
    }

    if (!hit) {
      for (const p of playerIndex.query(b.x, b.y, MAX_SHIP_R + bRadius)) {
        if (p.id === b.ownerId || p.dead) continue;
        const pdx = torusDelta(b.x, p.x, WORLD_W), pdy = torusDelta(b.y, p.y, WORLD_H);
        const pd = Math.hypot(pdx, pdy);
        if (pd < shipR(p) + bRadius) {
          // Hit point: on the ship's circle, toward the bullet.
          const k = pd > 0 ? shipR(p) / pd : 0;
          const hitX = p.x + pdx * k, hitY = p.y + pdy * k;
          queueHit(hitX, hitY, 'player', p.id, b.vx, b.vy, b.type);
          const pStats = computeStats(p);
          p.hp = Math.max(0, p.hp - b.damage);
          p.regenCooldown = pStats.regenDelay;
          hit = true;
          if (p.hp <= 0) killPlayer(p, hitX, hitY);
          break;
        }
      }
    }

    if (hit || b.life <= 0) { bullets.splice(i, 1); bulletIndex.remove(b); }
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
    gemIndex.update(g);

    let removed = false;
    for (const p of playerIndex.query(g.x, g.y, GEM_MAGNET_RADIUS)) {
      if (p.dead) continue;
      const mdx = torusDelta(p.x, g.x, WORLD_W);
      const mdy = torusDelta(p.y, g.y, WORLD_H);
      const mdist = Math.hypot(mdx, mdy);
      if (mdist < GEM_MAGNET_RADIUS && mdist > 1) {
        const force = (1 - mdist / GEM_MAGNET_RADIUS) * GEM_MAGNET_FORCE;
        g.vx += (mdx / mdist) * force * DT;
        g.vy += (mdy / mdist) * force * DT;
      }
      if (mdist <= shipR(p) + g.r) {
        pickupQueue.push({ pickupId: g.id, kind: 'gold', playerId: p.id, x: Math.round(g.x), y: Math.round(g.y) });
        p.gemCount += g.value;
        gems.splice(i, 1);
        gemIndex.remove(g);
        removed = true;
        break;
      }
    }
    if (!removed && g.life <= 0) { gems.splice(i, 1); gemIndex.remove(g); }
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
    xpIndex.update(x);

    let removed = false;
    for (const p of playerIndex.query(x.x, x.y, XP_MAGNET_RADIUS)) {
      if (p.dead) continue;
      const mdx = torusDelta(p.x, x.x, WORLD_W);
      const mdy = torusDelta(p.y, x.y, WORLD_H);
      const mdist = Math.hypot(mdx, mdy);
      if (mdist < XP_MAGNET_RADIUS && mdist > 1) {
        const force = (1 - mdist / XP_MAGNET_RADIUS) * XP_MAGNET_FORCE;
        x.vx += (mdx / mdist) * force * DT;
        x.vy += (mdy / mdist) * force * DT;
      }
      if (mdist <= shipR(p) + x.r) {
        pickupQueue.push({ pickupId: x.id, kind: 'xp', playerId: p.id, x: Math.round(x.x), y: Math.round(x.y) });
        p.xpCount += x.value;
        p.totalXpEarned += x.value;
        const newLevel = getLevel(p.totalXpEarned);
        if (newLevel > p.level) {
          for (let l = p.level + 1; l <= newLevel; l++)
            if (AWARD_LEVELS.has(l)) p.upgradePoints++;
          p.level = newLevel;
          offerClassChoices(p);
        }
        xpDrops.splice(i, 1);
        xpIndex.remove(x);
        removed = true;
        break;
      }
    }
    if (!removed && x.life <= 0) { xpDrops.splice(i, 1); xpIndex.remove(x); }
  }
}

function checkPlayerRockCollisions() {
  for (const [, p] of players) {
    if (p.dead) continue;
    const stats = computeStats(p);
    const pr = shipR(p);

    for (const rock of rockIndex.query(p.x, p.y, pr + MAX_ROCK_BOUND_R)) {
      if (rock.removed) continue;
      const cdx = torusDelta(p.x, rock.x, WORLD_W);
      const cdy = torusDelta(p.y, rock.y, WORLD_H);

      // Broad phase: ship circle vs the silhouette's bounding circle.
      if (cdx * cdx + cdy * cdy >= (pr + rock.boundR) ** 2) continue;

      // Narrow phase: ship circle vs exact (possibly concave) rock silhouette, in the rock's frame.
      // Normal points from the rock surface toward the ship. Mirrored in checkLocalPlayerRockCollisions.
      const contact = circleVsPolygon(cdx, cdy, pr, rock.poly);
      if (!contact) continue;
      const nx = contact.nx, ny = contact.ny, overlap = contact.depth;

      const mP = pr * pr;
      const mR = rock.mass; // r² × kind massMult
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
        if (impact >= RAM_HIT_FX_MIN_IMPACT) {
          const cx = rock.x + contact.x, cy = rock.y + contact.y;
          queueHit(cx, cy, 'rock', rock.id, -nx, -ny);   // into the rock
          queueHit(cx, cy, 'player', p.id, nx, ny);      // into the ship
        }
        const baseDmg = Math.max(COLLISION_MIN_DAMAGE, impact / 10);
        const dmg = baseDmg + impact * COLLISION_DAMAGE_SCALE;
        const sizeRatio = rock.r / pr;

        const playerDmg = dmg * Math.pow(Math.max(0.5, sizeRatio), 0.75) * COLLISION_PLAYER_DMG_MULT;
        p.hp = Math.max(0, p.hp - playerDmg * (1 - stats.collisionShieldFrac));
        p.regenCooldown = stats.regenDelay;

        const rockDmg = dmg * Math.max(1, 1 / sizeRatio) * stats.bodyDamageScale / COLLISION_ROCK_DMG_DIV;
        rock.hp = Math.max(0, rock.hp - rockDmg);

        if (p.hp <= 0) killPlayer(p, rock.x + contact.x, rock.y + contact.y);
        if (rock.hp <= 0) destroyRock(rock, wrapX(rock.x + contact.x), wrapY(rock.y + contact.y));
      }
    }
  }
}

// --- main loop ---

function tick() {
  physTick++;
  updateAwakeRocks();
  updatePlayers();
  updateRocks();
  checkRockRockCollisions();
  updateBullets();
  updateGems();
  updateXpDrops();
  checkPlayerRockCollisions();
  // Collisions nudge positions: re-bucket everything that could have moved this tick.
  for (const r of awakeRocks) if (!r.removed) rockIndex.update(r);
  for (const [, p] of players) playerIndex.update(p);

  if (physTick % NET_RATE !== 0) return;

  const sendSlow   = physTick % SLOW_RATE === 0;
  const others = new Map(); // compact state, built once per send and shared by all recipients
  for (const [id, q] of players) others.set(id, serializeOther(q));

  for (const [, p] of players) {
    if (!wsReady(p.ws)) continue;

    const msg = {
      type: 'tick',
      online: players.size,
      // Yourself in full, others only when in view range (compact).
      players: [serialize(p), ...nearby(playerIndex, p.x, p.y, VIEW_RANGE).filter(q => q !== p).map(q => others.get(q.id))],
      bullets: nearby(bulletIndex, p.x, p.y, VIEW_RANGE)
        .map(b => ({ id: b.id, x: round1(b.x), y: round1(b.y), vx: Math.round(b.vx), vy: Math.round(b.vy), ownerId: b.ownerId,
                     angle: Math.round(Math.atan2(b.vy, b.vx) * 1000) / 1000, t: b.type, g: b.gun })),
    };

    if (sendSlow) {
      msg.rocks = nearby(rockIndex, p.x, p.y, VIEW_RANGE).map(serializeRock);
      msg.gems = nearby(gemIndex, p.x, p.y, VIEW_RANGE)
        .map(g => ({ id: g.id, x: g.x, y: g.y, r: g.r, vx: g.vx, vy: g.vy, coinType: g.coinType }));
      msg.xpDrops = nearby(xpIndex, p.x, p.y, VIEW_RANGE)
        .map(x => ({ id: x.id, x: x.x, y: x.y, r: x.r, vx: x.vx, vy: x.vy, xpType: x.xpType, xpVariant: x.xpVariant }));
    }

    const broken = brokenRockQueue.filter(e => torusDist(p.x, p.y, e.x, e.y) < VIEW_RANGE);
    if (broken.length) msg.brokenRocks = broken;
    const hits = hitQueue.filter(e => torusDist(p.x, p.y, e.x, e.y) < VIEW_RANGE);
    if (hits.length) msg.hits = hits;
    const pickups = pickupQueue.filter(e => torusDist(p.x, p.y, e.x, e.y) < VIEW_RANGE);
    if (pickups.length) msg.pickups = pickups;
    const died = playerDiedQueue.filter(e => torusDist(p.x, p.y, e.x, e.y) < VIEW_RANGE);
    if (died.length) msg.playerDied = died;

    send(p.ws, msg);
  }
  brokenRockQueue.length = 0;
  hitQueue.length = 0;
  pickupQueue.length = 0;
  playerDiedQueue.length = 0;
}

initRocks();
console.log(`World ${WORLD_W}×${WORLD_H} (${WORLD_MIN}…${WORLD_MAX}), ${CHUNKS_PER_AXIS}×${CHUNKS_PER_AXIS} chunks of ${CHUNK_SIZE}; ${rocks.length} rocks (${ROCKS_PER_CHUNK}/chunk); players spawn within ${SPAWN_RADIUS} of the origin`);
// Fixed-timestep loop: real elapsed time feeds an accumulator that runs whole DT ticks. setInterval(tick, 16.67)
// really ran every 16ms (Node truncates the delay → ~62 Hz) and lost time after stalls; this keeps 60 Hz on
// average, and after a stall runs at most MAX_CATCHUP_TICKS ticks (cooldowns make catch-up volleys impossible).
let loopAcc = 0;
let loopLast = performance.now();
function gameLoop() {
  const now = performance.now();
  loopAcc += (now - loopLast) / 1000;
  loopLast = now;
  let steps = 0;
  while (loopAcc >= DT && steps < MAX_CATCHUP_TICKS) { tick(); loopAcc -= DT; steps++; }
  if (loopAcc >= DT) loopAcc = 0; // stalled too long: drop the backlog instead of fast-forwarding
  setTimeout(gameLoop, Math.max(1, Math.floor((DT - loopAcc) * 1000)));
}
gameLoop();
