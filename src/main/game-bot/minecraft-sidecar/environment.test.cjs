"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { environmentDanger } = require("./environment.cjs");

test("detects drowning and common overworld damage blocks", () => {
  assert.equal(environmentDanger({ oxygenLevel: 4, head: { name: "water" } }), "drowning");
  assert.equal(environmentDanger({ oxygenLevel: 4, feet: { name: "air" }, head: { name: "air" } }), null);
  assert.equal(environmentDanger({ oxygenLevel: 20, below: { name: "magma_block" } }), "hazard_block");
  assert.equal(environmentDanger({ oxygenLevel: 20, neighbors: [{ name: "lava" }] }), "hazard_block");
  assert.equal(environmentDanger({ oxygenLevel: 20, neighbors: [{ name: "campfire" }] }), null);
  assert.equal(environmentDanger({ oxygenLevel: 20, below: { name: "stone" } }), null);
});
