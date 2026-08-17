"use strict";

function isBoatEntity(entity) {
  return entity?.name === "boat" || entity?.name?.endsWith("_boat");
}

async function waitForVehicleState(readVehicle, expected, timeout = 2500, interval = 50) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const vehicle = readVehicle();
    if (expected ? vehicle === expected : !vehicle) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return false;
}

function reconcileOwnVehicle(bot, packet) {
  if (!bot?.entity || !packet || !Array.isArray(packet.passengers)) return false;
  const current = bot.vehicle;
  if (current?.id === packet.entityId && !packet.passengers.includes(bot.entity.id)) {
    bot.vehicle = null;
    return true;
  }
  return false;
}

module.exports = { isBoatEntity, reconcileOwnVehicle, waitForVehicleState };
