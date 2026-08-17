"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createChatOutput, splitChatMessage } = require("./chat-output.cjs");

test("routes deterministic action output to logs instead of Minecraft chat", () => {
  const sent = [];
  const logs = [];
  const output = createChatOutput({ sendChat: (text) => sent.push(text), log: (text) => logs.push(text) });

  assert.equal(output.internal("  已经开始跟随。  "), "已经开始跟随。");
  assert.deepEqual(sent, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^Minecraft 动作：已经开始跟随/);
});

test("sends repeated final model replies without filtering them", () => {
  const sent = [];
  const logs = [];
  const output = createChatOutput({
    sendChat: (text) => sent.push(text),
    log: (text) => logs.push(text),
  });

  assert.equal(output.model("好的，我们出发吧！"), true);
  assert.equal(output.model("好的，我们出发吧！"), true);
  assert.deepEqual(sent, ["好的，我们出发吧！", "好的，我们出发吧！"]);
  assert.deepEqual(logs, []);
});

test("splits a long model reply into protocol-safe complete chunks", () => {
  const first = "这是第一段环境评价。".repeat(18);
  const second = "这是最后的完整结论。".repeat(8);
  const original = `${first}${second}`;
  const chunks = splitChatMessage(original);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => Array.from(chunk).length <= 220));
  assert.equal(chunks.join(""), original);
  assert.match(chunks.at(-1), /完整结论。$/);
});
