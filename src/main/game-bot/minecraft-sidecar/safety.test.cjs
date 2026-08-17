"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { escapeBlockCount, transferableCount } = require("./safety.cjs");
test("uses one shared escape reserve pool", () => assert.equal(escapeBlockCount([{ name: "dirt", count: 2 }, { name: "cobblestone", count: 3 }]), 5));
test("keeps three emergency blocks", () => {
  assert.equal(transferableCount({ available: 8, totalEscapeBlocks: 8, reserveLimited: true }), 5);
  assert.equal(transferableCount({ available: 2, totalEscapeBlocks: 5, reserveLimited: true }), 2);
  assert.equal(transferableCount({ available: 3, totalEscapeBlocks: 3, reserveLimited: true }), 0);
});
test("does not limit unrelated items", () => assert.equal(transferableCount({ available: 16, totalEscapeBlocks: 0, reserveLimited: false }), 16));
