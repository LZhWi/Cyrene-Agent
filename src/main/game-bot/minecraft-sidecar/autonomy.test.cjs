"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { AUTONOMY_DELAYS, allowedActions, autonomousActionIssue, canStartAutonomous, constrainActions, nextDelayIndex, worldChangeFingerprint } = require("./autonomy.cjs");

test("keeps passive mode inert and separates companion from survival permissions", () => {
  assert.deepEqual(allowedActions("passive"), []);
  assert.equal(allowedActions("companion").includes("collect"), false);
  assert.equal(allowedActions("survival").includes("collect"), true);
  assert.deepEqual(constrainActions("companion", ["pickup", "collect", "trade"]), ["pickup"]);
});

test("enforces a deterministic per-goal mutation budget", () => {
  assert.equal(autonomousActionIssue({ type: "collect", count: 4 }), "");
  assert.match(autonomousActionIssue({ type: "collect", count: 5 }), /最多 4/);
  assert.match(autonomousActionIssue({ type: "trade", index: 1 }), /用户明确发起/);
});

test("requires the two-minute cooldown and blocks danger or recent user activity", () => {
  const base = { mode: "companion", lastUserAt: Date.now() - 30_000, lastRunAt: Date.now() - 130_000, dimension: "overworld" };
  assert.equal(canStartAutonomous(base), true);
  assert.equal(canStartAutonomous({ ...base, danger: true }), false);
  assert.equal(canStartAutonomous({ ...base, lastUserAt: Date.now() }), false);
  assert.equal(canStartAutonomous({ ...base, lastRunAt: Date.now() - 60_000 }), false);
});

test("backs low-change idle checks off from two to five, ten and twenty minutes", () => {
  assert.deepEqual(AUTONOMY_DELAYS, [120_000, 300_000, 600_000, 1_200_000]);
  assert.equal(nextDelayIndex(0, true), 1);
  assert.equal(nextDelayIndex(1, true), 2);
  assert.equal(nextDelayIndex(2, true), 3);
  assert.equal(nextDelayIndex(3, true), 3);
  assert.equal(nextDelayIndex(3, false), 0);
});

test("uses coarse meaningful world changes instead of tiny movement", () => {
  const base = { health: 20, food: 20, time: 1000, weather: "clear", dimension: "overworld", position: { x: 1, y: 64, z: 1 }, inventory: [], nearbyEntities: [] };
  assert.equal(worldChangeFingerprint(base), worldChangeFingerprint({ ...base, position: { x: 2, y: 64, z: 2 } }));
  assert.notEqual(worldChangeFingerprint(base), worldChangeFingerprint({ ...base, health: 12 }));
});
