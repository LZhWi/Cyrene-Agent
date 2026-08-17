"use strict";

const MODE_ACTIONS = Object.freeze({
  passive: [],
  companion: ["follow", "come", "status", "observe", "inventory", "pickup", "retreat", "eat", "equip_armor", "equip_shield", "place_torch", "sleep", "wake"],
  survival: [
    "follow", "come", "status", "observe", "inventory", "pickup", "retreat", "eat", "equip_armor", "equip_shield", "place_torch", "sleep", "wake",
    "home", "platform", "shelter", "place_table", "place_furnace", "place_chest", "list_chest", "deposit_held", "place_bed",
    "fish", "fill_water", "milk_cow", "breed", "shear_sheep", "till", "plant_crop", "harvest_crop", "smelt", "deposit", "withdraw", "craft", "mine_ore", "tunnel", "collect",
  ],
});
const AUTONOMY_DELAYS = Object.freeze([120_000, 300_000, 600_000, 1_200_000]);

function allowedActions(mode) {
  return MODE_ACTIONS[mode] || [];
}

function canStartAutonomous(input) {
  if (!input || input.mode === "passive") return false;
  if (input.stopping || input.llmBusy || input.activeTask || input.danger || input.dimension !== "overworld") return false;
  if (Date.now() - Number(input.lastUserAt || 0) < Math.max(0, Number(input.userCooldownMs ?? 20_000))) return false;
  if (Date.now() - Number(input.lastRunAt || 0) < Math.max(0, Number(input.runCooldownMs ?? AUTONOMY_DELAYS[0]))) return false;
  return true;
}

function worldChangeFingerprint(world) {
  const position = world?.position || {};
  const inventory = Array.isArray(world?.inventory)
    ? world.inventory.map((item) => `${item.name}:${item.count}`).sort().slice(0, 18) : [];
  const entities = Array.isArray(world?.nearbyEntities)
    ? world.nearbyEntities.map((entity) => `${entity.name}:${entity.isOwner ? "owner" : "other"}`).sort().slice(0, 16) : [];
  return JSON.stringify({
    health: Math.floor(Number(world?.health || 0) / 4),
    food: Math.floor(Number(world?.food || 0) / 4),
    area: [Math.floor(Number(position.x || 0) / 8), Math.floor(Number(position.y || 0) / 4), Math.floor(Number(position.z || 0) / 8)],
    dimension: world?.dimension,
    dayPhase: Math.floor(Number(world?.time || 0) / 3000),
    weather: world?.weather,
    inventory,
    entities,
  });
}

function nextDelayIndex(current, lowChangeIdle) {
  return lowChangeIdle ? Math.min(AUTONOMY_DELAYS.length - 1, Math.max(0, Number(current) || 0) + 1) : 0;
}

function constrainActions(mode, proposed) {
  const allowed = new Set(allowedActions(mode));
  return Array.from(new Set((Array.isArray(proposed) ? proposed : []).filter((action) => allowed.has(action)))).slice(0, 8);
}

function autonomousActionIssue(action) {
  if (!action || typeof action !== "object") return "动作无效";
  if (Number.isFinite(Number(action.count)) && Number(action.count) > 4) return "单次自主资源操作最多 4 个";
  if (["give", "give_held", "trade", "enchant", "rename", "place_water", "recover_death"].includes(action.type)) return "该动作必须由用户明确发起";
  return "";
}

module.exports = { AUTONOMY_DELAYS, MODE_ACTIONS, allowedActions, autonomousActionIssue, canStartAutonomous, constrainActions, nextDelayIndex, worldChangeFingerprint };
