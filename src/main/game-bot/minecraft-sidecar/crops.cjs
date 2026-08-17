"use strict";

const CROP_SPECS = Object.freeze({
  "小麦": Object.freeze({ block: "wheat", seed: "wheat_seeds", matureAge: 7 }),
  "胡萝卜": Object.freeze({ block: "carrots", seed: "carrot", matureAge: 7 }),
  "马铃薯": Object.freeze({ block: "potatoes", seed: "potato", matureAge: 7 }),
  "甜菜": Object.freeze({ block: "beetroots", seed: "beetroot_seeds", matureAge: 3 }),
});

function cropSpec(name) {
  return CROP_SPECS[name] || null;
}

function isMatureCrop(block, spec) {
  return Boolean(spec) && block?.name === spec.block && Number(block.getProperties?.().age) >= spec.matureAge;
}

function isMatureWheat(block) {
  return isMatureCrop(block, CROP_SPECS["小麦"]);
}

function isEmptyFarmland(farmland, above) {
  return farmland?.name === "farmland" && ["air", "cave_air", "void_air"].includes(above?.name);
}

module.exports = { CROP_SPECS, cropSpec, isEmptyFarmland, isMatureCrop, isMatureWheat };
