// Gun muzzle and engine placement, shared by server.js (bullet spawning) and src/main.js (muzzle flash) so the
// two can never disagree. Plain ESM, no dependencies.
//
// Angle convention: `angle` is the ship's facing in radians (0 = +x, y down). Ship textures point UP
// and drawShip draws them rotated by angle + π/2, so in world space:
//   texture up    (nose)  → ( cos a,  sin a)   = forward
//   texture right (+x)    → (-sin a,  cos a)   = side
// gun.side / gun.forward are the muzzle offsets in that frame (world units, see resolveShipGuns).

// World position of a ship-local point (side, forward) on a ship at (x, y) facing `angle`.
export function shipPoint(side, forward, x, y, angle) {
  const ca = Math.cos(angle), sa = Math.sin(angle);
  return { x: x + side * -sa + forward * ca, y: y + side * ca + forward * sa };
}

// World muzzle of gun `gunIndex` on a ship of type `shipTypeId` at (x, y) facing `angle`.
// `shipTypes` is the ship table (server SHIP_TYPES or the client's copy from 'init'); each gun needs
// { side, forward }. Returns { x, y, dirX, dirY, angle } (dir = firing direction, unit length) or null.
export function gunMuzzle(shipTypes, shipTypeId, gunIndex, x, y, angle) {
  const gun = shipTypes[shipTypeId]?.guns?.[gunIndex];
  if (!gun) return null;
  const p = shipPoint(gun.side, gun.forward, x, y, angle);
  return { x: p.x, y: p.y, dirX: Math.cos(angle), dirY: Math.sin(angle), angle };
}

// World position of engine `engineIndex` (same convention as guns: { side, forward }) or null.
export function enginePoint(shipTypes, shipTypeId, engineIndex, x, y, angle) {
  const e = shipTypes[shipTypeId]?.engines?.[engineIndex];
  return e ? shipPoint(e.side, e.forward, x, y, angle) : null;
}
