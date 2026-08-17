"use strict";

const path = require("node:path");
const { fork } = require("node:child_process");
const { readMinecraftSettings } = require("./live-provider-smoke.cjs");

const settingsPath = process.argv[2];
if (!settingsPath) throw new Error("usage: node live-mode-switch-smoke.cjs <game-bot-settings.json>");
const original = readMinecraftSettings(settingsPath);
const child = fork(path.join(__dirname, "sidecar.cjs"), [], { cwd: __dirname, stdio: ["ignore", "ignore", "ignore", "ipc"] });
const switched = [];
let finished = false;
const timer = setTimeout(() => finish({ ok: false, error: "mode switch timeout" }), 30_000);

function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (child.connected) child.send({ type: "stop" });
  setTimeout(() => { if (!child.killed) child.kill(); }, 1000).unref();
  process.stdout.write(`${JSON.stringify({ ...result, switched })}\n`);
  if (!result.ok) process.exitCode = 1;
}

child.on("message", (message) => {
  const text = String(message?.message || "");
  if (/Minecraft 已登录/.test(text)) child.send({ type: "autonomy_update", autonomy: { mode: "companion" } });
  if (/自主模式已切换为：陪伴/.test(text)) {
    switched.push("companion");
    child.send({ type: "autonomy_update", autonomy: { mode: "passive" } });
  }
  if (/自主模式已切换为：被动/.test(text)) {
    switched.push("passive");
    finish({ ok: switched.join(",") === "companion,passive" });
  }
});
child.on("exit", (code) => { if (!finished) finish({ ok: false, error: `sidecar exited ${code}` }); });
child.send({ type: "start", settings: {
  ...original, username: "CyreneMode", owner: "NoSuchOwner", auth: "offline", reconnect: false,
  autonomy: { mode: "passive", visionEnabled: false }, soul: { ...original.soul, enabled: false }, llm: { ...original.llm, enabled: false },
  profilesFolder: path.join(__dirname, ".mode-auth-unused"), stateFile: path.join(__dirname, ".mode-state-unused.json"),
} });
