"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("live smoke harness stays read-only and uses only the status action", () => {
  const source = fs.readFileSync(path.join(__dirname, "live-minecraft-smoke.cjs"), "utf8");
  assert.match(source, /allowedActions:\s*\["status"\]/);
  assert.match(source, /requiredActions:\s*\["status"\]/);
  assert.match(source, /request:\s*"报告当前状态"/);
  assert.doesNotMatch(source, /writeFile|unlink|rmSync|execSync/);
});

test("mock Soul covers task-brief, action-start and final-reply calls", () => {
  const source = fs.readFileSync(path.join(__dirname, "live-minecraft-soul-mock.cjs"), "utf8");
  assert.match(source, /isTaskBrief/);
  assert.match(source, /isActionStart/);
  assert.match(source, /isFinalReply/);
  assert.match(source, /calls === 3/);
});
