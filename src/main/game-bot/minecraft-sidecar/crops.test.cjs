"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { cropSpec, isEmptyFarmland, isMatureCrop, isMatureWheat } = require("./crops.cjs");

test("recognizes only fully mature wheat", () => {
  assert.equal(isMatureWheat({ name: "wheat", getProperties: () => ({ age: 7 }) }), true);
  assert.equal(isMatureWheat({ name: "wheat", getProperties: () => ({ age: 6 }) }), false);
  assert.equal(isMatureWheat({ name: "carrots", getProperties: () => ({ age: 7 }) }), false);
});

test("defines common overworld crops and their mature ages", () => {
  assert.deepEqual(cropSpec("胡萝卜"), { block: "carrots", seed: "carrot", matureAge: 7 });
  assert.equal(isMatureCrop({ name: "carrots", getProperties: () => ({ age: 7 }) }, cropSpec("胡萝卜")), true);
  assert.equal(isMatureCrop({ name: "beetroots", getProperties: () => ({ age: 2 }) }, cropSpec("甜菜")), false);
  assert.equal(cropSpec("南瓜"), null);
});

test("plants only above empty farmland", () => {
  assert.equal(isEmptyFarmland({ name: "farmland" }, { name: "air", boundingBox: "empty" }), true);
  assert.equal(isEmptyFarmland({ name: "dirt" }, { name: "air", boundingBox: "empty" }), false);
  assert.equal(isEmptyFarmland({ name: "farmland" }, { name: "stone", boundingBox: "block" }), false);
  assert.equal(isEmptyFarmland({ name: "farmland" }, { name: "wheat", boundingBox: "empty" }), false);
});
