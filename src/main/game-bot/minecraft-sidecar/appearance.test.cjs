"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { acceptAppearance, refreshAppearance, skinVersion } = require("./appearance.cjs");

test("versions appearance by the current skin texture without exposing its URL", () => {
  const first = skinVersion({ skinData: { url: "https://textures.test/skin-a" } });
  const second = skinVersion({ skinData: { url: "https://textures.test/skin-b" } });
  assert.equal(first.length, 16);
  assert.notEqual(first, second);
  assert.equal(first.includes("textures"), false);
});

test("keeps a description only while the skin version matches", () => {
  let cache = refreshAppearance(null, "skin-a");
  cache = acceptAppearance(cache, "skin-a", "黄色上衣，深色头发");
  assert.equal(cache.description, "黄色上衣，深色头发");
  assert.equal(refreshAppearance(cache, "skin-b").description, "");
  assert.equal(acceptAppearance(refreshAppearance(null, "skin-a"), "skin-a", "无法确定具体外观").description, "");
});
