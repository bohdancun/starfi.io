// Biome system: chunk-based regions with different visual themes, rock types, and spawn rules.
// Each chunk (512×512 world units) has exactly one biome. Biomes are deterministic based on
// chunk coordinates, mapped from design/biomemap.svg (32×32 pixel grid = 32×32 chunks).

import { CHUNKS_PER_AXIS, CHUNK_MIN, CHUNK_SIZE, WORLD_SIZE } from './world.js';

// Biome definitions. Each biome can override rock spawn weights, environmental colors, etc.
export const BIOMES = {
  wasteland: {
    id: 'wasteland',
    name: 'Wasteland',
    rockKindWeights: null, // use global defaults
    color: '#0a0a14',      // deep space blue-black (neutral)
    mapColor: '#000000',   // black on full map
    minimapTint: [10, 10, 20], // RGB for blending
    backgroundTint: [10, 10, 20], // RGB for world background tint
    starTint: [200, 210, 255], // neutral white-blue stars
    biomeTint: null, // no tint overlay for wasteland
  },

  ember: {
    id: 'ember',
    name: 'Ember Belt',
    rockKindWeights: null, // TODO: more gold rocks, add volatile rocks
    color: '#1a0505',      // dark red ambient
    mapColor: '#7E0000',   // red on full map
    minimapTint: [126, 0, 0], // RGB for blending
    backgroundTint: [67, 0, 0], // #430000 for world background tint
    starTint: [255, 178, 178], // #FFB2B2 brightest white-red for stars
    bgDarkest: [74, 0, 0], // #4A0000 darkest non-black
    biomeTint: [151, 30, 30], // #971E1E middle main color, 20% opacity overlay
  },

  frost: {
    id: 'frost',
    name: 'Frost Nebula',
    rockKindWeights: null, // TODO: more XP rocks, add splitter rocks
    color: '#05091a',      // dark blue ambient
    mapColor: '#00164D',   // blue on full map
    minimapTint: [0, 22, 77], // RGB for blending
    backgroundTint: [12, 25, 63], // #0C193F for world background tint
    starTint: [188, 200, 238], // #BCC8EE brightest white-blue for stars
    bgDarkest: [12, 25, 63], // #0C193F darkest non-black (same as background tint for consistency)
    biomeTint: [60, 87, 135], // #3C5787 middle main color, 20% opacity overlay
  },
};

// Biome map from design/biomemap.svg (32×32 grid).
// SVG coordinate system: row 0 (y=0) at TOP of image, row 31 at BOTTOM.
// World coordinate system: positive Y is UP (north), negative Y is DOWN (south).
// So: SVG top (red) = world SOUTH (negative Y), SVG bottom (blue) = world NORTH (positive Y).
// Chunk cy ranges: -16 (south/bottom) to +15 (north/top).
// The SVG layout (top to bottom in the image file):
//   rows  0- 3: wasteland (black)
//   rows  4-11: ember (red #7E0000) — appears at TOP of SVG
//   rows 12-19: wasteland (black, neutral spawn zone)
//   rows 20-27: frost (blue #00164D) — appears at BOTTOM of SVG
//   rows 28-31: wasteland (black)
const BIOME_MAP = [
  // row 0-3: wasteland
  'w', 'w', 'w', 'w',
  // row 4-11: ember (8 rows) — top of SVG = south of world
  'e', 'e', 'e', 'e', 'e', 'e', 'e', 'e',
  // row 12-19: wasteland (8 rows, center neutral zone)
  'w', 'w', 'w', 'w', 'w', 'w', 'w', 'w',
  // row 20-27: frost (8 rows) — bottom of SVG = north of world
  'f', 'f', 'f', 'f', 'f', 'f', 'f', 'f',
  // row 28-31: wasteland
  'w', 'w', 'w', 'w',
];

const BIOME_LOOKUP = { w: 'wasteland', e: 'ember', f: 'frost' };

