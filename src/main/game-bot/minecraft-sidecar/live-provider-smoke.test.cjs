"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { extractObjectProperty } = require("./live-provider-smoke.cjs");

test("extracts isolated Minecraft settings when an unrelated earlier section is malformed", () => {
  const source = '{"broken":["unterminated],"minecraft":{"port":1314,"llm":{"apiKey":"secret"},"soul":{"apiKey":"other"}}}';
  const minecraft = extractObjectProperty(source, "minecraft");
  assert.equal(minecraft.port, 1314);
  assert.equal(minecraft.llm.apiKey, "secret");
});

test("Kimi smoke mode requires both task-brief and final-reply phases", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "live-provider-smoke.cjs"), "utf8");
  assert.match(source, /mode === "soul" \? results\.soul\.ok && results\.pipeline\.ok/);
});
