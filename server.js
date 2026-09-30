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
  circleVsPolygon, segmentVsPolygon, polygonVsPolygonSAT, pointInPolygon,
} from './shared/geometry.js';
import { CLASS_TREE, classChoicesFor, classById } from './shared/classes.js';
import { gunMuzzle } from './shared/guns.js';
import {
  WORLD_W, WORLD_H, WORLD_MIN, WORLD_MAX, CHUNK_SIZE, CHUNKS_PER_AXIS, CHUNK_COUNT, CHUNK_MIN,
  wrapX, wrapY, torusDelta, torusDist, worldToChunk, chunkKey, chunkKeyAt, forEachChunkInRange,
} from './shared/world.js';
import { getBiomeAt, getBiomeForChunk } from './shared/biomes.js';

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
// Per-class balance:
//   damageMult: × every bullet this class fires (after stats × gun multiplier), vs players and rocks.
//               Rock loot is unaffected (it uses LOOT_REFERENCE_DAMAGE).
//   viewFactor: × the client's 1920×1080 reference view and its corner cap (sent to the client).
//   sendRange:  network culling radius for a player of this class; must stay above the client's max
//               visible corner distance (1400 × viewFactor) plus the largest rock radius.
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
    bulletDamage: 5,      // ÷2.5 (was 12.5)
    maxSpeed: 650,
    accel: 900,
    fwdDrag: 0.8,
    latDrag: 7.0,
    turnSpeed: 3.0,
    bodyDamageScale: 1.0,
    collisionShieldFrac: 0.0,
    collisionPunchMult: 1.0,
    damageMult: 1.0,
    viewFactor: 0.736,  // 0.92 × 0.8
    sendRange: 1600,
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
    maxHp: 120,
    regenRate: 6,
    regenDelay: 2.0,
    fireCooldown: 0.25,
    bulletSpeed: 700,
    bulletDamage: 10,     // ÷2.5 (was 25)
    maxSpeed: 630,
    accel: 1000,
    fwdDrag: 0.8,
    latDrag: 7.0,
    turnSpeed: 3.3,
    bodyDamageScale: 1.3,
    collisionShieldFrac: 0.10,
    collisionPunchMult: 1.0,
    damageMult: 0.5,
    viewFactor: 0.8,    // 1.0 × 0.8
    sendRange: 1600,
    // Sprite 128×144. Short guns ±12px from center, long guns ±52px. At base stats: short 600 speed /
    // 7.2 dmg, long 850 speed / 14 dmg (damage ÷2.5 from the old 18 / 35; the multipliers keep the ratio).
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
    maxHp: 110,
    regenRate: 6,
    regenDelay: 2.0,
    fireCooldown: 0.25,
    bulletSpeed: 1000,
    bulletDamage: 5,      // ÷2.5 (was 12.5)
    maxSpeed: 600,
    accel: 800,
    fwdDrag: 0.8,
    latDrag: 7.0,
    turnSpeed: 2.6,
    bodyDamageScale: 0.8,
    collisionShieldFrac: 0.05,
    collisionPunchMult: 1.0,
    damageMult: 0.8,
    viewFactor: 1.0,    // 1.25 × 0.8
    sendRange: 2000,
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
  if (p.isPirate) return PIRATE_CONFIG.stats.r;
  return (SHIP_TYPES[p.shipType] || SHIP_TYPES.basic).r;
}

// Effective stats for any ship: players (class base × upgrades) or pirates (fixed, no upgrades).
function statsOf(p) {
  return p.isPirate ? PIRATE_STATS : computeStats(p);
}

