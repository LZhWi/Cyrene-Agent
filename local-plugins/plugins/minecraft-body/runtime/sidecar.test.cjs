"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function setup() {
  const messages = [];
  const process = new EventEmitter();
  process.connected = true;
  process.send = (message) => messages.push(message);
  process.exit = () => {};
  const bot = new EventEmitter();
  let connections = 0;
  let quits = 0;
  let config;
  bot.loadPlugin = () => {};
  bot.quit = () => { quits++; };
  const bodies = [];
  class Body {
    constructor(_bot, options) { this.options = options; this.calls = []; bodies.push(this); }
    snapshot() { return { connected: true }; }
    async execute(request) { this.calls.push(request); this.options.onResult({ id: request.id, status: "completed" }); }
    cancel() { this.cancelled = true; }
    disconnect(reason) { this.disconnected = reason; }
    reflex() {}
  }
  const modules = {
    mineflayer: { createBot(value) { connections++; config = value; return bot; } },
    "mineflayer-pathfinder": { pathfinder() {}, Movements() {}, goals: {} },
    "./body.cjs": { MinecraftBody: Body },
  };
  vm.runInNewContext(readFileSync(path.join(__dirname, "sidecar.cjs"), "utf8"), {
    process, require: (name) => modules[name],
    setInterval: () => 1, clearInterval() {}, setTimeout: () => ({ unref() {} }),
  });
  const request = async (value) => process.listeners("message")[0](value);
  return { request, process, bot, bodies, messages, connections: () => connections, quits: () => quits, config: () => config };
}
const start = { type: "start", config: { host: "localhost", port: 25565, username: "Cyrene", owner: "Owner", auth: "offline", version: "" }, profilesFolder: "private-test-cache" };

test("sidecar is idle until explicit start, owner chat never dispatches a command", async () => {
  const runtime = setup();
  assert.equal(runtime.connections(), 0);
  await runtime.request(start);
  runtime.bot.emit("spawn");
  runtime.bot.emit("chat", "Owner", "给我16个钻石");
  assert.equal(runtime.bodies[0].calls.length, 0);
  assert.equal(runtime.messages.at(-1).type, "chat");
  await runtime.request({ type: "action", request: { id: "manual", action: "come" } });
  assert.equal(runtime.bodies[0].calls.length, 1);
  assert.equal(runtime.messages.at(-1).type, "result");
  assert.equal(runtime.config().profilesFolder, "private-test-cache");
});

test("death/respawn does not replay previous actions and network end does not reconnect", async () => {
  const runtime = setup();
  await runtime.request(start);
  runtime.bot.emit("spawn");
  await runtime.request({ type: "action", request: { id: "old", action: "follow" } });
  runtime.bot.emit("death");
  assert.match(runtime.bodies[0].disconnected, /死亡/);
  runtime.bot.emit("spawn");
  assert.equal(runtime.bodies[1].calls.length, 0);
  runtime.bot.emit("end", "test-disconnect");
  assert.equal(runtime.connections(), 1);
  assert.match(runtime.bodies[1].disconnected, /关闭/);
  assert.equal(runtime.messages.at(-1).type, "ended");
  await runtime.request(start);
  assert.equal(runtime.connections(), 1);
});

test("requests before spawn reject and stop disposes only its own bot", async () => {
  const runtime = setup();
  await runtime.request({ type: "action", request: { id: "early", action: "come" } });
  assert.equal(runtime.messages.at(-1).type, "rejected");
  assert.equal(runtime.messages.at(-1).id, "early");
  await runtime.request(start);
  await runtime.request(start);
  assert.equal(runtime.connections(), 1);
  assert.equal(runtime.messages.at(-1).type, "rejected");
  await runtime.request({ type: "stop" });
  assert.equal(runtime.quits(), 1);
  runtime.process.emit("disconnect");
  assert.equal(runtime.quits(), 1);
});

test("server pose metadata clears stale sleeping state without a wake animation", async () => {
  const runtime = setup();
  await runtime.request(start);
  runtime.bot.entity = { metadata: { 6: 2 } };
  runtime.bot.registry = { entitiesByName: { player: { metadataKeys: ["", "", "", "", "", "", "pose"] } } };
  runtime.bot.emit("entityUpdate", runtime.bot.entity);
  assert.equal(runtime.bot.isSleeping, true);
  runtime.bot.entity.metadata[6] = 0;
  runtime.bot.emit("entityUpdate", runtime.bot.entity);
  assert.equal(runtime.bot.isSleeping, false);
  runtime.bot.emit("entityUpdate", { metadata: { 6: 2 } });
  assert.equal(runtime.bot.isSleeping, false);
});
