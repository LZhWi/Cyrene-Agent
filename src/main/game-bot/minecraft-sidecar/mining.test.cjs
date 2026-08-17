"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ORE_ALIASES, hasExposedFace, tunnelSliceIssue } = require("./mining.cjs");

test("recognizes overworld ore families", () => {
  assert.deepEqual(ORE_ALIASES["铁"], ["iron_ore", "deepslate_iron_ore"]);
  assert.equal(ORE_ALIASES["钻石"].includes("diamond_ore"), true);
});

test("requires at least one exposed ore face", () => {
  assert.equal(hasExposedFace([{ boundingBox: "block" }, { boundingBox: "empty" }]), true);
  assert.equal(hasExposedFace(Array(6).fill({ boundingBox: "block" })), false);
});

test("rejects unsafe horizontal tunnel slices", () => {
  const solid = { name: "stone", boundingBox: "block" };
  const empty = { name: "air", boundingBox: "empty" };
  assert.equal(tunnelSliceIssue({ feet: solid, head: solid, ceiling: solid, below: solid }), null);
  assert.equal(tunnelSliceIssue({ feet: solid, head: solid, ceiling: { name: "gravel" }, below: solid }), "顶部有会坠落的方块");
  assert.equal(tunnelSliceIssue({ feet: solid, head: solid, ceiling: solid, below: empty }), "前方没有可靠地面");
  assert.equal(tunnelSliceIssue({ feet: solid, head: solid, ceiling: solid, below: solid, neighbors: [{ name: "lava" }] }), "相邻位置有液体");
});
