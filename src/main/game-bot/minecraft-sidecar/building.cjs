"use strict";

function shelterTargets(origin) {
  const doorX = origin.x + 1;
  const walls = [];
  const roof = [];
  for (let x = 0; x < 4; x += 1) {
    for (let z = 0; z < 4; z += 1) {
      const perimeter = x === 0 || x === 3 || z === 0 || z === 3;
      if (perimeter && !(z === 0 && origin.x + x === doorX)) {
        walls.push({ x: origin.x + x, y: origin.y, z: origin.z + z });
        walls.push({ x: origin.x + x, y: origin.y + 1, z: origin.z + z });
      }
      roof.push({ x: origin.x + x, y: origin.y + 2, z: origin.z + z });
    }
  }
  return { door: [{ x: doorX, y: origin.y, z: origin.z }, { x: doorX, y: origin.y + 1, z: origin.z }], walls, roof, all: [...walls, ...roof] };
}

module.exports = { shelterTargets };
