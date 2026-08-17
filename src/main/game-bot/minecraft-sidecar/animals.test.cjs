"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { breedSpec } = require("./animals.cjs");

test("maps common overworld livestock to valid breeding food", () => {
  assert.deepEqual(breedSpec("牛"), { entity: "cow", foods: ["wheat"] });
  assert.equal(breedSpec("猪").foods.includes("potato"), true);
  assert.equal(breedSpec("鸡").foods.includes("wheat_seeds"), true);
  assert.equal(breedSpec("狼"), null);
});
