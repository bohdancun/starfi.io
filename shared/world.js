// World geometry shared by server.js and src/main.js: size, torus wrap-around and chunk helpers.
// Plain ESM, no dependencies.
//
// The world is centered on the origin: x and y run from WORLD_MIN (inclusive) to WORLD_MAX (exclusive)
// and wrap around at the edges (torus). Chunks are CHUNK_SIZE squares; chunk coordinates run from
// CHUNK_MIN to CHUNK_MAX on each axis, so the chunk containing (0, 0) is chunk (0, 0).

export const WORLD_SIZE      = 16384;
export const WORLD_W         = WORLD_SIZE;
export const WORLD_H         = WORLD_SIZE;
export const WORLD_MIN       = -WORLD_SIZE / 2;  // -8192, inclusive
export const WORLD_MAX       =  WORLD_SIZE / 2;  //  8192, exclusive

export const CHUNK_SIZE      = 512;
export const CHUNKS_PER_AXIS = WORLD_SIZE / CHUNK_SIZE; // 32
export const CHUNK_COUNT     = CHUNKS_PER_AXIS * CHUNKS_PER_AXIS;
export const CHUNK_MIN       = -CHUNKS_PER_AXIS / 2;    // -16
export const CHUNK_MAX       =  CHUNKS_PER_AXIS / 2 - 1; //  15

// Wrap a coordinate into [WORLD_MIN, WORLD_MAX).
export function wrapX(x) {
  return ((x - WORLD_MIN) % WORLD_W + WORLD_W) % WORLD_W + WORLD_MIN;
}
export function wrapY(y) {
  return ((y - WORLD_MIN) % WORLD_H + WORLD_H) % WORLD_H + WORLD_MIN;
}

// Shortest signed difference a − b on a ring of the given size, in [-size/2, size/2).
export function torusDelta(a, b, size = WORLD_W) {
  let d = (a - b) % size;
  if (d >= size / 2) d -= size;
  else if (d < -size / 2) d += size;
  return d;
}

export function torusDist(x1, y1, x2, y2) {
  return Math.hypot(torusDelta(x1, x2, WORLD_W), torusDelta(y1, y2, WORLD_H));
}

// Wrap a chunk coordinate into [CHUNK_MIN, CHUNK_MAX].
export function wrapChunk(c) {
  return ((c - CHUNK_MIN) % CHUNKS_PER_AXIS + CHUNKS_PER_AXIS) % CHUNKS_PER_AXIS + CHUNK_MIN;
}

// Chunk containing a world point (any coordinates; wrapped first).
export function worldToChunk(x, y) {
  return { cx: Math.floor(wrapX(x) / CHUNK_SIZE), cy: Math.floor(wrapY(y) / CHUNK_SIZE) };
}

// World-space bounds of a chunk: [x0, x1) × [y0, y1). Chunk coordinates are wrapped first.
export function chunkBounds(cx, cy) {
  const x0 = wrapChunk(cx) * CHUNK_SIZE, y0 = wrapChunk(cy) * CHUNK_SIZE;
  return { x0, y0, x1: x0 + CHUNK_SIZE, y1: y0 + CHUNK_SIZE };
}

// Unique numeric key for a chunk (wrapped), 0 … CHUNK_COUNT-1.
export function chunkKey(cx, cy) {
  return (wrapChunk(cx) - CHUNK_MIN) * CHUNKS_PER_AXIS + (wrapChunk(cy) - CHUNK_MIN);
}

// Inverse of chunkKey: { cx, cy } in [CHUNK_MIN, CHUNK_MAX].
export function chunkFromKey(key) {
  return { cx: Math.floor(key / CHUNKS_PER_AXIS) + CHUNK_MIN, cy: (key % CHUNKS_PER_AXIS) + CHUNK_MIN };
}

export function chunkKeyAt(x, y) {
  const { cx, cy } = worldToChunk(x, y);
  return chunkKey(cx, cy);
}

// Call fn(key) once for every chunk overlapping the square [x-r, x+r] × [y-r, y+r], wrap-aware.
export function forEachChunkInRange(x, y, r, fn) {
  const nx = Math.min(CHUNKS_PER_AXIS, Math.floor((x + r) / CHUNK_SIZE) - Math.floor((x - r) / CHUNK_SIZE) + 1);
  const ny = Math.min(CHUNKS_PER_AXIS, Math.floor((y + r) / CHUNK_SIZE) - Math.floor((y - r) / CHUNK_SIZE) + 1);
  const cx0 = Math.floor((x - r) / CHUNK_SIZE), cy0 = Math.floor((y - r) / CHUNK_SIZE);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) fn(chunkKey(cx0 + i, cy0 + j));
  }
}
