"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { currentWindowSlot, customNameText, playerWindowItemCount } = require("./windows.cjs");

test("maps player inventory slots into an open container", () => {
  const window = { inventoryStart: 2 };
  assert.equal(currentWindowSlot(window, 9), 2);
  assert.equal(currentWindowSlot(window, 36), 29);
  assert.equal(currentWindowSlot(window, 44), 37);
});

test("counts results in the player section of an open window", () => {
  const slots = [null, null, { name: "bread", count: 2 }, { name: "emerald", count: 1 }, null];
  assert.equal(playerWindowItemCount({ slots, inventoryStart: 2, inventoryEnd: 5 }, "bread"), 2);
});

test("reads modern component and legacy custom names", () => {
  assert.equal(customNameText({ customName: { type: "string", value: "守护之剑" } }), "守护之剑");
  assert.equal(customNameText({ customName: '{"text":"守护之剑"}' }), "守护之剑");
  assert.equal(customNameText({ customName: "守护之剑" }), "守护之剑");
});