// Get the biome for a chunk based on the biome map. The map is uniform across all columns (x),
// only the row (y) matters for the current horizontal-band layout.
export function getBiomeForChunk(cx, cy) {
  // Map index = wrapped cy - CHUNK_MIN, so cy = -16 → entry 0 and cy = +15 → entry 31. Chunk
  // coordinates past the edge wrap like the world does.
  const row = (((cy - CHUNK_MIN) % CHUNKS_PER_AXIS) + CHUNKS_PER_AXIS) % CHUNKS_PER_AXIS;
  return BIOMES[BIOME_LOOKUP[BIOME_MAP[row]] || 'wasteland'];
}

// Optional: get biome at world coordinates (looks up the chunk first).
export function getBiomeAt(x, y) {
  const cx = Math.floor(x / 512);
  const cy = Math.floor(y / 512);
  return getBiomeForChunk(cx, cy);
}

// Helper: check if a biome ID is valid.
export function isValidBiome(biomeId) {
  return biomeId in BIOMES;
}

// Get biome ID string for a chunk (convenience helper).
export function getBiomeIdForChunk(cx, cy) {
  return getBiomeForChunk(cx, cy).id;
}

// --- Smooth biome weights (client visuals: background, stars, mist, object tint) ---
// Width of the blend band centered on every biome border: 1 chunk outside → 1 chunk inside.
export const BIOME_BLEND_BAND = 2 * CHUNK_SIZE;
const TINTED_BIOMES = ['frost', 'ember'];

// Contiguous row runs per tinted biome as [y0, length) in world units, wrap-aware (a run crossing the
// world edge is merged into one). The map only varies by row, so x never matters.
const BIOME_RUNS = (() => {
  const runs = [];
  for (let i = 0; i < CHUNKS_PER_AXIS; i++) {
    const id = BIOME_LOOKUP[BIOME_MAP[i]];
    const last = runs[runs.length - 1];
    if (last && last.id === id) last.len += CHUNK_SIZE;
    else runs.push({ id, y0: (i + CHUNK_MIN) * CHUNK_SIZE, len: CHUNK_SIZE });
  }
  if (runs.length > 1 && runs[0].id === runs[runs.length - 1].id) {
    const tail = runs.pop();
    runs[0].y0 = tail.y0;
    runs[0].len += tail.len;
  }
  return runs.filter(r => TINTED_BIOMES.includes(r.id));
})();

function smoothstep01(t) {
  t = Math.min(1, Math.max(0, t));
  return t * t * (3 - 2 * t);
}

// Pure function of position: { frost, ember }, each 0..1. 1 deep inside the biome, 0 in the neutral
// zone, smoothstep across BIOME_BLEND_BAND at the borders. Same position → same result, across the wrap too.
export function biomeWeights(x, y) {
  const out = { frost: 0, ember: 0 };
  for (const run of BIOME_RUNS) {
    const u = (((y - run.y0) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE; // distance past the run's start
    const signed = u < run.len ? Math.min(u, run.len - u) : -Math.min(u - run.len, WORLD_SIZE - u);
    out[run.id] = Math.max(out[run.id], smoothstep01(0.5 + signed / BIOME_BLEND_BAND));
  }
  return out;
}

// Light exponential smoothing toward the position's weights (removes jitter, never accumulates):
// the result always lies between prev and target, so it stays in 0..1 and settles exactly on target.
export const BIOME_SMOOTH_RATE = 10; // 1/s
export function smoothBiomeWeights(prev, target, dt) {
  const k = 1 - Math.exp(-BIOME_SMOOTH_RATE * dt);
  const out = {};
  for (const id of TINTED_BIOMES) {
    const t = Number.isFinite(target[id]) ? target[id] : 0; // never let a bad input stick
    const p = Number.isFinite(prev[id]) ? prev[id] : t;
    const d = t - p;
    out[id] = Math.abs(d) < 1e-4 ? t : p + d * k;
  }
  return out;
}
