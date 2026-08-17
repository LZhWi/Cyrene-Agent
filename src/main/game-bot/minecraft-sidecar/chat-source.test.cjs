"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { commandFeedbackContext, isPlayerCommandFeedback, translationKey } = require("./chat-source.cjs");

test("identifies command feedback by translation metadata", () => {
  assert.equal(isPlayerCommandFeedback("Set the time to 1000", "commands.time.set", null), true);
  assert.equal(translationKey(null, { json: { translate: "commands.gamemode.success.self" } }), "commands.gamemode.success.self");
});

test("recognizes vanilla time feedback without treating ordinary chat as a command", () => {
  assert.equal(isPlayerCommandFeedback("Set the time to 1000"), true);
  assert.equal(isPlayerCommandFeedback("Can we set the time to day later?"), false);
  assert.match(commandFeedbackContext("Set the time to 1000"), /不是对 GameBot 的命令/);
});
