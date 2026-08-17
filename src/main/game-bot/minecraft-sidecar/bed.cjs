"use strict";

const CARDINALS = Object.freeze([
  Object.freeze({ x: 1, z: 0 }), Object.freeze({ x: -1, z: 0 }),
  Object.freeze({ x: 0, z: 1 }), Object.freeze({ x: 0, z: -1 }),
]);

function bedPlacementCandidates(feet) {
  const candidates = [];
  for (let dx = -3; dx <= 3; dx += 1) for (let dz = -3; dz <= 3; dz += 1) {
    if (dx === 0 && dz === 0) continue;
    for (const direction of CARDINALS) {
      const foot = feet.offset(dx, 0, dz);
      const head = foot.offset(direction.x, 0, direction.z);
      candidates.push({ foot, head, direction, distance: Math.hypot(dx, dz) });
    }
  }
  return candidates.sort((a, b) => a.distance - b.distance);
}

function isBedPlacementSafe(candidate, blockAt, entityIntersects) {
  for (const position of [candidate.foot, candidate.head]) {
    if (!["air", "cave_air", "void_air"].includes(blockAt(position)?.name)) return false;
    if (!["air", "cave_air", "void_air"].includes(blockAt(position.offset(0, 1, 0))?.name)) return false;
    if (blockAt(position.offset(0, -1, 0))?.boundingBox !== "block") return false;
    if (entityIntersects(position) || entityIntersects(position.offset(0, 1, 0))) return false;
  }
  return true;
}

module.exports = { CARDINALS, bedPlacementCandidates, isBedPlacementSafe };
