// Collision geometry shared by server.js and src/main.js so both sides compute identical results.
// Plain ESM, no dependencies. Polygons are arrays of [x, y] in screen space (y down).
// Winding convention: positive signed area (clockwise on screen). Rotation preserves it.

// Signed area; > 0 means clockwise on screen (y down).
export function polygonArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  }
  return a / 2;
}

// Local → world. Same transform as ctx.translate(x, y); ctx.rotate(angle) in drawRocks.
export function transformPoly(localPoly, x, y, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const out = new Array(localPoly.length);
  for (let i = 0; i < localPoly.length; i++) {
    const [lx, ly] = localPoly[i];
    out[i] = [x + lx * c - ly * s, y + lx * s + ly * c];
  }
  return out;
}

// Andrew's monotone chain. Returns a convex hull with positive (clockwise-on-screen) winding.
export function convexHull(points) {
  const pts = points.map(p => [p[0], p[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  return polygonArea(hull) < 0 ? hull.reverse() : hull;
}

// Even-odd ray cast; works for concave polygons.
export function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distPointToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const len2 = abx * abx + aby * aby;
  const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / len2)) : 0;
  return Math.hypot(px - (ax + t * abx), py - (ay + t * aby));
}

// Closest point on the polygon boundary. { x, y, dist, inside, edge } — edge = index of segment i→i+1.
export function closestPointOnPolygon(px, py, poly) {
  let best = Infinity, bx = 0, by = 0, edge = 0;
  for (let i = 0; i < poly.length; i++) {
    const ax = poly[i][0], ay = poly[i][1];
    const [cx, cy] = poly[(i + 1) % poly.length];
    const abx = cx - ax, aby = cy - ay;
    const len2 = abx * abx + aby * aby;
    const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / len2)) : 0;
    const qx = ax + t * abx, qy = ay + t * aby;
    const d2 = (px - qx) * (px - qx) + (py - qy) * (py - qy);
    if (d2 < best) { best = d2; bx = qx; by = qy; edge = i; }
  }
  return { x: bx, y: by, dist: Math.sqrt(best), inside: pointInPolygon(px, py, poly), edge };
}

// Circle vs (possibly concave) polygon. null, or { nx, ny, depth, x, y } where (nx, ny) points from the
// polygon toward the circle (the direction to move the circle out) and (x, y) is the contact point.
export function circleVsPolygon(cx, cy, cr, poly) {
  const cp = closestPointOnPolygon(cx, cy, poly);
  if (!cp.inside && cp.dist >= cr) return null;
  let nx, ny;
  if (cp.dist > 1e-9) {
    nx = (cx - cp.x) / cp.dist; ny = (cy - cp.y) / cp.dist;
    if (cp.inside) { nx = -nx; ny = -ny; } // center inside: exit through the nearest edge
  } else {
    // Center exactly on the boundary: use that edge's outward normal.
    const [ax, ay] = poly[cp.edge], [bx, by] = poly[(cp.edge + 1) % poly.length];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const sgn = polygonArea(poly) >= 0 ? 1 : -1;
    nx = sgn * (by - ay) / len; ny = -sgn * (bx - ax) / len;
  }
  const depth = cp.inside ? cr + cp.dist : cr - cp.dist;
  return { nx, ny, depth, x: cp.x, y: cp.y };
}

// First crossing of segment (x1,y1)→(x2,y2) with the polygon boundary: { x, y, t } or null.
// A segment starting inside the polygon hits at its start (t = 0).
export function segmentVsPolygon(x1, y1, x2, y2, poly) {
  if (pointInPolygon(x1, y1, poly)) return { x: x1, y: y1, t: 0 };
  const dx = x2 - x1, dy = y2 - y1;
  let bestT = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
    const ex = bx - ax, ey = by - ay;
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-12) continue; // parallel
    const t = ((ax - x1) * ey - (ay - y1) * ex) / denom;
    const u = ((ax - x1) * dy - (ay - y1) * dx) / denom;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && t < bestT) bestT = t;
  }
  return bestT === Infinity ? null : { x: x1 + dx * bestT, y: y1 + dy * bestT, t: bestT };
}

function projectPoly(poly, ax, ay) {
  let lo = Infinity, hi = -Infinity;
  for (const [x, y] of poly) { const p = x * ax + y * ay; if (p < lo) lo = p; if (p > hi) hi = p; }
  return [lo, hi];
}

// SAT for CONVEX polygons. null, or MTV { nx, ny, depth } with (nx, ny) pointing from B toward A
// (move A by +n·depth, or B by −n·depth, to separate).
export function polygonVsPolygonSAT(hullA, hullB) {
  let depth = Infinity, nx = 0, ny = 0;
  for (const poly of [hullA, hullB]) {
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
      let ex = -(by - ay), ey = bx - ax;
      const len = Math.hypot(ex, ey);
      if (len < 1e-12) continue;
      ex /= len; ey /= len;
      const [loA, hiA] = projectPoly(hullA, ex, ey);
      const [loB, hiB] = projectPoly(hullB, ex, ey);
      const overlap = Math.min(hiA - loB, hiB - loA);
      if (overlap <= 0) return null;
      if (overlap < depth) { depth = overlap; nx = ex; ny = ey; }
    }
  }
  // Orient from B's centroid toward A's.
  let ax = 0, ay = 0, bx = 0, by = 0;
  for (const [x, y] of hullA) { ax += x; ay += y; }
  for (const [x, y] of hullB) { bx += x; by += y; }
  if ((ax / hullA.length - bx / hullB.length) * nx + (ay / hullA.length - by / hullB.length) * ny < 0) {
    nx = -nx; ny = -ny;
  }
  return { nx, ny, depth };
}
