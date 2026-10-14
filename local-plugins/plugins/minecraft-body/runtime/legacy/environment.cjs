"use strict";

const HAZARDOUS_BLOCKS = new Set(["lava", "fire", "soul_fire", "campfire", "soul_campfire", "magma_block", "sweet_berry_bush", "powder_snow"]);

function environmentDanger({ oxygenLevel, feet, head, below, neighbors = [] }) {
  if (Number.isFinite(oxygenLevel) && oxygenLevel <= 5 && [feet, head].some((block) => block?.name === "water")) return "drowning";
  if ([feet, below].some((block) => HAZARDOUS_BLOCKS.has(block?.name))) return "hazard_block";
  if (neighbors.some((block) => block?.name === "lava")) return "hazard_block";
  return null;
}

module.exports = { HAZARDOUS_BLOCKS, environmentDanger };
