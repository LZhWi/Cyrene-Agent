"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MIN_TOOL_DURABILITY, durabilityRemaining, selectUsableTool } = require("./tools.cjs");

test("rejects tools that are about to break", () => {
  const worn = { type: 1, name: "iron_pickaxe", maxDurability: 250, durabilityUsed: 240 };
  assert.equal(durabilityRemaining(worn), MIN_TOOL_DURABILITY);
  assert.equal(selectUsableTool([worn], { 1: true }), null);
});

test("chooses the strongest usable harvest tool", () => {
  const wooden = { type: 1, name: "wooden_pickaxe", maxDurability: 59, durabilityUsed: 0 };
  const stone = { type: 2, name: "stone_pickaxe", maxDurability: 131, durabilityUsed: 100 };
  const unrelated = { type: 3, name: "diamond_shovel", maxDurability: 1561, durabilityUsed: 0 };
  assert.equal(selectUsableTool([wooden, stone, unrelated], { 1: true, 2: true }).name, "stone_pickaxe");
});
