"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { isBoatEntity, reconcileOwnVehicle, waitForVehicleState } = require("./boat.cjs");

test("recognizes boat entities across protocol naming variants", () => {
  assert.equal(isBoatEntity({ name: "boat" }), true);
  assert.equal(isBoatEntity({ name: "oak_boat" }), true);
  assert.equal(isBoatEntity({ name: "chest_boat" }), true);
  assert.equal(isBoatEntity({ name: "cow" }), false);
});

test("waits for mount state without relying on physics ticks", async () => {
  const boat = { id: 7 };
  let vehicle = null;
  setTimeout(() => { vehicle = boat; }, 20);
  assert.equal(await waitForVehicleState(() => vehicle, boat, 200, 5), true);
  setTimeout(() => { vehicle = null; }, 20);
  assert.equal(await waitForVehicleState(() => vehicle, null, 200, 5), true);
});

test("clears stale own vehicle from modern passenger lists", () => {
  const boat = { id: 7 };
  const bot = { entity: { id: 3 }, vehicle: boat };
  assert.equal(reconcileOwnVehicle(bot, { entityId: 7, passengers: [] }), true);
  assert.equal(bot.vehicle, null);
  bot.vehicle = boat;
  assert.equal(reconcileOwnVehicle(bot, { entityId: 7, passengers: [3] }), false);
  assert.equal(bot.vehicle, boat);
});