// Death for any ship: players respawn, pirates drop their loot and are removed.
function killShip(p, hx, hy) {
  if (p.isPirate) killPirate(p, hx, hy);
  else killPlayer(p, hx, hy);
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
    collisionShieldFrac: Math.min(0.60, base.collisionShieldFrac + L('collisionShield') * 0.08),
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

// Upgrade point per level reached: every level 2–15, odd levels 17–29, then 33 and 36 (23 in total, none
// after 36). Points are only awarded for levels newly passed; saved accounts keep what they already have.
const AWARD_LEVELS = new Set([
  ...Array.from({ length: 14 }, (_, i) => 2 + i),      // 2..15
  ...Array.from({ length: 7 }, (_, i) => 17 + i * 2),  // 17, 19, …, 29
  33, 36,
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
// Network culling radius is per class: SHIP_TYPES[…].sendRange (see sendRange(p)).
const NET_RATE   = 2;    // send every Nth physics tick → 30 Hz
const SLOW_RATE  = 4;    // rocks/gems/xp every Nth → 15 Hz
let   physTick   = 0;

// --- Rock kinds + texture manifest ---
// Data-driven: a new kind is one entry here plus textures in public/textures/<dir>/<size>/*.svg
// (numeric folder name = texture width in px, r = size / 2). New sizes/variants need no code changes.
// How often each kind spawns is ROCK_SPAWN_TABLE (per biome), below.
//   sizeWeight(r): relative weight of each size folder within the kind (per folder, not per variant).
//   hpMult/massMult/goldMult/xpMult: relative to a normal rock of the same size.
//   collisionDamageMult: multiplies the damage a ship takes when it collides with the rock.

// Spawn weight per size folder (not per variant): small rocks are more common.
function rockSizeWeight(r) {
  if (r <= 48) return 1.5;
  if (r <= 88) return 1.0;
  return 0.7;
}

// --- Crystal rocks (Frost Nebula) ---
// A normal rock (112 or 128 px texture) with crystals stuck along its outline. The crystals are part of
// the rock's collision shape; when the rock breaks they fly outward as piercing shards.
const CRYSTAL_CONFIG = {
  spawnShare: 0.10,          // of Frost Nebula spawn rolls (ROCK_SPAWN_TABLE.frost.chances.crystal)
  rockSizes: [112, 128],     // normal rock texture sizes a crystal rock is built on
  textureDir: 'particles/cold', // crystal textures: every SVG in here, at native size
  count: [4, 7],             // crystals per rock (inclusive)
  gridSnap: 8,               // crystal centers snap to this grid (rock-local px)
  rotationStepDeg: 45,       // crystal rotation = random multiple of this
  colors: ['#BCC8EE', '#87B4E9', '#3C5787'],
  opacity: 0.8,              // crystals are drawn as solid silhouettes in their color at this opacity
  hpMult: 1.5,               // × a normal rock of the same size
  xpMult: 2,                 // loot: same gold as a normal rock of that size, this × the XP
  // Flight: from the rock center through the crystal center, easing out to a stop:
  //   distance(t) = flightRange × (1 − (1 − t/flightLife)²)  → start speed 2 × range / life ≈ 1286 units/s
  flightRange: 450,          // units, exact
  flightLife: 0.7,           // s
  fadeStart: 0.7,            // fraction of the life after which the crystal fades out (ease-in) to 0
  harmlessWhileFading: true, // no hits on ships or rocks once fading
  damage: 20,                // per target hit, every crystal the same
  drawOnTop: true,           // crystals over the rock (false: behind it)
};

// --- Explosion rocks (Ember Belt) ---
// A normal-looking rock (112 or 128 px texture) that shows red particles as it takes damage. On death:
// blast damage + knockback, a ring event, its particles fly out (like crystal shards), and it splits
// into 2–3 small extra rocks that carry the loot. The rock itself drops nothing.
const EXPLOSION_CONFIG = {
  spawnShare: 0.10,          // of Ember Belt spawn rolls (ROCK_SPAWN_TABLE.ember.chances.explosion)
  rockSizes: [112, 128],     // normal rock texture sizes an explosion rock is built on
  hpMult: 0.75,              // × a normal rock of the same size; no loot of its own
  textureDirs: ['particles/amber', 'particles/cold'], // particle textures (any size, native)
  maxParticles: 15,          // slots per rock; visible = round(max × (1 − hp / maxHp)), in slot order
  colors: ['#971E1D', '#E43B3B'],
  opacity: 0.6,              // solid silhouettes in their color
  gridSnap: 8,               // slot centers snap to this grid (rock-local px)
  rotationStepDeg: 45,
  particleMinGap: 16,        // px between slot centers where possible (re-rolled, best of several)
  popInTime: 0.15,           // s fade-in when a slot becomes visible
  blastRadius: 250,          // units, measured to the target's edge (ship radius / rock r)
  blastDamage: 30,           // at the center, falling off linearly to 0 at the edge
  knockbackShip: 600,        // units/s added at the center, linear falloff (ships are then capped at max speed)
  knockbackRock: 450,        // units/s added at the center, linear falloff (may briefly exceed ROCK_MAX_SPEED)
  ringDuration: 0.2,         // s, client ring from the center to blastRadius
  ringColor: '#E43B3B',
  particleRange: [200, 450], // units, rolled per particle (ease-out curve like crystals)
  particleLife: [1.2, 2.0],  // s, rolled per particle
  particleDamage: 20,
  fadeStart: 0.7,
  harmlessWhileFading: true,
  fragmentCount: [2, 3],
  fragmentSizes: [32, 64],   // normal rock texture sizes (inclusive) for the small rocks
  fragmentSpeed: [150, 220], // units/s outward, then normal rock drag
  fragmentLootMult: 1.5,     // × a normal rock of that size (gold and XP)
  fragmentLife: 120,         // s; then they fade out and are removed without loot
  fragmentFadeTime: 1.5,     // s of that fade (client)
};

const ROCK_KINDS = {
  normal: { dir: 'rocks',      sizeWeight: rockSizeWeight, hpMult: 1, massMult: 1, goldMult: 1, xpMult: 1, collisionDamageMult: 1 },
  // Kinds with fromKind reuse that kind's textures, filtered by sizeFilter (see below the loader).
  crystal: { fromKind: 'normal', sizeFilter: s => CRYSTAL_CONFIG.rockSizes.includes(s.size), sizeWeight: () => 1,
             hpMult: CRYSTAL_CONFIG.hpMult, massMult: 1, goldMult: 1, xpMult: CRYSTAL_CONFIG.xpMult, collisionDamageMult: 1 },
  explosion: { fromKind: 'normal', sizeFilter: s => EXPLOSION_CONFIG.rockSizes.includes(s.size), sizeWeight: () => 1,
               hpMult: EXPLOSION_CONFIG.hpMult, massMult: 1, goldMult: 0, xpMult: 0, collisionDamageMult: 1 },
  // Small extra rocks from an explosion: not spawned by the table, not counted toward ROCK_COUNT.
  fragment: { fromKind: 'normal', sizeFilter: s => s.size >= EXPLOSION_CONFIG.fragmentSizes[0] && s.size <= EXPLOSION_CONFIG.fragmentSizes[1],
              sizeWeight: () => 1, hpMult: 1, massMult: 1, goldMult: EXPLOSION_CONFIG.fragmentLootMult,
              xpMult: EXPLOSION_CONFIG.fragmentLootMult, collisionDamageMult: 1 },
  xp:     { dir: 'xporerocks', sizeWeight: () => 1,        hpMult: 2, massMult: 3, goldMult: 0, xpMult: 3, collisionDamageMult: 1 },
  gold:   { dir: 'goldrocks',  sizeWeight: () => 1,        hpMult: 2, massMult: 4, goldMult: 3, xpMult: 1, collisionDamageMult: 1.5 },
};

// BASE spawn chance per rock roll in the neutral zone. Env overrides for testing:
// XP_ROCK_CHANCE sets it for xp rocks, GOLD_ROCK_CHANCE for gold rocks (e.g. GOLD_ROCK_CHANCE=0.3).
function envChance(name, fallback) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
}
const XP_ROCK_BASE   = envChance('XP_ROCK_CHANCE', 0.05);
const GOLD_ROCK_BASE = envChance('GOLD_ROCK_CHANCE', 0.05);

// The one place that decides what spawns where, keyed by the biome at the spawn position:
//   chances:   kind → chance per spawn roll; 'normal' takes the remainder.
//   xpCluster: an xp roll spawns a cluster, [size, probability] (null = no xp rocks there). A cluster
//              needs cap room for its smallest size and is clipped to the room left.
const ROCK_SPAWN_TABLE = {
  wasteland: { chances: { xp: XP_ROCK_BASE,     gold: GOLD_ROCK_BASE },     xpCluster: [[1, 0.6], [2, 0.3], [3, 0.1]] },
  ember:     { chances: { xp: 0,                gold: 2 * GOLD_ROCK_BASE, explosion: EXPLOSION_CONFIG.spawnShare }, xpCluster: null },
  frost:     { chances: { xp: 2 * XP_ROCK_BASE, gold: 0, crystal: CRYSTAL_CONFIG.spawnShare }, xpCluster: [[2, 0.6], [3, 0.3], [4, 0.1]] },
};
for (const [biome, { chances }] of Object.entries(ROCK_SPAWN_TABLE)) { // big test overrides: keep each biome's sum ≤ 1
  const sum = Object.values(chances).reduce((a, c) => a + c, 0);
  if (sum > 1) {
    console.warn(`WARNING spawn chances in ${biome} add up to ${sum.toFixed(2)}; scaled down to 1`);
    for (const k in chances) chances[k] /= sum;
  }
}
const clusterAvg = sizes => (sizes ? sizes.reduce((a, [n, p]) => a + n * p, 0) : 0);
const clusterMin = sizes => (sizes ? Math.min(...sizes.map(([n]) => n)) : Infinity);

// XP cluster members sit XP_CLUSTER_DIST_MIN…MAX from another member (center to center), never
// overlapping (convex hulls), all in the same biome.
const XP_CLUSTER_DIST_MIN  = 150;
const XP_CLUSTER_DIST_MAX  = 300;
const XP_CLUSTER_TRIES     = 30;  // placement attempts per extra member

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

for (const kind of Object.values(ROCK_KINDS)) if (!kind.fromKind) kind.sizes = loadRockSizes(kind.dir);
for (const kind of Object.values(ROCK_KINDS)) {
  if (!kind.fromKind) continue;
  kind.dir = ROCK_KINDS[kind.fromKind].dir;
  kind.sizes = ROCK_KINDS[kind.fromKind].sizes.filter(kind.sizeFilter);
}

// Shape textures (crystals, explosion particles): every SVG in each folder at native size. Each path of the
// SVG becomes one exact polygon (same parser as rock silhouettes, but all paths kept: several crystals are
// made of overlapping pieces), centered on the texture center, positive winding. reach = max center→vertex.
// One registry for all of them; rocks and flying particles refer to textures by index into it.
function loadShapeTextures(dir) {
  const root = join(TEXTURES_DIR, dir);
  const files = existsSync(root) ? readdirSync(root).filter(f => f.toLowerCase().endsWith('.svg')).sort() : [];
  const out = [];
  for (const f of files) {
    const path = `${dir}/${f}`;
    const size = textureSize(join(root, f));
    if (!size) { console.warn(`  WARNING shape texture ${path}: no size (width/height/viewBox) — skipped`); continue; }
    const src = readFileSync(join(root, f), 'utf8');
    const polys = [];
    for (const m of src.matchAll(/<path\b[^>]*?\sd="([^"]+)"/g)) {
      const pts = cleanPoly(parseSvgPathD(m[1]));
      if (pts.length < 3 || Math.abs(polygonArea(pts)) < 1e-6) continue;
      const local = pts.map(([x, y]) => [x - size.w / 2, y - size.h / 2]);
      polys.push(polygonArea(local) < 0 ? local.reverse() : local);
    }
    if (!polys.length) { console.warn(`  WARNING shape texture ${path}: no usable path (<3 points) — skipped`); continue; }
    const reach = Math.max(...polys.flat().map(([x, y]) => Math.hypot(x, y)));
    out.push({ path, dir, w: size.w, h: size.h, polys, reach });
  }
  if (!out.length) console.warn(`  WARNING no usable textures in public/textures/${dir}/`);
  return out;
}
const SHAPE_TEXTURES = [...new Set([CRYSTAL_CONFIG.textureDir, ...EXPLOSION_CONFIG.textureDirs])].flatMap(loadShapeTextures);
const shapeIdsIn = dirs => SHAPE_TEXTURES.map((t, i) => (dirs.includes(t.dir) ? i : -1)).filter(i => i >= 0);
const CRYSTAL_TEX_IDS = shapeIdsIn([CRYSTAL_CONFIG.textureDir]);
const EXPLOSION_TEX_IDS = shapeIdsIn(EXPLOSION_CONFIG.textureDirs);
if (!CRYSTAL_TEX_IDS.length) ROCK_KINDS.crystal.sizes = [];
if (!EXPLOSION_TEX_IDS.length) ROCK_KINDS.explosion.sizes = [];
if (!ROCK_KINDS.fragment.sizes.length) console.warn(`  WARNING no normal rock textures of ${EXPLOSION_CONFIG.fragmentSizes.join('–')} px — explosions split into no small rocks`);
console.log(`Shape textures (${SHAPE_TEXTURES.length}): ` + SHAPE_TEXTURES.map(t => `${t.path.split('/').pop()} ${t.w}×${t.h} (${t.polys.length} path${t.polys.length > 1 ? 's' : ''})`).join(', '));
console.log(`Crystal rocks on sizes: ${ROCK_KINDS.crystal.sizes.map(s => s.size).join(', ') || 'none'}; ` +
  `explosion rocks on: ${ROCK_KINDS.explosion.sizes.map(s => `${s.size} (${s.textures.length})`).join(', ') || 'none'}; ` +
  `fragments from: ${ROCK_KINDS.fragment.sizes.map(s => `${s.size} (${s.textures.length})`).join(', ') || 'none'}`);
const CRYSTAL_MAX_REACH = CRYSTAL_TEX_IDS.length ? Math.max(...CRYSTAL_TEX_IDS.map(i => SHAPE_TEXTURES[i].reach)) : 0;
// Sent to clients in 'init'.
const SHAPE_TEXTURES_CLIENT = SHAPE_TEXTURES.map(({ path, w, h, polys }) => ({ path, w, h, polys }));
const CRYSTAL_CLIENT = {
  colors: CRYSTAL_CONFIG.colors, opacity: CRYSTAL_CONFIG.opacity,
  rotationStepDeg: CRYSTAL_CONFIG.rotationStepDeg, drawOnTop: CRYSTAL_CONFIG.drawOnTop, fadeStart: CRYSTAL_CONFIG.fadeStart,
};
const EXPLOSION_CLIENT = {
  colors: EXPLOSION_CONFIG.colors, opacity: EXPLOSION_CONFIG.opacity, rotationStepDeg: EXPLOSION_CONFIG.rotationStepDeg,
  maxParticles: EXPLOSION_CONFIG.maxParticles, popInTime: EXPLOSION_CONFIG.popInTime, fadeStart: EXPLOSION_CONFIG.fadeStart,
  blastRadius: EXPLOSION_CONFIG.blastRadius, knockbackShip: EXPLOSION_CONFIG.knockbackShip,
  ringDuration: EXPLOSION_CONFIG.ringDuration, ringColor: EXPLOSION_CONFIG.ringColor,
  gridSnap: EXPLOSION_CONFIG.gridSnap, fragmentFadeTime: EXPLOSION_CONFIG.fragmentFadeTime,
};

// Distance a flying particle has traveled (ease-out: speed falls linearly to 0 at the end of its life):
//   distance(t) = range × (1 − (1 − t/life)²)
function shardDistance(s) {
  const u = Math.min(1, Math.max(0, s.age / s.life));
  return s.range * (1 - (1 - u) * (1 - u));
}

const ROCK_TEXTURES = [...new Set(Object.values(ROCK_KINDS).flatMap(k => k.sizes.flatMap(s => s.textures)))];

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
  console.log(`  kind=${kindId} dir=${kind.dir} hp×${kind.hpMult} mass×${kind.massMult} gold×${kind.goldMult} xp×${kind.xpMult} collisionDmg×${kind.collisionDamageMult}`);
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
{ // Gold rock particles are drawn by the client (src/main.js GOLD_PARTICLE_FILES); listed here to catch missing files.
  const root = join(TEXTURES_DIR, 'particles/goldrock');
  const files = ['big', 'small'].flatMap(d => existsSync(join(root, d)) ? readdirSync(join(root, d)).filter(f => f.endsWith('.svg')).sort().map(f => `${d}/${f}`) : []);
  console.log(`Gold rock particles: ${files.length} files in textures/particles/goldrock: ${files.join(', ')}`);
  if (files.length !== 5) console.warn(`  WARNING expected 5 gold particle SVGs, found ${files.length}`);
}
console.log('Rock spawn chances per roll (normal = remainder), xp cluster sizes:');
for (const [biome, { chances, xpCluster }] of Object.entries(ROCK_SPAWN_TABLE)) {
  console.log(`  ${biome.padEnd(9)} ` + Object.entries(chances).map(([k, c]) => `${k}=${(c * 100).toFixed(1)}%`).join(' ') +
    `  xp cluster ${xpCluster ? xpCluster.map(([n, p]) => `${n}:${p * 100}%`).join(' ') : 'none'}`);
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

// Max alive per biome and special kind, in proportion to the spawn table: the expected count (rocks in
// that biome's share of the world × chance × cluster size for xp) × ROCK_CAP_HEADROOM. A roll for a kind
// at its cap spawns a normal rock instead.
const ROCK_CAP_HEADROOM = 1.5;
const BIOME_AREA_SHARE = (() => { // biomes are row bands: count rows per biome
  const rows = {};
  for (let cy = CHUNK_MIN; cy < CHUNK_MIN + CHUNKS_PER_AXIS; cy++) {
    const id = getBiomeForChunk(0, cy).id;
    rows[id] = (rows[id] || 0) + 1 / CHUNKS_PER_AXIS;
  }
  return rows;
})();
const ROCK_KIND_CAPS = Object.fromEntries(Object.entries(ROCK_SPAWN_TABLE).map(([biome, { chances, xpCluster }]) => [biome,
  Object.fromEntries(Object.entries(chances).map(([kindId, chance]) => [kindId,
    Math.ceil(ROCK_COUNT * (BIOME_AREA_SHARE[biome] || 0) * chance * (kindId === 'xp' ? clusterAvg(xpCluster) : 1) * ROCK_CAP_HEADROOM)])),
]));
console.log('Rock caps (max alive) per biome: ' + Object.entries(ROCK_KIND_CAPS)
  .map(([b, caps]) => `${b} ` + Object.entries(caps).map(([k, n]) => `${k}≤${n}`).join(' ')).join(' | '));
// Rocks in chunks with no living player within this many chunks sleep (no physics) until one comes near.
const ROCK_WAKE_CHUNKS = 2;
// Largest rock/ship radius: margins for chunk queries (entities are indexed by their center).
const MAX_ROCK_BOUND_R = Math.max(...ROCK_TEXTURES.map(t => t.boundR),
  ...ROCK_KINDS.crystal.sizes.flatMap(s => s.textures.map(t => t.boundR + CRYSTAL_CONFIG.gridSnap + CRYSTAL_MAX_REACH)));
const MAX_SHIP_R = Math.max(...Object.values(SHIP_TYPES).map(t => t.r));
const ROCK_DRAG = 1.8;
const ROCK_MAX_SPEED = 220;
const COLLISION_DAMAGE_SCALE = 0.06;
const COLLISION_MIN_DAMAGE = 2;
const COLLISION_PLAYER_DMG_MULT = 0.15; // share of collision damage the player takes
const COLLISION_ROCK_DMG_DIV = 3;       // collision damage dealt to rocks is divided by this

// Rock loot scales with how many reference bullets a normal rock of that size takes to break. A fixed
// reference (the basic bullet's damage before the ÷2.5 rebalance), so bullet balance never moves loot.
const LOOT_REFERENCE_DAMAGE = 12.5;
const GOLD_PER_BULLET = 0.9;
const XP_PER_BULLET   = 0.35;
const BULLET_LIFE = 0.85;
const BULLET_R = 3; // collision radius for bullets vs rock silhouettes (grazes within 3px count)

// Bullet types: texture (relative to /textures/, drawn at SHIP_TEXTURE_SCALE), collision radius and
// spread (degrees: each bullet's direction gets a uniform random offset within ±spread; upgrades don't
// change it) and scale (× the drawn size; optional, default 1). Speed/damage come from the firing ship's stats × gun multipliers. Same lifetime for all types.
const BULLET_TYPES = {
  basic:  { texture: 'ships/sniper/basicbullet.svg',                 r: BULLET_R * 2, spread: 3, scale: 2 },
  sniper: { texture: 'ships/sniper/sniperbullet.svg',                r: 8,        spread: 0.75 },
  short:  { texture: 'ships/prototwink/prototwinkshortbullet.svg',   r: BULLET_R, spread: 7 },
  long:   { texture: 'ships/prototwink/prototwinklongbullet.svg',    r: BULLET_R, spread: 4 },
};

resolveShipGuns();

// --- Pirates (AI ships in the wasteland): config, stats and ship variants ---
// Pirates fly with the same physics/input model as players (applyShipInput / fireShipGuns); their edge
// is decisions, movement and aim. Everything tunable lives here.
const PIRATE_CONFIG = {
  // Stats (like a ship type; pirates never use upgrades). Same regen/drag as basic, a bit slower.
  // Combat stats: HP 150, regen 12, body damage 2 (doubled from the original); bullet damage back to 4.
  stats: { r: 30, maxHp: 150, regenRate: 12, regenDelay: 2.0, fireCooldown: 0.25, bulletSpeed: 1000, bulletDamage: 4,
           maxSpeed: 580, accel: 820, fwdDrag: 0.8, latDrag: 7.0, turnSpeed: 2.8,
           bodyDamageScale: 2.0, collisionShieldFrac: 0, collisionPunchMult: 1.0 },
  textures: ['pirate1', 'pirate1_2', 'pirate1_3', 'pirate1_4', 'pirate1_5', 'pirate1_6'].map(n => `ships/pirate/${n}.svg`),
  gun: { x: 64, y: 16 },          // texture px: nose center (one gun, basic bullet)
  engines: [{ x: 64, y: 112 }],   // texture px, for the engine trail
  tint: '#C8D2FF',                // wasteland main color (its star tint; the wasteland has no other palette color)
  groupSize: [2, 3],
  groupCount: [3, 5],             // target number of groups, picked once at boot
  respawnDelay: 30,               // s after a whole group dies
  spawnMinPlayerDist: 1200,       // units from every player
  decisionHz: 10,                 // state/target/group decisions (staggered); steering/aim/fire every tick
  commitTime: [2, 3],             // s minimum before a group changes its mind (except when attacked / losing)
  engageDist: [450, 600],         // preferred distance to the target, per pirate
  fireRange: 800,
  aimTolerance: 5,                // deg: fire only when facing within this of the aim angle
  powerMargin: 1.3,               // start a fight only if group power ≥ this × target power
  lonePowerMargin: 2.5,           // a lone survivor needs a much weaker target...
  loneTargetHpFrac: 0.5,          // ...that is also below this HP fraction
  fleeRatio: 0.8,                 // group power / threat power below this → FLEE
  threatRadius: 900,              // players within this of the group count as present
  isolationRadius: 600,           // a target with no other player within this is "isolated"
  retreatHpFrac: 0.35,            // a member below this leaves the fight to regenerate
  loneRetreatHpFrac: 0.55,        // lone survivors retreat earlier
  rejoinHpFrac: 0.8,
  fleeTime: 4,                    // s minimum scatter before regrouping
  leash: 300,                     // units a chase may go past the wasteland border
  lootRadius: 600,
  patrolRadius: 1500,             // new patrol points within this of the group
  reactionDelay: [0.15, 0.25],    // s: aim uses a target snapshot refreshed at this interval
  aimError: [2, 4],               // deg: grows with target speed and distance
  dodgeChance: 0.6,
  dodgeRange: 300,                // watch player bullets within this
  dodgeLookahead: 0.5,            // s
  dodgeMargin: 20,                // units beyond the ship radius
  dodgeTime: 0.35,                // s of sidestep
  repositionEvery: [1.5, 3],      // s between repositioning moves while fighting
  repositionTime: [0.5, 0.9],     // s each move lasts
  flankAngles: [0, -60, 60],      // deg around the target, per member
  minSpacing: 150,                // units between group members
  avoidLookahead: 220,            // units ahead checked for rocks
  avoidMargin: 50,                // units of clearance kept from rocks
  lootBaseRockSize: 128,          // base death loot = a normal rock of this size (medium)
  idBase: 1000000,                // pirate ids never collide with player ids
};
const PIRATE_STATS = PIRATE_CONFIG.stats;
const PIRATE_DPS = PIRATE_STATS.bulletDamage / PIRATE_STATS.fireCooldown; // 16

// One ship variant per texture: `pirate_1` … `pirate_6`, same gun/engine layout, resolved like SHIP_TYPES.
const PIRATE_TYPES = Object.fromEntries(PIRATE_CONFIG.textures.map((texture, i) => {
  const tex = loadShipPoly(`textures/${texture}`);
  if (!tex) throw new Error(`pirate texture ${texture} not readable`);
  const toLocal = ({ x, y }) => ({ side: (x - tex.texW / 2) * SHIP_TEXTURE_SCALE, forward: -(y - tex.texH / 2) * SHIP_TEXTURE_SCALE });
  return [`pirate_${i + 1}`, {
    name: 'Pirate', texture, r: PIRATE_STATS.r, texW: tex.texW, texH: tex.texH,
    guns: [{ ...PIRATE_CONFIG.gun, bullet: 'basic', cooldownMult: 1, damageMult: 1, speedMult: 1, ...toLocal(PIRATE_CONFIG.gun) }],
    engines: PIRATE_CONFIG.engines.map(e => ({ ...e, ...toLocal(e) })),
  }];
}));

// Per-ship values the client needs to draw ships and predict collisions with the right radius.
// Built after resolveShipGuns() so the muzzle offsets exist.
const SHIP_TYPES_CLIENT = Object.fromEntries(Object.entries({ ...SHIP_TYPES, ...PIRATE_TYPES }).map(([id, t]) => [id, {
  name: t.name, texture: t.texture, r: t.r, viewFactor: t.viewFactor,
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

const XP_DESPAWN = 25;
const XP_MAGNET_RADIUS = 400;
const XP_MAGNET_FORCE = 1800;

const GEM_DESPAWN = 20;
const GEM_MAGNET_RADIUS = XP_MAGNET_RADIUS; // same reach as XP, always
const GEM_MAGNET_FORCE = 900;               // weaker pull than XP, so gold still flies in slower

// --- Pickup textures (gold coins, XP drops) ---
// Denominations 5/3/1 for both; each has a folder of texture variants read at boot:
//   public/textures/particles/gold/{1,3,5}gold/*, public/textures/particles/xp/{1,3,5}xp/*
// A new file in a folder is picked up on the next restart with no code change. Each texture's native
// size (SVG width/height attributes, or PNG pixel size) is its drawn size, and the pickup radius is
// that size × the ratio the 1-value pickups used before (gold: 12px coin → r 6; xp: 16px drop → r 5),
// taken on the texture's larger side. Clients get the lists in 'init' and draw the variant named by `tex`.
const PICKUP_DENOMS = [5, 3, 1]; // largest first: amounts are split like change
const PICKUP_KINDS = {
  gold: { dir: 'particles/gold', folder: d => `${d}gold`, radiusPerPx: 6 / 12 },
  xp:   { dir: 'particles/xp',   folder: d => `${d}xp`,   radiusPerPx: 5 / 16 },
};

// Native pixel size of an SVG (width/height attributes, else the viewBox) or a PNG (IHDR). null if unknown.
function textureSize(file) {
  const buf = readFileSync(file);
  if (file.toLowerCase().endsWith('.png')) {
    if (buf.length >= 24 && buf.toString('ascii', 12, 16) === 'IHDR') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    return null;
  }
  const head = buf.toString('utf8', 0, Math.min(buf.length, 2048));
  const tag = head.match(/<svg\b[^>]*>/i)?.[0] || '';
  const num = name => { const m = tag.match(new RegExp(`\\s${name}="([\\d.]+)(px)?"`)); return m ? parseFloat(m[1]) : NaN; };
  let w = num('width'), h = num('height');
  if (!(w > 0 && h > 0)) {
    const vb = tag.match(/viewBox="[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)"/);
    if (vb) { w = parseFloat(vb[1]); h = parseFloat(vb[2]); }
  }
  return w > 0 && h > 0 ? { w, h } : null;
}

// kind → denom → [{ path, w, h, r }]
const PICKUP_TEXTURES = Object.fromEntries(Object.entries(PICKUP_KINDS).map(([kindId, kind]) => [kindId,
  Object.fromEntries(PICKUP_DENOMS.map(d => {
    const rel = `${kind.dir}/${kind.folder(d)}`;
    const root = join(TEXTURES_DIR, rel);
    const files = existsSync(root) ? readdirSync(root).filter(f => /\.(svg|png)$/i.test(f)).sort() : [];
    const list = [];
    for (const f of files) {
      const size = textureSize(join(root, f));
      if (!size) { console.warn(`  WARNING ${rel}/${f}: no size (no width/height/viewBox) — skipped`); continue; }
      list.push({ path: `${rel}/${f}`, w: size.w, h: size.h, r: Math.max(size.w, size.h) * kind.radiusPerPx });
    }
    if (!list.length) console.warn(`  WARNING no textures in public/textures/${rel}/ — ${kindId} ${d} drops will draw as a fallback dot`);
    return [d, list];
  })),
]));
console.log('Pickup textures (drawn size → pickup radius):');
for (const [kindId, denoms] of Object.entries(PICKUP_TEXTURES)) {
  for (const d of PICKUP_DENOMS) {
    console.log(`  ${kindId} ${d}: ` + (denoms[d].map(t => `${t.path.split('/').pop()} ${t.w}×${t.h} → r ${t.r}`).join(', ') || 'none'));
  }
}
// Client copy for 'init': kind → denom → [{ path, w, h }]
const PICKUP_TEXTURES_CLIENT = Object.fromEntries(Object.entries(PICKUP_TEXTURES).map(([k, denoms]) => [k,
  Object.fromEntries(Object.entries(denoms).map(([d, list]) => [d, list.map(({ path, w, h }) => ({ path, w, h }))]))]));

// A random texture variant for one pickup: { tex (index, -1 if none), r }.
function pickPickupTexture(kindId, denom) {
  const list = PICKUP_TEXTURES[kindId][denom];
  if (!list.length) return { tex: -1, r: PICKUP_KINDS[kindId].radiusPerPx * 16 };
  const tex = Math.floor(Math.random() * list.length);
  return { tex, r: list[tex].r };
}

// Random spawn rotation for a pickup (cosmetic; collision is a circle), same for every client.
const randomRot = () => Math.round(Math.random() * Math.PI * 2 * 100) / 100;

// Split an amount like change: as many 5s as possible, then 3s, then 1s (12 → 5+5+1+1, 8 → 5+3).
function splitDenoms(total) {
  const out = [];
  let left = total;
  for (const d of PICKUP_DENOMS) while (left >= d) { out.push(d); left -= d; }
  return out;
}

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
const pirateIndex = new ChunkIndex();
const pirates = new Map(); // id → pirate ship (never in `players`: no lists, counts or accounts)
// Every ship (players and pirates) in the chunks around a point.
const shipsNear = (x, y, r) => playerIndex.query(x, y, r).concat(pirateIndex.query(x, y, r));
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

// Alive special rocks per `${biome}:${kind}` (biome at the spawn position), for ROCK_KIND_CAPS.
const aliveByBiomeKind = new Map();
function aliveCount(biome, kindId) { return aliveByBiomeKind.get(`${biome}:${kindId}`) || 0; }
function capRoom(biome, kindId) {
  const cap = ROCK_KIND_CAPS[biome]?.[kindId];
  return cap == null ? Infinity : cap - aliveCount(biome, kindId);
}

// Kind for one roll in a biome (ROCK_SPAWN_TABLE). Kinds without textures never spawn.
function rollRockKind(biome) {
  let roll = Math.random();
  for (const [kindId, chance] of Object.entries(ROCK_SPAWN_TABLE[biome]?.chances || {})) {
    if (roll < chance) return ROCK_KINDS[kindId]?.sizes.length ? kindId : 'normal';
    roll -= chance;
  }
  return 'normal';
}

function rollXpClusterSize(sizes) {
  let roll = Math.random();
  for (const [n, p] of sizes) { if (roll < p) return n; roll -= p; }
  return sizes[sizes.length - 1][0];
}

// Weighted pick of a size folder within a kind (weight per folder, not per variant), then a variant.
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
function pickRockTexture(kind) {
  const sizeEntry = pickRockSize(kind);
  return sizeEntry.textures[Math.floor(Math.random() * sizeEntry.textures.length)];
}

function makeRock(kindId, tex, x, y, biome) {
  const kind = ROCK_KINDS[kindId];
  const r = tex.r;
  const maxHp = Math.round(rockMaxHp(r) * kind.hpMult);
  const mass = r * r * kind.massMult; // used by every rock collision (player–rock and rock–rock)
  const angle = Math.random() * Math.PI * 2;
  const rock = { id: nextRockId++, kind: kindId, biome, x, y, r, mass, texturePath: tex.path, maxHp, hp: maxHp, vx: 0, vy: 0, angle };
  if (kindId === 'crystal') rock.crystals = placeCrystals(tex);
  if (kindId === 'explosion') rock.slots = placeExplosionSlots(tex);
  attachRockShape(rock, tex);
  return rock;
}

// Point at arc length `d` along a closed polygon (d wraps around the perimeter).
function pointAlongOutline(poly, d) {
  const lens = poly.map((p, i) => Math.hypot(poly[(i + 1) % poly.length][0] - p[0], poly[(i + 1) % poly.length][1] - p[1]));
  const total = lens.reduce((a, b) => a + b, 0);
  let t = ((d % total) + total) % total;
  for (let i = 0; i < poly.length; i++) {
    if (t <= lens[i] || i === poly.length - 1) {
      const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
      const u = lens[i] > 0 ? Math.min(1, t / lens[i]) : 0;
      return [ax + (bx - ax) * u, ay + (by - ay) * u];
    }
    t -= lens[i];
  }
  return poly[0];
}

// 4–7 crystals centered on the rock's outline (so each is part inside, part outside), in rock-local
// texture coordinates (before the rock's rotation), snapped to the grid. Spread evenly around the
// perimeter from a random start, with some jitter; a spot too close to an earlier crystal is re-rolled.
function placeCrystals(tex) {
  const C = CRYSTAL_CONFIG, poly = tex.localPoly;
  const n = C.count[0] + Math.floor(Math.random() * (C.count[1] - C.count[0] + 1));
  let perimeter = 0;
  for (let i = 0; i < poly.length; i++) perimeter += Math.hypot(poly[(i + 1) % poly.length][0] - poly[i][0], poly[(i + 1) % poly.length][1] - poly[i][1]);
  const spacing = perimeter / n, start = Math.random() * perimeter;
  const crystals = [];
  for (let i = 0; i < n; i++) {
    const texIdx = CRYSTAL_TEX_IDS[Math.floor(Math.random() * CRYSTAL_TEX_IDS.length)];
    const reach = SHAPE_TEXTURES[texIdx].reach;
    let best = null;
    for (let tries = 0; tries < 6; tries++) {
      const [px, py] = pointAlongOutline(poly, start + i * spacing + (Math.random() - 0.5) * spacing * 0.5);
      const x = Math.round(px / C.gridSnap) * C.gridSnap, y = Math.round(py / C.gridSnap) * C.gridSnap;
      const gap = Math.min(Infinity, ...crystals.map(c => Math.hypot(c.x - x, c.y - y) - (reach + SHAPE_TEXTURES[c.tex].reach) * 0.6));
      if (!best || gap > best.gap) best = { x, y, gap };
      if (gap >= 0) break;
    }
    crystals.push({
      tex: texIdx, x: best.x, y: best.y,
      rotStep: Math.floor(Math.random() * Math.round(360 / C.rotationStepDeg)),
      color: Math.floor(Math.random() * C.colors.length),
    });
  }
  return crystals;
}

// Explosion rock particle slots, fixed for the rock's life: centers anywhere inside the rock's outline
// (rock-local, before rotation), snapped to the grid, kept apart where possible (best of several rolls).
function placeExplosionSlots(tex) {
  const C = EXPLOSION_CONFIG, poly = tex.localPoly;
  const xs = poly.map(([x]) => x), ys = poly.map(([, y]) => y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const slots = [];
  for (let i = 0; i < C.maxParticles; i++) {
    let best = null;
    for (let tries = 0; tries < 30; tries++) {
      const x = Math.round((minX + Math.random() * (maxX - minX)) / C.gridSnap) * C.gridSnap;
      const y = Math.round((minY + Math.random() * (maxY - minY)) / C.gridSnap) * C.gridSnap;
      if (!pointInPolygon(x, y, poly)) continue;
      const gap = Math.min(Infinity, ...slots.map(sl => Math.hypot(sl.x - x, sl.y - y)));
      if (!best || gap > best.gap) best = { x, y, gap };
      if (gap >= C.particleMinGap) break;
    }
    if (!best) best = { x: 0, y: 0 };
    slots.push({
      tex: EXPLOSION_TEX_IDS[Math.floor(Math.random() * EXPLOSION_TEX_IDS.length)],
      x: best.x, y: best.y,
      rotStep: Math.floor(Math.random() * Math.round(360 / C.rotationStepDeg)),
      color: Math.floor(Math.random() * C.colors.length),
    });
  }
  return slots;
}

// A crystal's polygons relative to the rock center (rock rotation included), for collision.
function crystalPolysInRock(rock, c) {
  const rot = c.rotStep * CRYSTAL_CONFIG.rotationStepDeg * Math.PI / 180;
  return SHAPE_TEXTURES[c.tex].polys.map(lp => transformPoly(transformPoly(lp, c.x, c.y, rot), 0, 0, rock.angle));
}

// Not right next to a living player.
function nearLivingPlayer(x, y, clear) {
  return nearby(playerIndex, x, y, clear).some(p => !p.dead);
}

// Convex hulls of rock a overlap any of `others` or existing rocks nearby?
function rockOverlaps(a, others) {
  const near = rockIndex.query(a.x, a.y, a.boundR + MAX_ROCK_BOUND_R).concat(others);
  for (const b of near) {
    const dx = torusDelta(a.x, b.x, WORLD_W), dy = torusDelta(a.y, b.y, WORLD_H);
    if (dx * dx + dy * dy >= (a.boundR + b.boundR) ** 2) continue;
    if (polygonVsPolygonSAT(a.hull.map(([x, y]) => [x + dx, y + dy]), b.hull)) return true;
  }
  return false;
}

// One spawn roll: position first (anywhere, away from living players), the biome there picks the kind.
// Returns the new rocks (not yet added): one rock, or an xp cluster (sizes per biome).
function spawnRockGroup() {
  const clear = 300 + MAX_ROCK_BOUND_R + PLAYER_R;
  let x = rand(WORLD_MIN, WORLD_MAX), y = rand(WORLD_MIN, WORLD_MAX);
  for (let tries = 0; tries < 200 && nearLivingPlayer(x, y, clear); tries++) {
    x = rand(WORLD_MIN, WORLD_MAX);
    y = rand(WORLD_MIN, WORLD_MAX);
  }
  const biome = getBiomeAt(x, y).id;
  const clusterSizes = ROCK_SPAWN_TABLE[biome]?.xpCluster;
  let kindId = rollRockKind(biome);
  if (kindId === 'xp' && (!clusterSizes || capRoom(biome, 'xp') < clusterMin(clusterSizes))) kindId = 'normal';
  if (kindId !== 'xp' && kindId !== 'normal' && capRoom(biome, kindId) < 1) kindId = 'normal'; // gold, crystal, explosion

  const first = makeRock(kindId, pickRockTexture(ROCK_KINDS[kindId]), x, y, biome);
  if (kindId !== 'xp') return [first];

  const n = Math.min(rollXpClusterSize(clusterSizes), capRoom(biome, 'xp'));
  const members = [first];
  for (let i = 1; i < n; i++) {
    for (let tries = 0; tries < XP_CLUSTER_TRIES; tries++) {
      const anchor = members[Math.floor(Math.random() * members.length)];
      const a = Math.random() * Math.PI * 2, d = rand(XP_CLUSTER_DIST_MIN, XP_CLUSTER_DIST_MAX);
      const cx = wrapX(anchor.x + Math.cos(a) * d), cy = wrapY(anchor.y + Math.sin(a) * d);
      if (getBiomeAt(cx, cy).id !== biome || nearLivingPlayer(cx, cy, clear)) continue;
      const rock = makeRock('xp', pickRockTexture(ROCK_KINDS.xp), cx, cy, biome);
      if (rockOverlaps(rock, members)) continue;
      members.push(rock);
      break;
    }
  }
  return members;
}

// Rotated collision shapes, relative to the rock center (queries use torus deltas, so position is
// not baked in). Rocks never change angle, so this is computed once per rock instead of per tick.
// Call again if a rock's angle ever changes.
//   poly:   the rock's own exact silhouette
//   polys:  every exact shape of the rock: its silhouette plus each attached crystal's paths
//   hull:   convex hull of all of them (rock–rock and spawn checks); boundR covers them all
function attachRockShape(rock, tex = rockTexByPath.get(rock.texturePath)) {
  rock.poly   = transformPoly(tex.localPoly, 0, 0, rock.angle);
  rock.polys  = [rock.poly];
  rock.hull   = transformPoly(tex.hull, 0, 0, rock.angle);
  rock.boundR = tex.boundR;
  if (rock.crystals?.length) {
    for (const c of rock.crystals) rock.polys.push(...crystalPolysInRock(rock, c));
    const pts = rock.hull.concat(rock.polys.slice(1).flat());
    rock.hull = convexHull(pts);
    rock.boundR = Math.max(tex.boundR, ...pts.map(([x, y]) => Math.hypot(x, y)));
  }
}

function serializeRock(rock) {
  return {
    id: rock.id, k: rock.kind, x: Math.round(rock.x * 10) / 10, y: Math.round(rock.y * 10) / 10, r: rock.r,
    hp: Math.round(rock.hp), maxHp: rock.maxHp, vx: Math.round(rock.vx), vy: Math.round(rock.vy),
    texturePath: rock.texturePath, angle: Math.round(rock.angle * 1000) / 1000,
    // Crystals: [texture index, local x, local y, rotation step, color index] (CRYSTAL_CLIENT in init).
    ...(rock.crystals ? { cr: rock.crystals.map(c => [c.tex, c.x, c.y, c.rotStep, c.color]) } : {}),
    // Explosion particle slots: [texture index, local x, local y, rotation step, color index]; the client
    // shows round(max × (1 − hp / maxHp)) of them, in order.
    ...(rock.slots ? { ep: rock.slots.map(c => [c.tex, c.x, c.y, c.rotStep, c.color]) } : {}),
    // Fragment rocks: seconds left before they fade out (no loot).
    ...(rock.expiresAt != null ? { ttl: Math.max(0, Math.round((rock.expiresAt - simTime()) * 10) / 10) } : {}),
  };
}

// Gold coins worth totalGold in total, split 5/3/1; each coin gets a random texture of its denomination.
function spawnCoinsAt(x, y, totalGold) {
  for (const value of splitDenoms(totalGold)) {
    const angle = Math.random() * Math.PI * 2;
    const speed = rand(40, 140);
    const { tex, r } = pickPickupTexture('gold', value);
    const g = { id: nextGemId++, x, y, r,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      life: GEM_DESPAWN, value, tex, rot: randomRot() };
    gems.push(g);
    gemIndex.insert(g);
  }
}

// XP drops worth `amount` in total, split 5/3/1; each drop gets a random texture of its denomination.
function spawnXpAt(x, y, amount) {
  for (const value of splitDenoms(amount)) {
    const angle = Math.random() * Math.PI * 2;
    const speed = rand(30, 100);
    const { tex, r } = pickPickupTexture('xp', value);
    const d = {
      id: nextXpId++, x, y, r,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      life: XP_DESPAWN, value, tex, rot: randomRot(),
    };
    xpDrops.push(d);
    xpIndex.insert(d);
  }
}

// Round x up or down at random so the expected value equals x.
function stochRound(x) {
  const f = Math.floor(x);
  return f + (Math.random() < x - f ? 1 : 0);
}

// Expected loot (before random rounding). Based on a NORMAL rock of the same size (its HP, not the
// kind's scaled HP), then scaled per kind by goldMult/xpMult.
function rockLootValues(kindId, r) {
  const kind      = ROCK_KINDS[kindId];
  const bullets   = Math.ceil(rockMaxHp(r) / LOOT_REFERENCE_DAMAGE);
  const sizeBonus = 0.75 + r / 256;
  return { gold: bullets * GOLD_PER_BULLET * sizeBonus * kind.goldMult, xp: bullets * XP_PER_BULLET * sizeBonus * kind.xpMult };
}

function dropRockLoot(rock) {
  const loot = rockLootValues(rock.kind, rock.r);
  // Minimum 1 gold only for kinds that drop gold at all.
  const gold = loot.gold > 0 ? Math.max(1, stochRound(loot.gold)) : 0;
  const xp   = stochRound(loot.xp);
  if (gold > 0) spawnCoinsAt(rock.x, rock.y, gold);
  if (xp > 0) spawnXpAt(rock.x, rock.y, xp);
}

// Rocks destroyed since the last outgoing message. Flushed on the next send regardless of
// NET_RATE/SLOW_RATE tiers so clients never miss or delay a shatter effect.
const brokenRockQueue = [];

// Visual-feedback events since the last outgoing message. Like brokenRockQueue: flushed on the next
// send regardless of NET_RATE/SLOW_RATE, only to clients within their send range. Visual only.
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
  dropRockLoot(rock);
  brokenRockQueue.push({
    id: rock.id,
    x: Math.round(rock.x), y: Math.round(rock.y), r: rock.r,
    angle: Math.round(rock.angle * 100) / 100,
    vx: Math.round(rock.vx), vy: Math.round(rock.vy),
    texturePath: rock.texturePath,
    hx: Math.round(hx), hy: Math.round(hy),
  });
  // Death effects are queued, never run here: processRockDeaths() handles them after the collision loops.
  if (rock.crystals?.length) rockDeathQueue.push({ type: 'crystal', x: rock.x, y: rock.y, angle: rock.angle, crystals: rock.crystals });
  if (rock.kind === 'explosion') rockDeathQueue.push({ type: 'explosion', x: rock.x, y: rock.y, angle: rock.angle, slots: rock.slots, biome: rock.biome });
  unlistRock(rock);
  refillRocks();
}

// Take a rock out of the world (no loot, no effects).
function unlistRock(rock) {
  rock.removed = true;
  const i = rocks.indexOf(rock);
  if (i >= 0) rocks.splice(i, 1);
  rockIndex.remove(rock);
  const key = `${rock.biome}:${rock.kind}`;
  if (aliveByBiomeKind.has(key)) aliveByBiomeKind.set(key, aliveByBiomeKind.get(key) - 1);
  if (rock.extra) { extraRockCount--; fragmentRocks.delete(rock); }
}

// Extra rocks (explosion fragments) live in `rocks` but don't count toward ROCK_COUNT and aren't replaced.
let extraRockCount = 0;
const fragmentRocks = new Set();

function addRock(rock) {
  rocks.push(rock);
  rockIndex.insert(rock);
  const key = `${rock.biome}:${rock.kind}`;
  aliveByBiomeKind.set(key, (aliveByBiomeKind.get(key) || 0) + 1);
  if (rock.extra) { extraRockCount++; fragmentRocks.add(rock); }
}

// Keep about ROCK_COUNT rocks: spawn groups while below it (a cluster may overshoot by up to 3; the
// next breaks then don't spawn until the count is back under). Extra rocks don't count.
function refillRocks() {
  while (rocks.length - extraRockCount < ROCK_COUNT) for (const r of spawnRockGroup()) addRock(r);
}

// Simulation time in seconds (for fragment lifetimes).
const simTime = () => physTick * DT;

// Fragments past their lifetime fade out on the client and are removed here without loot.
function expireFragments() {
  const now = simTime();
  for (const rock of fragmentRocks) if (now >= rock.expiresAt) unlistRock(rock);
}

function initRocks() {
  refillRocks();
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
    shipType: p.shipType, upgrades: p.upgrades,
    th: !p.dead && (p.input.thrust || 0) > 0 ? 1 : 0, // thrusting (engine trail)
    name: p.name || 'Player',
  };
}

// The owner's effective movement stats (class base × upgrades), for the client's local prediction.
function moveStats(p) {
  const s = computeStats(p);
  return { maxSpeed: s.maxSpeed, accel: s.accel, fwdDrag: s.fwdDrag, latDrag: s.latDrag, turnSpeed: s.turnSpeed };
}

// Network culling radius for this player (per class).
function sendRange(p) {
  return (SHIP_TYPES[p.shipType] || SHIP_TYPES.basic).sendRange;
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
    rocks: nearby(rockIndex, player.x, player.y, sendRange(player)).map(serializeRock),
    rockShapes: ROCK_SHAPES,
    rockKinds: ROCK_KINDS_CLIENT,
    shipTypes: SHIP_TYPES_CLIENT,
    bulletTypes: BULLET_TYPES,
    shipTextureScale: SHIP_TEXTURE_SCALE,
    gems: nearby(gemIndex, player.x, player.y, sendRange(player)).map(g => ({ id: g.id, x: g.x, y: g.y, r: g.r, v: g.value, tex: g.tex, rot: g.rot })),
    xpDrops: nearby(xpIndex, player.x, player.y, sendRange(player)).map(x => ({ id: x.id, x: x.x, y: x.y, r: x.r, v: x.value, tex: x.tex, rot: x.rot })),
    pickupTextures: PICKUP_TEXTURES_CLIENT,
    shapeTextures: SHAPE_TEXTURES_CLIENT,
    crystals: CRYSTAL_CLIENT,
    explosions: EXPLOSION_CLIENT,
    move: moveStats(player),
    players: Array.from(players.values()).map(serialize),
    upgradeIds: UPGRADE_IDS,
    xpPerLevel: UPGRADE_XP_PER_LEVEL,
    maxUpgradeLevel: MAX_UPGRADE_LEVEL,
  });
  player.sentMoveKey = JSON.stringify(moveStats(player));
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
      } else if (msg.type === 'devPirates' && DEV_CHEATS) {
        // Dev only: a pirate group 500–700 units from this player, clear of rocks (not part of the population).
        for (let tries = 0; tries < 30; tries++) {
          const a = Math.random() * Math.PI * 2, d = 500 + Math.random() * 200;
          const x = wrapX(player.x + Math.cos(a) * d), y = wrapY(player.y + Math.sin(a) * d);
          if (clearOfRocks(x, y, 200)) { spawnPirateGroup(x, y, true); break; }
        }
      } else if (msg.type === 'pirateDebug' && DEV_CHEATS) {
        player.pirateDebug = !!msg.on;
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
    applyShipRegen(p, stats);
    applyShipInput(p, stats);
    playerIndex.update(p);

    const shipId = SHIP_TYPES[p.shipType] ? p.shipType : 'basic';
    if (fireShipGuns(p, SHIP_TYPES, shipId, stats, p.input.shoot || p.fireRequested)) {
      p.fireRequested = false; // a latched tap has produced its volley
    }
  }
}

// --- Ship physics shared by players and pirates ---
// Pirates use exactly these functions with their own `input` ({ angle, thrust, shoot }), so they fly,
// turn and shoot under the same rules as players.

function applyShipRegen(p, stats) {
  if (p.regenCooldown > 0) p.regenCooldown -= DT;
  if (p.regenCooldown <= 0 && p.hp < stats.maxHp) {
    p.hp = Math.min(stats.maxHp, p.hp + stats.regenRate * DT);
  }
}

// Turn toward input.angle at turnSpeed, thrust along the facing, forward/lateral drag, speed cap, move.
function applyShipInput(p, stats) {
  {
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
  }
}

// Guns: each has its own cooldown and fires whenever it is ready while `wantFire`.
// Bullets leave their own muzzle and fly straight along the ship's facing (p.angle, the angle it
// is drawn at), placed by the shared gunMuzzle() that the client's muzzle flash also uses.
// Per gun: cooldown = max(0, cooldown - dt); fire only when it's 0, then set the full cooldown.
// No accumulated credit, so no catch-up bursts; at most one bullet per gun per tick. Returns true if any fired.
function fireShipGuns(p, shipTable, shipId, stats, wantFire) {
  const ship = shipTable[shipId];
  if (!p.gunCooldowns || p.gunCooldowns.length !== ship.guns.length) p.gunCooldowns = ship.guns.map(() => 0);
  let firedAny = false;
  for (let gi = 0; gi < ship.guns.length; gi++) {
    p.gunCooldowns[gi] = Math.max(0, p.gunCooldowns[gi] - DT);
    if (!wantFire || p.gunCooldowns[gi] > 1e-9) continue;
    const g = ship.guns[gi];
    const speed = stats.bulletSpeed * g.speedMult;
    const m = gunMuzzle(shipTable, shipId, gi, p.x, p.y, p.angle);
    // Spread: this bullet's own random offset, applied to its direction before the ship's velocity.
    const spread = (BULLET_TYPES[g.bullet].spread || 0) * Math.PI / 180;
    const dir = m.angle + (Math.random() * 2 - 1) * spread;
    const bullet = {
      id: nextBulletId++,
      x: wrapX(m.x),
      y: wrapY(m.y),
      vx: p.vx + Math.cos(dir) * speed,
      vy: p.vy + Math.sin(dir) * speed,
      life: BULLET_LIFE,
      ownerId: p.id,
      ownerPirate: !!p.isPirate, // no friendly fire between pirates
      damage: stats.bulletDamage * g.damageMult * (ship.damageMult ?? 1),
      type: g.bullet,
      gun: gi,
    };
    bullets.push(bullet);
    bulletIndex.insert(bullet);
    p.gunCooldowns[gi] = stats.fireCooldown * g.cooldownMult;
    firedAny = true;
    if (DEBUG_FIRE) console.log(`[fire] p${p.id} gun ${gi} fired (held=${p.input.shoot} latched=${p.fireRequested})`);
  }
  return firedAny;
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
    // Knocked by a blast: may exceed ROCK_MAX_SPEED until drag brings it back under, then clamped as usual.
    if (rock.knocked && rs <= ROCK_MAX_SPEED) rock.knocked = false;
    if (rs > ROCK_MAX_SPEED && !rock.knocked) {
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

      // Every exact shape of the rock (its silhouette and attached crystals): hitting a crystal hits the rock.
      for (const poly of rock.polys) {
        let h = segmentVsPolygon(pdx, pdy, bdx, bdy, poly);
        if (!h) {
          // Grazing pass within the bullet's radius of an edge.
          const c = circleVsPolygon(bdx, bdy, bRadius, poly);
          if (c) h = { x: c.x, y: c.y, t: 1 };
        }
        if (h && (!best || h.t < best.t)) best = { rock, t: h.t, x: h.x, y: h.y };
      }
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
      for (const p of shipsNear(b.x, b.y, MAX_SHIP_R + bRadius)) {
        if (p.id === b.ownerId || p.dead) continue;
        if (b.ownerPirate && p.isPirate) continue; // no friendly fire between pirates
        const pdx = torusDelta(b.x, p.x, WORLD_W), pdy = torusDelta(b.y, p.y, WORLD_H);
        const pd = Math.hypot(pdx, pdy);
        if (pd < shipR(p) + bRadius) {
          // Hit point: on the ship's circle, toward the bullet.
          const k = pd > 0 ? shipR(p) / pd : 0;
          const hitX = p.x + pdx * k, hitY = p.y + pdy * k;
          queueHit(hitX, hitY, 'player', p.id, b.vx, b.vy, b.type);
          const pStats = statsOf(p);
          if (p.isPirate && !b.ownerPirate) { p.lastHitBy = b.ownerId; p.lastHitAt = simTime(); }
          p.hp = Math.max(0, p.hp - b.damage);
          p.regenCooldown = pStats.regenDelay;
          hit = true;
          if (p.hp <= 0) killShip(p, hitX, hitY);
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
    for (const p of shipsNear(g.x, g.y, GEM_MAGNET_RADIUS)) {
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
        if (p.isPirate) p.stolenGold += g.value; // pirates steal: dropped again when they die
        else p.gemCount += g.value;
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
    for (const p of shipsNear(x.x, x.y, XP_MAGNET_RADIUS)) {
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
        if (p.isPirate) {
          p.stolenXp += x.value;
        } else {
          p.xpCount += x.value;
          p.totalXpEarned += x.value;
          const newLevel = getLevel(p.totalXpEarned);
          if (newLevel > p.level) {
            for (let l = p.level + 1; l <= newLevel; l++)
              if (AWARD_LEVELS.has(l)) p.upgradePoints++;
            p.level = newLevel;
            offerClassChoices(p);
          }
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

// Players and pirates, for loops that treat every ship the same.
function allShips() {
  return pirates.size ? [...players.values(), ...pirates.values()] : players.values();
}

function checkPlayerRockCollisions() {
  for (const p of allShips()) {
    if (p.dead) continue;
    const stats = statsOf(p);
    const pr = shipR(p);

    for (const rock of rockIndex.query(p.x, p.y, pr + MAX_ROCK_BOUND_R)) {
      if (rock.removed) continue;
      const cdx = torusDelta(p.x, rock.x, WORLD_W);
      const cdy = torusDelta(p.y, rock.y, WORLD_H);

      // Broad phase: ship circle vs the silhouette's bounding circle.
      if (cdx * cdx + cdy * cdy >= (pr + rock.boundR) ** 2) continue;

      // Narrow phase: ship circle vs exact (possibly concave) rock silhouette, in the rock's frame.
      // Normal points from the rock surface toward the ship. Mirrored in checkLocalPlayerRockCollisions.
      // Deepest contact over the rock's exact shapes (silhouette and attached crystals).
      let contact = null;
      for (const poly of rock.polys) {
        const c = circleVsPolygon(cdx, cdy, pr, poly);
        if (c && (!contact || c.depth > contact.depth)) contact = c;
      }
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

        const playerDmg = dmg * Math.pow(Math.max(0.5, sizeRatio), 0.75) * COLLISION_PLAYER_DMG_MULT
          * (ROCK_KINDS[rock.kind]?.collisionDamageMult ?? 1);
        p.hp = Math.max(0, p.hp - playerDmg * (1 - stats.collisionShieldFrac));
        p.regenCooldown = stats.regenDelay;

        const rockDmg = dmg * Math.max(1, 1 / sizeRatio) * stats.bodyDamageScale / COLLISION_ROCK_DMG_DIV;
        rock.hp = Math.max(0, rock.hp - rockDmg);

        if (p.hp <= 0) killShip(p, rock.x + contact.x, rock.y + contact.y);
        if (rock.hp <= 0) destroyRock(rock, wrapX(rock.x + contact.x), wrapY(rock.y + contact.y));
      }
    }
  }
}

// --- Rock death effects and flying particles (crystal shards, explosion particles) ---
// destroyRock only queues death effects; processRockDeaths() runs after this tick's collision loops and
// drains the queue iteratively. A blast that destroys rocks queues their effects onto the same queue
// (handled later in the same drain); a flying particle that destroys a rock queues it during
// updateShards(), handled right after. Never recursive.
const rockDeathQueue = [];    // { type: 'crystal', x, y, angle, crystals } | { type: 'explosion', x, y, angle, slots, biome }
const blastQueue = [];        // blast ring events for clients: { x, y }
const shards = [];            // flying particles (generic)
let nextShardId = 1;

// One flying particle: starts at (x0, y0), moves along unit (dx, dy) by shardDistance(), keeps `rot`.
// kind: 'crystal' | 'ember' (client look-up for opacity and fade start).
function launchShard(o) {
  const tex = SHAPE_TEXTURES[o.tex];
  shards.push({
    id: nextShardId++, x: o.x0, y: o.y0, age: 0, ...o,
    polys: tex.polys.map(lp => transformPoly(lp, 0, 0, o.rot)), reach: tex.reach,
    hitPlayers: new Set(), hitRocks: o.hitRocks || new Set(), // piercing: each target at most once
  });
}

// Pieces attached to a rock (crystals, explosion slots) → world start points and outward directions.
function detachPieces(d, pieces, stepDeg, each) {
  const ca = Math.cos(d.angle), sa = Math.sin(d.angle), step = stepDeg * Math.PI / 180;
  for (const c of pieces) {
    const ox = c.x * ca - c.y * sa, oy = c.x * sa + c.y * ca; // piece center relative to the rock
    const len = Math.hypot(ox, oy);
    let dx = ox / len, dy = oy / len;
    if (!(len > 1e-6)) { const a = Math.random() * Math.PI * 2; dx = Math.cos(a); dy = Math.sin(a); }
    each(c, wrapX(d.x + ox), wrapY(d.y + oy), dx, dy, d.angle + c.rotStep * step);
  }
}

function processRockDeaths() {
  while (rockDeathQueue.length) {
    const d = rockDeathQueue.shift();
    if (d.type === 'crystal') {
      const C = CRYSTAL_CONFIG;
      detachPieces(d, d.crystals, C.rotationStepDeg, (c, x0, y0, dx, dy, rot) => launchShard({
        kind: 'crystal', x0, y0, dx, dy, rot, tex: c.tex, color: C.colors[c.color],
        range: C.flightRange, life: C.flightLife, fadeStart: C.fadeStart, harmless: C.harmlessWhileFading, damage: C.damage,
      }));
    } else if (d.type === 'explosion') {
      explode(d);
    }
  }
}

const randIn = ([a, b]) => a + Math.random() * (b - a);

// Explosion death, in order: blast damage, knockback, ring event, flying particles, small rocks.
function explode(d) {
  const C = EXPLOSION_CONFIG, R = C.blastRadius;
  // a) + b) Blast damage and knockback, linear falloff to 0 at the edge (distance to the target's edge).
  for (const p of shipsNear(d.x, d.y, R + MAX_SHIP_R)) {
    if (p.dead) continue;
    const dx = torusDelta(p.x, d.x, WORLD_W), dy = torusDelta(p.y, d.y, WORLD_H);
    const dist = Math.hypot(dx, dy), k = 1 - Math.max(0, dist - shipR(p)) / R;
    if (k <= 0) continue;
    const nx = dist > 1e-6 ? dx / dist : 1, ny = dist > 1e-6 ? dy / dist : 0;
    p.vx += nx * C.knockbackShip * k;
    p.vy += ny * C.knockbackShip * k;
    const hitX = p.x - nx * shipR(p), hitY = p.y - ny * shipR(p);
    queueHit(hitX, hitY, 'player', p.id, nx, ny);
    p.hp = Math.max(0, p.hp - C.blastDamage * k);
    p.regenCooldown = statsOf(p).regenDelay;
    if (p.hp <= 0) killShip(p, hitX, hitY);
  }
  for (const rock of rockIndex.query(d.x, d.y, R + MAX_ROCK_BOUND_R)) {
    if (rock.removed) continue;
    const dx = torusDelta(rock.x, d.x, WORLD_W), dy = torusDelta(rock.y, d.y, WORLD_H);
    const dist = Math.hypot(dx, dy), k = 1 - Math.max(0, dist - rock.r) / R;
    if (k <= 0) continue;
    const nx = dist > 1e-6 ? dx / dist : 1, ny = dist > 1e-6 ? dy / dist : 0;
    rock.vx += nx * C.knockbackRock * k;
    rock.vy += ny * C.knockbackRock * k;
    rock.knocked = true;
    queueHit(rock.x - nx * rock.r, rock.y - ny * rock.r, 'rock', rock.id, nx, ny);
    rock.hp -= C.blastDamage * k;
    if (rock.hp <= 0) destroyRock(rock, rock.x - nx * rock.r, rock.y - ny * rock.r); // its effects join the queue
  }
  // c) Ring for clients.
  blastQueue.push({ x: Math.round(d.x), y: Math.round(d.y) });
  // d) Particles fly out (each rolls its own range and life).
  const particles = [];
  detachPieces(d, d.slots || [], C.rotationStepDeg, (c, x0, y0, dx, dy, rot) => {
    const hitRocks = new Set();
    particles.push(hitRocks);
    launchShard({
      kind: 'ember', x0, y0, dx, dy, rot, tex: c.tex, color: C.colors[c.color],
      range: randIn(C.particleRange), life: randIn(C.particleLife), fadeStart: C.fadeStart,
      harmless: C.harmlessWhileFading, damage: C.particleDamage, hitRocks,
    });
  });
  // e) Small rocks, thrown outward; immune to this explosion's particles (pre-marked as hit).
  for (const frag of spawnFragments(d)) for (const hitRocks of particles) hitRocks.add(frag.id);
}

// 2–3 small extra rocks around the explosion center, not overlapping each other or other rocks.
function spawnFragments(d) {
  const C = EXPLOSION_CONFIG, kind = ROCK_KINDS.fragment;
  if (!kind.sizes.length) return [];
  const n = C.fragmentCount[0] + Math.floor(Math.random() * (C.fragmentCount[1] - C.fragmentCount[0] + 1));
  const placed = [], base = Math.random() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    for (let tries = 0; tries < 20; tries++) {
      const tex = pickRockTexture(kind);
      const a = base + (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.8;
      const dist = tex.r + 8 + Math.random() * 24;
      const rock = makeRock('fragment', tex, wrapX(d.x + Math.cos(a) * dist), wrapY(d.y + Math.sin(a) * dist), d.biome);
      if (rockOverlaps(rock, placed)) continue;
      const speed = randIn(C.fragmentSpeed);
      rock.vx = Math.cos(a) * speed;
      rock.vy = Math.sin(a) * speed;
      rock.knocked = true;
      rock.extra = true;
      rock.expiresAt = simTime() + C.fragmentLife;
      placed.push(rock);
      break;
    }
  }
  for (const rock of placed) addRock(rock);
  return placed;
}

// Exact polygon overlap (concave allowed): any edge crossing, or one containing the other.
function segmentsCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
function polygonsOverlap(A, B) {
  for (let i = 0; i < A.length; i++) {
    const [ax, ay] = A[i], [bx, by] = A[(i + 1) % A.length];
    for (let j = 0; j < B.length; j++) {
      const [cx, cy] = B[j], [dx, dy] = B[(j + 1) % B.length];
      if (segmentsCross(ax, ay, bx, by, cx, cy, dx, dy)) return true;
    }
  }
  return pointInPolygon(A[0][0], A[0][1], B) || pointInPolygon(B[0][0], B[0][1], A);
}

// Move flying particles; each pierces everything it touches (ships of every player, rocks of every kind),
// damaging each target once. They ignore bullets, other particles and pickups.
function updateShards() {
  for (let i = shards.length - 1; i >= 0; i--) {
    const s = shards[i];
    s.age += DT;
    if (s.age >= s.life) { shards.splice(i, 1); continue; }
    const dist = shardDistance(s);
    s.x = wrapX(s.x0 + s.dx * dist);
    s.y = wrapY(s.y0 + s.dy * dist);
    if (s.harmless && s.age >= s.fadeStart * s.life) continue; // fading: no more hits

    for (const p of shipsNear(s.x, s.y, s.reach + MAX_SHIP_R)) {
      if (p.dead || s.hitPlayers.has(p.id)) continue;
      const pdx = torusDelta(p.x, s.x, WORLD_W), pdy = torusDelta(p.y, s.y, WORLD_H); // ship relative to shard
      const pr = shipR(p);
      if (pdx * pdx + pdy * pdy >= (s.reach + pr) ** 2) continue;
      if (!s.polys.some(poly => circleVsPolygon(pdx, pdy, pr, poly))) continue;
      s.hitPlayers.add(p.id);
      const d = Math.hypot(pdx, pdy) || 1;
      const hitX = p.x - pdx / d * pr, hitY = p.y - pdy / d * pr;
      queueHit(hitX, hitY, 'player', p.id, s.dx, s.dy);
      p.hp = Math.max(0, p.hp - s.damage);
      p.regenCooldown = statsOf(p).regenDelay;
      if (p.hp <= 0) killShip(p, hitX, hitY);
    }

    for (const rock of rockIndex.query(s.x, s.y, s.reach + MAX_ROCK_BOUND_R)) {
      if (rock.removed || s.hitRocks.has(rock.id)) continue;
      const dx = torusDelta(s.x, rock.x, WORLD_W), dy = torusDelta(s.y, rock.y, WORLD_H); // shard relative to rock
      if (dx * dx + dy * dy >= (s.reach + rock.boundR) ** 2) continue;
      const moved = s.polys.map(poly => poly.map(([x, y]) => [x + dx, y + dy]));
      if (!moved.some(sp => rock.polys.some(rp => polygonsOverlap(sp, rp)))) continue;
      s.hitRocks.add(rock.id);
      queueHit(s.x, s.y, 'rock', rock.id, s.dx, s.dy);
      rock.hp -= s.damage;
      if (rock.hp <= 0) destroyRock(rock, s.x, s.y); // crystal/explosion rocks queue their death effects
    }
  }
}

// --- Pirate AI ---
// Decisions (group state, target, member retreat/loot) run at PIRATE_CONFIG.decisionHz, staggered by pirate
// id; steering, aim and fire run every tick and only ever set `input` ({ angle, thrust, shoot }), which the
// shared ship physics then applies exactly as for players. Queries are local (chunk indexes), never
// world-wide scans.
//   Group states: PATROL (roam the wasteland), LOOT (collect nearby pickups), ENGAGE (fight a target),
//                 FLEE (scatter away from an unwinnable fight, then regroup at a rally point).
//   Member override: RETREAT (low HP: break off, regenerate, rejoin).
const pirateGroups = new Set();  // { id, members: [pirate], state, targetId, since, commit, patrol, patrolSince, rally, dev }
const pirateRespawns = [];       // sim times at which to spawn a replacement group
let nextPirateId = PIRATE_CONFIG.idBase;
let nextPirateGroupId = 1;
const DEG = Math.PI / 180;
const rnd = ([a, b]) => a + Math.random() * (b - a);
const rndInt = ([a, b]) => a + Math.floor(Math.random() * (b - a + 1));
const PIRATE_DECISION_TICKS = Math.max(1, Math.round(TICK_RATE / PIRATE_CONFIG.decisionHz));
const PIRATE_TARGET_GROUPS = rndInt(PIRATE_CONFIG.groupCount); // picked once at boot

const isWasteland = (x, y) => getBiomeAt(wrapX(x), wrapY(y)).id === 'wasteland';
// Within the wasteland, or at most `leash` units past its border (biomes are horizontal bands).
const inLeash = (x, y) => isWasteland(x, y) || isWasteland(x, y + PIRATE_CONFIG.leash) || isWasteland(x, y - PIRATE_CONFIG.leash);

// A random point well inside the wasteland (within `radius` of (x, y) if given).
function randomWastelandPoint(x, y, radius) {
  for (let i = 0; i < 80; i++) {
    let px, py;
    if (x != null && i < 60) {
      const a = Math.random() * Math.PI * 2, d = radius * Math.sqrt(Math.random());
      px = wrapX(x + Math.cos(a) * d); py = wrapY(y + Math.sin(a) * d);
    } else {
      px = rand(WORLD_MIN, WORLD_MAX); py = rand(WORLD_MIN, WORLD_MAX);
    }
    if (isWasteland(px, py) && isWasteland(px, py + 256) && isWasteland(px, py - 256) && clearOfRocks(px, py, 150)) return { x: px, y: py };
  }
  return { x: x ?? 0, y: y ?? 0 };
}

function clearOfRocks(x, y, r) {
  for (const rock of rockIndex.query(x, y, r + MAX_ROCK_BOUND_R)) {
    if (torusDist(x, y, rock.x, rock.y) < rock.boundR + r) return false;
  }
  return true;
}

function makePirate(x, y, group) {
  const id = nextPirateId++;
  const now = simTime();
  return {
    id, isPirate: true, group, x, y, vx: 0, vy: 0, angle: Math.random() * Math.PI * 2,
    hp: PIRATE_STATS.maxHp, maxHp: PIRATE_STATS.maxHp, dead: false,
    input: { angle: 0, thrust: 0, shoot: false }, gunCooldowns: null, regenCooldown: 0,
    shipType: `pirate_${1 + Math.floor(Math.random() * PIRATE_CONFIG.textures.length)}`, // kept for life
    state: null, stateSince: now, stolenGold: 0, stolenXp: 0, lastHitBy: null, lastHitAt: -Infinity,
    prefDist: rnd(PIRATE_CONFIG.engageDist), decidePhase: id % PIRATE_DECISION_TICKS,
    snap: null, snapAt: 0, aimErr: 0,
    nextRepoAt: now + rnd(PIRATE_CONFIG.repositionEvery), repoUntil: 0, repoSide: 1,
    dodgeUntil: 0, dodgeAngle: 0, seenBullets: new Set(), lootTarget: null, cover: null, fleeSide: Math.random() < 0.5 ? -1 : 1,
    dbg: { st: 'PATROL', tg: null, aim: null },
  };
}

// A group of 2–3 around (cx, cy), each clear of rocks. `dev` groups aren't part of the population target.
function spawnPirateGroup(cx, cy, dev = false) {
  const g = { id: nextPirateGroupId++, members: [], state: 'PATROL', targetId: null, since: -Infinity, commit: 0,
              patrol: null, patrolSince: 0, rally: null, dev };
  const n = rndInt(PIRATE_CONFIG.groupSize);
  for (let i = 0; i < n; i++) {
    for (let tries = 0; tries < 20; tries++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.6, d = 60 + Math.random() * 80;
      const x = wrapX(cx + Math.cos(a) * d), y = wrapY(cy + Math.sin(a) * d);
      if (!clearOfRocks(x, y, PIRATE_STATS.r + 20)) continue;
      const m = makePirate(x, y, g);
      g.members.push(m);
      pirates.set(m.id, m);
      pirateIndex.insert(m);
      break;
    }
  }
  if (g.members.length) pirateGroups.add(g);
  return g;
}

// Keep PIRATE_TARGET_GROUPS groups: replacements spawn when due, in the wasteland, far from every player.
function managePirates() {
  const now = simTime();
  for (let i = pirateRespawns.length - 1; i >= 0; i--) {
    if (now < pirateRespawns[i]) continue;
    for (let tries = 0; tries < 40; tries++) {
      const pt = randomWastelandPoint();
      if (nearby(playerIndex, pt.x, pt.y, PIRATE_CONFIG.spawnMinPlayerDist).some(p => !p.dead)) continue;
      if (!clearOfRocks(pt.x, pt.y, 200)) continue;
      spawnPirateGroup(pt.x, pt.y);
      pirateRespawns.splice(i, 1);
      break;
    }
    // no valid spot this time: stays due and is retried on the next pass
  }
}

function killPirate(p, hx = p.x, hy = p.y) {
  if (p.dead) return;
  p.dead = true;
  playerDiedQueue.push({ // same death shatter event as players (client looks the ship up by id)
    id: p.id, x: Math.round(p.x), y: Math.round(p.y), angle: Math.round(p.angle * 100) / 100,
    vx: Math.round(p.vx), vy: Math.round(p.vy), shipType: p.shipType, color: PIRATE_CONFIG.tint,
    hx: Math.round(wrapX(hx)), hy: Math.round(wrapY(hy)),
  });
  // Base loot like a medium rock, plus everything it stole (normal 5/3/1 split).
  const base = rockLootValues('normal', PIRATE_CONFIG.lootBaseRockSize / 2);
  const gold = stochRound(base.gold) + p.stolenGold, xp = stochRound(base.xp) + p.stolenXp;
  if (gold > 0) spawnCoinsAt(p.x, p.y, gold);
  if (xp > 0) spawnXpAt(p.x, p.y, xp);
  pirates.delete(p.id);
  pirateIndex.remove(p);
  const g = p.group;
  g.members.splice(g.members.indexOf(p), 1);
  if (!g.members.length) {
    pirateGroups.delete(g);
    if (!g.dev) pirateRespawns.push(simTime() + PIRATE_CONFIG.respawnDelay);
  }
}

// Power = effective HP × DPS. Players: current HP (+ a quarter of max for regen), class guns, upgrades.
function playerDps(p) {
  const st = computeStats(p), ship = SHIP_TYPES[p.shipType] || SHIP_TYPES.basic;
  let dps = 0;
  for (const g of ship.guns) dps += st.bulletDamage * g.damageMult * (ship.damageMult ?? 1) / (st.fireCooldown * g.cooldownMult);
  return dps;
}
function playerPower(p) {
  return (p.hp + 0.25 * computeStats(p).maxHp) * playerDps(p);
}
// Group: summed HP × summed DPS of the living members (they focus one target).
function groupPower(g) {
  let hp = 0;
  for (const m of g.members) hp += m.hp;
  return hp * g.members.length * PIRATE_DPS;
}

function groupCentroid(g) {
  const a = g.members[0];
  let sx = 0, sy = 0;
  for (const m of g.members) { sx += torusDelta(m.x, a.x, WORLD_W); sy += torusDelta(m.y, a.y, WORLD_H); }
  return { x: wrapX(a.x + sx / g.members.length), y: wrapY(a.y + sy / g.members.length) };
}

const livePlayersNear = (x, y, r) => nearby(playerIndex, x, y, r).filter(p => !p.dead);

function setGroupState(g, state, targetId, now, force) {
  if (g.state === state && g.targetId === targetId) return;
  if (!force && now - g.since < g.commit) return; // hysteresis: minimum commit time
  g.state = state; g.targetId = targetId; g.since = now; g.commit = rnd(PIRATE_CONFIG.commitTime);
  if (state === 'FLEE') { const c = groupCentroid(g); g.rally = randomWastelandPoint(c.x, c.y, 2500); }
  if (state === 'PATROL') g.patrol = null;
}

// Group decision (by the group's first member, at the decision rate).
function groupDecide(g, now) {
  const C = PIRATE_CONFIG;
  const c = groupCentroid(g);
  const lone = g.members.length === 1;
  const myPower = groupPower(g);
  const near = livePlayersNear(c.x, c.y, C.threatRadius);
  const threatPower = near.reduce((a, p) => a + playerPower(p), 0);

  if (g.state === 'FLEE') {
    const clear = !g.members.some(m => livePlayersNear(m.x, m.y, C.threatRadius * 0.9).length);
    if (now - g.since >= C.fleeTime && clear) setGroupState(g, 'PATROL', null, now, true);
    return;
  }
  // Outmatched by everyone around: break off now.
  if (near.length && myPower < C.fleeRatio * threatPower) { setGroupState(g, 'FLEE', null, now, true); return; }

  // Attacked: the whole group turns on the attacker if it can win, otherwise flees.
  let attacker = null;
  for (const m of g.members) {
    if (m.lastHitBy != null && now - m.lastHitAt < 1.5) {
      const a = players.get(m.lastHitBy);
      if (a && !a.dead) { attacker = a; break; }
    }
  }
  if (attacker && g.targetId !== attacker.id) {
    if (myPower >= playerPower(attacker) && inLeash(attacker.x, attacker.y)) setGroupState(g, 'ENGAGE', attacker.id, now, true);
    else setGroupState(g, 'FLEE', null, now, true);
    return;
  }

  if (g.state === 'ENGAGE') {
    const t = players.get(g.targetId);
    if (!t || t.dead || !inLeash(t.x, t.y) || torusDist(c.x, c.y, t.x, t.y) > C.threatRadius * 1.6) {
      setGroupState(g, 'PATROL', null, now, true); // target gone or leash exceeded: give up, return
      return;
    }
    // Keep fighting while it's still winnable (1.0×), a looser bar than the 1.3× needed to start.
    if (myPower < playerPower(t)) setGroupState(g, 'FLEE', null, now, false);
    return;
  }

  // PATROL / LOOT: pick a fight only with a clearly weaker, preferably damaged/isolated/low-level target.
  const margin = lone ? C.lonePowerMargin : C.powerMargin;
  let best = null, bestScore = -Infinity;
  for (const p of near) {
    if (!inLeash(p.x, p.y)) continue;
    const st = computeStats(p), hpFrac = p.hp / st.maxHp;
    if (lone && hpFrac > C.loneTargetHpFrac) continue;
    const others = livePlayersNear(p.x, p.y, C.isolationRadius).filter(q => q !== p);
    const power = playerPower(p) + others.reduce((a, q) => a + playerPower(q), 0); // their friends count too
    if (myPower < margin * power) continue; // never start fights with strong players
    const score = 2 * (1 - hpFrac) + (others.length ? 0 : 1) + 1 / (1 + (p.level || 1) / 10)
      + (1 - Math.min(1, playerDps(p) / 100)) - torusDist(c.x, c.y, p.x, p.y) / C.threatRadius;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  if (best) { setGroupState(g, 'ENGAGE', best.id, now, false); if (g.state === 'ENGAGE') return; }

  const hasLoot = gemIndex.query(c.x, c.y, C.lootRadius).concat(xpIndex.query(c.x, c.y, C.lootRadius))
    .some(o => torusDist(c.x, c.y, o.x, o.y) < C.lootRadius);
  setGroupState(g, hasLoot ? 'LOOT' : 'PATROL', null, now, false);
  if (g.state === 'PATROL' && (!g.patrol || torusDist(c.x, c.y, g.patrol.x, g.patrol.y) < 250 || now - g.patrolSince > 20)) {
    g.patrol = randomWastelandPoint(c.x, c.y, C.patrolRadius);
    g.patrolSince = now;
  }
}

function nearestThreat(m, r) {
  let best = null, bd = Infinity;
  for (const p of livePlayersNear(m.x, m.y, r)) {
    const d = torusDist(m.x, m.y, p.x, p.y);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

// A spot behind a nearby rock as seen from the threat (the rock ends up between them), or null.
function coverPoint(m, threat) {
  let best = null, bd = Infinity;
  for (const rock of rockIndex.query(m.x, m.y, 500)) {
    const tx = torusDelta(rock.x, threat.x, WORLD_W), ty = torusDelta(rock.y, threat.y, WORLD_H);
    const tl = Math.hypot(tx, ty) || 1;
    const cx = wrapX(rock.x + tx / tl * (rock.boundR + 80)), cy = wrapY(rock.y + ty / tl * (rock.boundR + 80));
    const d = torusDist(m.x, m.y, cx, cy);
    if (d < 500 && d < bd && torusDist(threat.x, threat.y, cx, cy) > torusDist(threat.x, threat.y, m.x, m.y)) { bd = d; best = { x: cx, y: cy }; }
  }
  return best;
}

// Member decision: retreat on low HP, rejoin when healed; loot assignment; cover spot.
function memberDecide(m, g, now) {
  const C = PIRATE_CONFIG;
  const hpFrac = m.hp / m.maxHp, lone = g.members.length === 1;
  if (m.state === 'RETREAT') {
    if (hpFrac >= C.rejoinHpFrac && !nearestThreat(m, 700) && now - m.stateSince > 2) { m.state = null; m.stateSince = now; }
  } else if (g.state === 'ENGAGE' && hpFrac < (lone ? C.loneRetreatHpFrac : C.retreatHpFrac)) {
    m.state = 'RETREAT'; m.stateSince = now;
  }
  if (m.state === 'RETREAT' || g.state === 'FLEE') {
    const threat = nearestThreat(m, C.threatRadius);
    m.cover = threat ? coverPoint(m, threat) : null;
  }
  m.lootTarget = null;
  if (g.state === 'LOOT') {
    const claimed = new Set(g.members.filter(o => o !== m && o.lootTarget).map(o => o.lootTarget));
    let bd = Infinity;
    for (const o of gemIndex.query(m.x, m.y, C.lootRadius).concat(xpIndex.query(m.x, m.y, C.lootRadius))) {
      if (claimed.has(o)) continue;
      const d = torusDist(m.x, m.y, o.x, o.y);
      if (d < bd && d < C.lootRadius) { bd = d; m.lootTarget = o; }
    }
  }
}

// Push away from rocks ahead along (dx, dy) (unit), and away from any rock we're about to touch.
function rockAvoidance(m, dx, dy) {
  const C = PIRATE_CONFIG, r = PIRATE_STATS.r;
  let ax = 0, ay = 0;
  const px = -dy, py = dx;
  for (const rock of rockIndex.query(m.x, m.y, C.avoidLookahead + MAX_ROCK_BOUND_R)) {
    const rx = torusDelta(rock.x, m.x, WORLD_W), ry = torusDelta(rock.y, m.y, WORLD_H);
    const reach = C.avoidLookahead + rock.boundR;
    const along = rx * dx + ry * dy;
    if (along < -rock.boundR || along > reach) continue;
    const lateral = rx * px + ry * py, clear = rock.boundR + r + C.avoidMargin;
    if (Math.abs(lateral) >= clear) continue;
    const k = (1 - Math.abs(lateral) / clear) * (1 - Math.max(0, along) / reach) * 2.5;
    const side = lateral >= 0 ? -1 : 1;
    ax += px * side * k; ay += py * side * k;
  }
  return [ax, ay];
}

function separation(m) {
  let sx = 0, sy = 0;
  const S = PIRATE_CONFIG.minSpacing;
  for (const o of m.group.members) {
    if (o === m) continue;
    const dx = torusDelta(m.x, o.x, WORLD_W), dy = torusDelta(m.y, o.y, WORLD_H), d = Math.hypot(dx, dy);
    if (d > 1e-6 && d < S) { const k = (1 - d / S) * 1.5; sx += dx / d * k; sy += dy / d * k; }
  }
  return [sx, sy];
}

// Face toward a relative goal (plus avoidance/separation) and thrust once roughly facing it.
function steerToward(m, dx, dy, throttle) {
  const len = Math.hypot(dx, dy) || 1;
  let vx = dx / len, vy = dy / len;
  const [ax, ay] = rockAvoidance(m, vx, vy);
  const [sx, sy] = separation(m);
  vx += ax + sx; vy += ay + sy;
  const ang = Math.atan2(vy, vx);
  m.input.angle = ang;
  const diff = Math.abs(shortestAngleDelta(m.angle, ang));
  const arrive = Math.min(1, len / 150);
  m.input.thrust = diff < 0.5 ? throttle * arrive : diff < 1.2 ? throttle * 0.35 * arrive : 0;
}
const steerTo = (m, x, y, throttle) => steerToward(m, torusDelta(x, m.x, WORLD_W), torusDelta(y, m.y, WORLD_H), throttle);

// A player bullet that will pass within reach in the next dodgeLookahead: decide once per bullet, dodge dodgeChance of the time.
function checkDodge(m, now) {
  const C = PIRATE_CONFIG, reach = PIRATE_STATS.r + C.dodgeMargin;
  if (m.seenBullets.size > 64) m.seenBullets.clear();
  for (const b of bulletIndex.query(m.x, m.y, C.dodgeRange)) {
    if (b.ownerPirate || m.seenBullets.has(b.id)) continue;
    const rx = torusDelta(b.x, m.x, WORLD_W), ry = torusDelta(b.y, m.y, WORLD_H);
    const vx = b.vx - m.vx, vy = b.vy - m.vy, v2 = vx * vx + vy * vy;
    if (v2 < 1) continue;
    const t = -(rx * vx + ry * vy) / v2;
    if (t < 0 || t > C.dodgeLookahead) continue;
    if (Math.hypot(rx + vx * t, ry + vy * t) > reach) continue;
    m.seenBullets.add(b.id);
    if (Math.random() >= C.dodgeChance) continue;
    // Sidestep perpendicular to the bullet, toward the side we're already on.
    const ba = Math.atan2(b.vy, b.vx), side = (b.vx * -ry - b.vy * -rx) >= 0 ? 1 : -1;
    m.dodgeAngle = ba + side * Math.PI / 2;
    m.dodgeUntil = now + C.dodgeTime;
    return true;
  }
  return false;
}

// Line of fire to (dx, dy) relative: blocked by a rock or a fellow pirate?
function clearShot(m, dx, dy, dist) {
  const mx = wrapX(m.x + dx / 2), my = wrapY(m.y + dy / 2);
  for (const rock of rockIndex.query(mx, my, dist / 2 + MAX_ROCK_BOUND_R)) {
    const rx = torusDelta(rock.x, m.x, WORLD_W), ry = torusDelta(rock.y, m.y, WORLD_H);
    if (distPointToSegment(rx, ry, 0, 0, dx, dy) < rock.r * 0.85) return false;
  }
  for (const o of m.group.members) {
    if (o === m) continue;
    const ox = torusDelta(o.x, m.x, WORLD_W), oy = torusDelta(o.y, m.y, WORLD_H);
    if (distPointToSegment(ox, oy, 0, 0, dx, dy) < 45) return false;
  }
  return true;
}

// Fight: hold the preferred distance at a flank slot, lead the (slightly outdated) target, reposition often.
function pirateCombat(m, g, t, now) {
  const C = PIRATE_CONFIG;
  if (!m.snap || now >= m.snapAt) { // reaction delay + fresh aim error
    const dist0 = torusDist(m.x, m.y, t.x, t.y), spd = Math.hypot(t.vx, t.vy);
    const k = (Math.min(1, spd / 600) + Math.min(1, dist0 / C.fireRange)) / 2;
    m.snap = { x: t.x, y: t.y, vx: t.vx, vy: t.vy, t: now };
    m.snapAt = now + rnd(C.reactionDelay);
    m.aimErr = (Math.random() * 2 - 1) * (C.aimError[0] + (C.aimError[1] - C.aimError[0]) * k) * DEG;
  }
  const age = now - m.snap.t;
  const Dx = torusDelta(m.snap.x + m.snap.vx * age, m.x, WORLD_W), Dy = torusDelta(m.snap.y + m.snap.vy * age, m.y, WORLD_H);
  const dist = Math.hypot(Dx, Dy);
  // Lead: bullets inherit our velocity, so solve |D + (Vt − Vp)·t| = bulletSpeed·t.
  const Wx = m.snap.vx - m.vx, Wy = m.snap.vy - m.vy, s = PIRATE_STATS.bulletSpeed;
  const qa = Wx * Wx + Wy * Wy - s * s, qb = 2 * (Dx * Wx + Dy * Wy), qc = Dx * Dx + Dy * Dy;
  let tHit = dist / s;
  const disc = qb * qb - 4 * qa * qc;
  if (Math.abs(qa) > 1e-6 && disc >= 0) {
    const r1 = (-qb - Math.sqrt(disc)) / (2 * qa), r2 = (-qb + Math.sqrt(disc)) / (2 * qa);
    const pos = [r1, r2].filter(v => v > 0);
    if (pos.length) tHit = Math.min(...pos);
  }
  const ax = Dx + Wx * tHit, ay = Dy + Wy * tHit;
  const aimAngle = Math.atan2(ay, ax) + m.aimErr;
  m.dbg.tg = [Math.round(t.x), Math.round(t.y)];
  m.dbg.aim = [Math.round(wrapX(m.x + ax)), Math.round(wrapY(m.y + ay))];

  // Flank slot around the target: group spread at −60°/0°/+60° from the target→group direction.
  const c = groupCentroid(g);
  const baseAng = Math.atan2(torusDelta(c.y, t.y, WORLD_H), torusDelta(c.x, t.x, WORLD_W));
  const slotAng = baseAng + (C.flankAngles[g.members.indexOf(m) % C.flankAngles.length] || 0) * DEG;

  if (now >= m.nextRepoAt) {
    m.repoUntil = now + rnd(C.repositionTime);
    m.nextRepoAt = m.repoUntil + rnd(C.repositionEvery);
    m.repoSide = Math.random() < 0.5 ? -1 : 1;
  }
  if (now < m.repoUntil) {
    // Reposition: thrust to a new flank angle (off-axis), drifting while turning back later.
    const a2 = slotAng + m.repoSide * 35 * DEG;
    steerToward(m, Dx + Math.cos(a2) * m.prefDist, Dy + Math.sin(a2) * m.prefDist, 1);
  } else {
    m.input.angle = aimAngle;
    const facing = Math.abs(shortestAngleDelta(m.angle, aimAngle));
    const [avx, avy] = rockAvoidance(m, Math.cos(m.angle), Math.sin(m.angle));
    const rockAhead = Math.hypot(avx, avy) > 0.5;
    const [bvx, bvy] = rockAvoidance(m, -Math.cos(m.angle), -Math.sin(m.angle));
    const rockBehind = Math.hypot(bvx, bvy) > 0.5;
    if (dist > m.prefDist + 60) m.input.thrust = facing < 0.6 && !rockAhead ? 1 : 0; // close in
    else if (dist < m.prefDist - 60) m.input.thrust = rockBehind ? 0 : -0.5;       // back off (reverse)
    else m.input.thrust = 0;                                                        // hold, drift
  }
  const facing = Math.abs(shortestAngleDelta(m.angle, aimAngle));
  if (facing < C.aimTolerance * DEG && dist < C.fireRange && clearShot(m, Dx, Dy, dist)) m.input.shoot = true;
}

// Safety layer after any state's steering: if the ship's actual drift is about to carry it into a rock
// (within ~0.6 s), swerve away and brake with whatever thrust the current facing allows.
function avoidImminentRock(m) {
  const speed = Math.hypot(m.vx, m.vy);
  if (speed < 40) return;
  const dx = m.vx / speed, dy = m.vy / speed, px = -dy, py = dx, r = PIRATE_STATS.r;
  let hit = null, hitAlong = Infinity;
  for (const rock of rockIndex.query(m.x, m.y, speed * 0.6 + MAX_ROCK_BOUND_R + r)) {
    const rx = torusDelta(rock.x, m.x, WORLD_W), ry = torusDelta(rock.y, m.y, WORLD_H);
    const along = rx * dx + ry * dy, lateral = rx * px + ry * py;
    if (along < 0 || along > speed * 0.6 + rock.boundR) continue;
    if (Math.abs(lateral) > rock.boundR + r + 15) continue;
    if (along < hitAlong) { hitAlong = along; hit = { lateral }; }
  }
  if (!hit) return;
  const side = hit.lateral >= 0 ? -1 : 1;                       // swerve to the free side
  const ax = px * side - dx * 0.8, ay = py * side - dy * 0.8;   // sideways + against the drift
  const ang = Math.atan2(ay, ax);
  m.input.angle = ang;
  const facingAway = Math.abs(shortestAngleDelta(m.angle, ang));
  const facingRock = Math.abs(shortestAngleDelta(m.angle, Math.atan2(dy, dx)));
  m.input.thrust = facingAway < 0.9 ? 1 : facingRock < 0.9 ? -0.5 : 0; // thrust away, or reverse-brake
  m.input.shoot = false;
}

// Touching (or within 20 units of) a rock's exact shape and about to thrust into it: turn away and push
// off instead. Prevents slow grinding against rocks (every bump deals damage).
function avoidRockContact(m) {
  const r = PIRATE_STATS.r + 20;
  for (const rock of rockIndex.query(m.x, m.y, r + MAX_ROCK_BOUND_R)) {
    const cdx = torusDelta(m.x, rock.x, WORLD_W), cdy = torusDelta(m.y, rock.y, WORLD_H);
    if (cdx * cdx + cdy * cdy >= (r + rock.boundR) ** 2) continue;
    let contact = null;
    for (const poly of rock.polys) {
      const c = circleVsPolygon(cdx, cdy, r, poly);
      if (c && (!contact || c.depth > contact.depth)) contact = c;
    }
    if (!contact) continue;
    // Thrust direction = facing × sign(thrust); "into the rock" = against the outward normal.
    const s = Math.sign(m.input.thrust || 0);
    const into = s * (Math.cos(m.angle) * contact.nx + Math.sin(m.angle) * contact.ny) < 0;
    if (!into && s !== 0) continue;
    const away = Math.atan2(contact.ny, contact.nx);
    m.input.angle = away;
    const facingAway = Math.abs(shortestAngleDelta(m.angle, away));
    m.input.thrust = facingAway < 0.9 ? 0.8 : facingAway > Math.PI - 0.9 ? -0.5 : 0; // push off, or reverse off
    m.input.shoot = false;
    return;
  }
}

// Per-tick control: sets m.input only.
function pirateControl(m, g, now) {
  pirateSteer(m, g, now);
  avoidImminentRock(m);
  avoidRockContact(m);
}

function pirateSteer(m, g, now) {
  const C = PIRATE_CONFIG;
  m.input.shoot = false;
  const state = m.state === 'RETREAT' ? 'RETREAT' : g.state;
  m.dbg.st = state; m.dbg.tg = null; m.dbg.aim = null;
  if (now < m.dodgeUntil || checkDodge(m, now)) { m.input.angle = m.dodgeAngle; m.input.thrust = 1; return; }

  if (state === 'ENGAGE') {
    const t = players.get(g.targetId);
    if (t && !t.dead) { pirateCombat(m, g, t, now); return; }
  }
  if (state === 'RETREAT' || state === 'FLEE') {
    const threat = nearestThreat(m, C.threatRadius);
    if (threat) {
      m.dbg.tg = [Math.round(threat.x), Math.round(threat.y)];
      if (m.cover) { steerTo(m, m.cover.x, m.cover.y, 1); return; }
      const ax = torusDelta(m.x, threat.x, WORLD_W), ay = torusDelta(m.y, threat.y, WORLD_H);
      const a = Math.atan2(ay, ax) + (state === 'FLEE' ? m.fleeSide * 40 * DEG : 0); // scatter
      let gx = wrapX(m.x + Math.cos(a) * 400), gy = wrapY(m.y + Math.sin(a) * 400);
      if (!inLeash(gx, gy)) { const w = randomWastelandPoint(m.x, m.y, 800); gx = w.x; gy = w.y; }
      steerTo(m, gx, gy, 1);
      return;
    }
    if (state === 'FLEE' && g.rally) { steerTo(m, g.rally.x, g.rally.y, 0.8); return; }
    const c = groupCentroid(g);
    steerTo(m, c.x, c.y, 0.4); // healed-up retreaters drift back to the group
    return;
  }
  if (state === 'LOOT' && m.lootTarget && !m.lootTarget.removedPickup) {
    steerTo(m, m.lootTarget.x, m.lootTarget.y, 1);
    return;
  }
  // PATROL (or LOOT with nothing assigned): loose formation around the patrol point.
  const target = g.patrol || groupCentroid(g);
  const i = g.members.indexOf(m), a = i * 2.1;
  steerTo(m, wrapX(target.x + Math.cos(a) * 120 * i), wrapY(target.y + Math.sin(a) * 120 * i), 0.65);
}

function updatePirates() {
  const now = simTime();
  for (const m of pirates.values()) {
    const g = m.group;
    if (physTick % PIRATE_DECISION_TICKS === m.decidePhase) {
      if (g.members[0] === m) groupDecide(g, now);
      memberDecide(m, g, now);
    }
    pirateControl(m, g, now);
    applyShipRegen(m, PIRATE_STATS);
    applyShipInput(m, PIRATE_STATS);
    pirateIndex.update(m);
    fireShipGuns(m, PIRATE_TYPES, m.shipType, PIRATE_STATS, m.input.shoot);
  }
}

// What clients get for a pirate (like a remote player, flagged). `dbg` only for dev debug viewers.
function serializePirate(q) {
  return {
    id: q.id, x: round1(q.x), y: round1(q.y), angle: Math.round(q.angle * 100) / 100,
    hp: Math.round(q.hp), maxHp: q.maxHp, dead: false, color: PIRATE_CONFIG.tint, shipType: q.shipType,
    th: (q.input.thrust || 0) > 0 ? 1 : 0, pirate: 1,
  };
}

// --- main loop ---

function tick() {
  physTick++;
  updateAwakeRocks();
  updatePlayers();
  updatePirates();
  if (physTick % TICK_RATE === 0) managePirates();
  updateRocks();
  checkRockRockCollisions();
  updateBullets();
  updateGems();
  updateXpDrops();
  checkPlayerRockCollisions();
  updateShards();          // flying particles move and hit (may destroy rocks → queued death effects)
  processRockDeaths();     // crystal bursts, explosions (a blast's own kills join the same queue)
  expireFragments();
  // Collisions nudge positions: re-bucket everything that could have moved this tick.
  for (const r of awakeRocks) if (!r.removed) rockIndex.update(r);
  for (const [, p] of players) playerIndex.update(p);
  for (const m of pirates.values()) pirateIndex.update(m);

  if (physTick % NET_RATE !== 0) return;

  const sendSlow   = physTick % SLOW_RATE === 0;
  const others = new Map(); // compact state, built once per send and shared by all recipients
  for (const [id, q] of players) others.set(id, serializeOther(q));
  const pirateStates = new Map();
  for (const [id, q] of pirates) pirateStates.set(id, serializePirate(q));

  for (const [, p] of players) {
    if (!wsReady(p.ws)) continue;

    const range = sendRange(p); // per class
    const msg = {
      type: 'tick',
      online: players.size,
      // Yourself in full, others only when in view range (compact).
      players: [serialize(p), ...nearby(playerIndex, p.x, p.y, range).filter(q => q !== p).map(q => others.get(q.id))],
      // Pirates, like remote players (never in `players`/online counts). Dev debug adds each one's AI state.
      pirates: nearby(pirateIndex, p.x, p.y, range).map(q => (p.pirateDebug && DEV_CHEATS
        ? { ...pirateStates.get(q.id), dbg: { ...q.dbg, pd: Math.round(q.prefDist) } } : pirateStates.get(q.id))),
      bullets: nearby(bulletIndex, p.x, p.y, range)
        .map(b => ({ id: b.id, x: round1(b.x), y: round1(b.y), vx: Math.round(b.vx), vy: Math.round(b.vy), ownerId: b.ownerId,
                     angle: Math.round(Math.atan2(b.vy, b.vx) * 1000) / 1000, t: b.type, g: b.gun })),
      // Flying particles, like bullets: start point, direction, age, range and life (the client runs the
      // same ease-out curve locally), rotation, texture index (shape registry), color, kind.
      shards: shards.filter(sh => torusDist(p.x, p.y, sh.x, sh.y) < range)
        .map(sh => ({ id: sh.id, x0: round1(sh.x0), y0: round1(sh.y0), dx: Math.round(sh.dx * 1000) / 1000, dy: Math.round(sh.dy * 1000) / 1000,
                      age: Math.round(sh.age * 1000) / 1000, rg: Math.round(sh.range), lf: Math.round(sh.life * 1000) / 1000,
                      rot: Math.round(sh.rot * 1000) / 1000, tex: sh.tex, c: sh.color, k: sh.kind })),
    };

    if (sendSlow) {
      msg.rocks = nearby(rockIndex, p.x, p.y, range).map(serializeRock);
      msg.gems = nearby(gemIndex, p.x, p.y, range)
        .map(g => ({ id: g.id, x: g.x, y: g.y, r: g.r, vx: g.vx, vy: g.vy, v: g.value, tex: g.tex, rot: g.rot }));
      msg.xpDrops = nearby(xpIndex, p.x, p.y, range)
        .map(x => ({ id: x.id, x: x.x, y: x.y, r: x.r, vx: x.vx, vy: x.vy, v: x.value, tex: x.tex, rot: x.rot }));
    }

    const broken = brokenRockQueue.filter(e => torusDist(p.x, p.y, e.x, e.y) < range);
    if (broken.length) msg.brokenRocks = broken;
    const hits = hitQueue.filter(e => torusDist(p.x, p.y, e.x, e.y) < range);
    if (hits.length) msg.hits = hits;
    const pickups = pickupQueue.filter(e => torusDist(p.x, p.y, e.x, e.y) < range);
    if (pickups.length) msg.pickups = pickups;
    const died = playerDiedQueue.filter(e => torusDist(p.x, p.y, e.x, e.y) < range);
    if (died.length) msg.playerDied = died;
    const blasts = blastQueue.filter(e => torusDist(p.x, p.y, e.x, e.y) < range + EXPLOSION_CONFIG.blastRadius);
    if (blasts.length) msg.blasts = blasts;

    // Movement stats only when they change (upgrade bought, class switched, respawn).
    const move = moveStats(p), moveKey = JSON.stringify(move);
    if (moveKey !== p.sentMoveKey) { msg.move = move; p.sentMoveKey = moveKey; }

    send(p.ws, msg);
  }
  brokenRockQueue.length = 0;
  hitQueue.length = 0;
  pickupQueue.length = 0;
  playerDiedQueue.length = 0;
  blastQueue.length = 0;
}

initRocks();
for (let i = 0; i < PIRATE_TARGET_GROUPS; i++) pirateRespawns.push(0); // initial groups spawn on the first pass
console.log(`Pirates: ${PIRATE_TARGET_GROUPS} groups of ${PIRATE_CONFIG.groupSize.join('–')} in the wasteland; variants ${Object.keys(PIRATE_TYPES).join(', ')}`);
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
