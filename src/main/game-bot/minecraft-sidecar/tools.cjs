"use strict";

const MIN_TOOL_DURABILITY = 10;
const TOOL_TIERS = Object.freeze({ wooden: 1, golden: 2, stone: 3, iron: 4, diamond: 5, netherite: 6 });

function durabilityRemaining(item) {
  if (!item?.maxDurability) return Number.POSITIVE_INFINITY;
  return item.maxDurability - (item.durabilityUsed || 0);
}

function toolTier(item) {
  return TOOL_TIERS[item?.name?.split("_")[0]] || 0;
}

function selectUsableTool(items, allowedTypes) {
  return items
    .filter((item) => allowedTypes?.[item.type] && durabilityRemaining(item) > MIN_TOOL_DURABILITY)
    .sort((a, b) => toolTier(b) - toolTier(a) || durabilityRemaining(b) - durabilityRemaining(a))[0] || null;
}

module.exports = { MIN_TOOL_DURABILITY, durabilityRemaining, selectUsableTool, toolTier };
