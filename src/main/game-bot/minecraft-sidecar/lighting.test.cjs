"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { needsTorch } = require("./lighting.cjs");

test("auto-lights only dark underground air and preserves one torch", () => {
  assert.equal(needsTorch({ boundingBox: "empty", skyLight: 0, light: 2 }, 2), true);
  assert.equal(needsTorch({ boundingBox: "empty", skyLight: 15, light: 2 }, 10), false);
  assert.equal(needsTorch({ boundingBox: "empty", skyLight: 0, light: 8 }, 10), false);
  assert.equal(needsTorch({ boundingBox: "empty", skyLight: 0, light: 2 }, 1), false);
});
