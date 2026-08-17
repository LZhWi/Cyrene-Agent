"use strict";

const ARMOR_SLOTS = Object.freeze({ _helmet: "head", _chestplate: "torso", _leggings: "legs", _boots: "feet" });
const ARMOR_TIERS = Object.freeze({ leather: 1, golden: 2, chainmail: 3, iron: 4, diamond: 5, netherite: 6 });
const WEAPON_TIERS = Object.freeze({ wooden: 1, golden: 2, stone: 3, iron: 4, diamond: 5, netherite: 6 });
const HOSTILE_NAMES = new Set([
  "zombie", "husk", "drowned", "skeleton", "stray", "bogged", "creeper", "spider", "cave_spider",
  "witch", "slime", "phantom", "pillager", "vindicator", "evoker", "ravager", "vex", "silverfish",
]);
const RANGED_HOSTILES = new Set(["skeleton", "stray", "bogged", "pillager", "witch"]);

function tierFor(item, tiers) {
  return tiers[item?.name?.split("_")[0]] || 0;
}

function bestArmor(items, suffix) {
  return items.filter((item) => item.name.endsWith(suffix)).sort((a, b) => tierFor(b, ARMOR_TIERS) - tierFor(a, ARMOR_TIERS))[0] || null;
}

function bestWeapon(items) {
  return items.filter((item) => item.name.endsWith("_sword") || item.name.endsWith("_axe"))
    .sort((a, b) => tierFor(b, WEAPON_TIERS) - tierFor(a, WEAPON_TIERS) || Number(b.name.endsWith("_sword")) - Number(a.name.endsWith("_sword")))[0] || null;
}

function isHostile(entity) {
  return entity?.kind === "Hostile mobs" || HOSTILE_NAMES.has(entity?.name);
}

function threatResponse({ name, distance, hasShield, hasBow, hasArrow }) {
  if (name === "creeper" && distance <= 7) return "flee";
  if (distance <= 4) return "melee";
  if (RANGED_HOSTILES.has(name) && distance <= 12 && hasShield) return "shield";
  if (distance <= 14 && hasBow && hasArrow) return "bow";
  return "none";
}

module.exports = { ARMOR_SLOTS, bestArmor, bestWeapon, isHostile, threatResponse };
