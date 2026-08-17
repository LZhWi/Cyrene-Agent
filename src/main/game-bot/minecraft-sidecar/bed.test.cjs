"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Vec3 } = require("vec3");
const { bedPlacementCandidates, isBedPlacementSafe } = require("./bed.cjs");

test("requires two supported, empty and entity-free bed cells", () => {
  const candidate = bedPlacementCandidates(new Vec3(0, 10, 0))[0];
  const blockAt = (position) => position.y === 9 ? { name: "stone", boundingBox: "block" } : { name: "air", boundingBox: "empty" };
  assert.equal(isBedPlacementSafe(candidate, blockAt, () => false), true);
  assert.equal(isBedPlacementSafe(candidate, (position) => position.equals(candidate.head) ? { name: "stone", boundingBox: "block" } : blockAt(position), () => false), false);
  assert.equal(isBedPlacementSafe(candidate, (position) => position.equals(candidate.head) ? { name: "wheat", boundingBox: "empty" } : blockAt(position), () => false), false);
  assert.equal(isBedPlacementSafe(candidate, blockAt, (position) => position.equals(candidate.foot)), false);
});
