"use strict";

function currentWindowSlot(window, inventorySlot) {
  if (!window || !Number.isInteger(inventorySlot)) return null;
  if (inventorySlot < 9 || inventorySlot > 44) return null;
  return window.inventoryStart + inventorySlot - 9;
}

function playerWindowItems(window) {
  if (!window || !Array.isArray(window.slots)) return [];
  return window.slots.slice(window.inventoryStart, window.inventoryEnd);
}

function playerWindowItemCount(window, name) {
  return playerWindowItems(window)
    .filter((item) => item?.name === name)
    .reduce((sum, item) => sum + item.count, 0);
}

function customNameText(item) {
  const name = item?.customName;
  if (typeof name === "string") {
    try { return customNameText({ customName: JSON.parse(name) }); } catch { return name; }
  }
  if (!name || typeof name !== "object") return null;
  if (typeof name.text === "string") return name.text;
  if (typeof name.value === "string") return name.value;
  if (typeof name.data === "string") return name.data;
  return null;
}

module.exports = { currentWindowSlot, customNameText, playerWindowItemCount, playerWindowItems };
