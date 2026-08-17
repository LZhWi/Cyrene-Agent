"use strict";

const { createHash } = require("node:crypto");

function skinVersion(player) {
  const url = String(player?.skinData?.url || "").trim();
  if (!url) return "unknown";
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function refreshAppearance(cache, version) {
  if (!cache || cache.skinVersion !== version) return { skinVersion: version, description: "" };
  return cache;
}

function acceptAppearance(cache, version, description) {
  const text = String(description || "").replace(/\s+/g, " ").trim().slice(0, 240);
  if (!text || /无法确定|看不清|未知|仅知|无法辨认/.test(text) || cache?.skinVersion !== version) return cache;
  return { skinVersion: version, description: text };
}

module.exports = { acceptAppearance, refreshAppearance, skinVersion };
