"use strict";

const ORE_ALIASES = Object.freeze({
  "煤": ["coal_ore", "deepslate_coal_ore"],
  "铁": ["iron_ore", "deepslate_iron_ore"],
  "铜": ["copper_ore", "deepslate_copper_ore"],
  "金": ["gold_ore", "deepslate_gold_ore"],
  "红石": ["redstone_ore", "deepslate_redstone_ore"],
  "青金石": ["lapis_ore", "deepslate_lapis_ore"],
  "钻石": ["diamond_ore", "deepslate_diamond_ore"],
  "绿宝石": ["emerald_ore", "deepslate_emerald_ore"],
});

function hasExposedFace(neighbors) {
  return neighbors.some((block) => block?.boundingBox === "empty");
}

const FALLING_BLOCKS = new Set(["sand", "red_sand", "gravel", "anvil", "chipped_anvil", "damaged_anvil"]);

function tunnelSliceIssue({ feet, head, ceiling, below, neighbors = [] }) {
  if (below?.boundingBox !== "block") return "前方没有可靠地面";
  if (feet?.boundingBox === "empty" && head?.boundingBox === "empty") return "前方已经是通道";
  if ([feet, head].some((block) => ["water", "lava", "bedrock"].includes(block?.name))) return "前方是液体或基岩";
  if (FALLING_BLOCKS.has(ceiling?.name)) return "顶部有会坠落的方块";
  if (neighbors.some((block) => block?.name === "water" || block?.name === "lava")) return "相邻位置有液体";
  return null;
}

module.exports = { FALLING_BLOCKS, ORE_ALIASES, hasExposedFace, tunnelSliceIssue };
