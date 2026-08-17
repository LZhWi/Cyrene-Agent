"use strict";

const BREED_SPECS = Object.freeze({
  "牛": Object.freeze({ entity: "cow", foods: ["wheat"] }),
  "羊": Object.freeze({ entity: "sheep", foods: ["wheat"] }),
  "猪": Object.freeze({ entity: "pig", foods: ["carrot", "potato", "beetroot"] }),
  "鸡": Object.freeze({ entity: "chicken", foods: ["wheat_seeds", "beetroot_seeds", "melon_seeds", "pumpkin_seeds"] }),
});

function breedSpec(name) {
  return BREED_SPECS[name] || null;
}

module.exports = { BREED_SPECS, breedSpec };
