"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { MinecraftBody, validateAction } = require("./body.cjs");

class Position {
  constructor(x = 0.5, y = 64, z = 0.5) { Object.assign(this, { x, y, z }); }
  offset(x, y, z) { return new Position(this.x + x, this.y + y, this.z + z); }
  minus(p) { return new Position(this.x - p.x, this.y - p.y, this.z - p.z); }
  norm() { return Math.hypot(this.x, this.y, this.z); }
  normalize() { const n = this.norm(); return new Position(this.x / n, this.y / n, this.z / n); }
  distanceTo(p) { return Math.hypot(this.x - p.x, this.y - p.y, this.z - p.z); }
  floored() { return new Position(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)); }
  clone() { return new Position(this.x, this.y, this.z); }
  toString() { return `${this.x},${this.y},${this.z}`; }
}
class GoalNear { constructor(x, y, z, range) { Object.assign(this, { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z), range }); } }
class Movements { constructor() { this.blocksToAvoid = new Set(); this.exclusionAreasStep = []; } }
const flush = () => new Promise((resolve) => setImmediate(resolve));
const request = (action, rest = {}) => ({ id: `test-${action}`, action, timeoutMs: 1000, ...rest });

function setup(session = {}) {
  const world = new Map();
  let items = [];
  const bot = new EventEmitter();
  Object.assign(bot, {
    entity: { id: 1, position: new Position(), eyeHeight: 1.62 }, entities: {}, players: { Owner: { entity: { position: new Position(2.5) } } },
    game: { dimension: "overworld" }, health: 20, food: 20,
    registry: { blocksByName: { farmland: { id: 4 } }, itemsByName: {} },
    inventory: { items: () => items, slots: [] },
    blockAt(p) {
      p = p.floored();
      return world.get(p.toString()) || { type: p.y < 64 ? 1 : 0, name: p.y < 64 ? "stone" : "air", boundingBox: p.y < 64 ? "block" : "empty", position: p };
    },
    findBlock({ matching, maxDistance, useExtraInfo }) { return [...world.values()].find((block) => block.position.distanceTo(bot.entity.position) <= maxDistance &&
      (typeof matching === "function" ? matching({ ...block, position: null }) && matching(block) : matching.includes(block.type)) &&
      (typeof useExtraInfo !== "function" || useExtraInfo(block))); },
    pathfinder: { setMovements(m) { this.movements = m; }, setGoal() {}, async goto(goal) { bot.entity.position = new Position(goal.x + 0.5, goal.y, goal.z + 0.5); } },
    stopDigging() {}, clearControlStates() {}, deactivateItem() {},
    async equip(item, destination) { if (destination === "hand") bot.heldItem = item; else bot.inventory.slots[{ head: 5, torso: 6, legs: 7, feet: 8, "off-hand": 45 }[destination]] = item; },
    async lookAt(p) { bot.lookedAt = p; },
    async waitForTicks() {},
    isABed(block) { return block?.name.endsWith("_bed"); },
    async sleep(bed) { bot.isSleeping = true; bot.entity.position = bed.position.offset(0.5, 0.6, 0.5); }, async wake() { bot.isSleeping = false; },
    supportFeature: () => false,
  });
  bot.entities[1] = bot.entity;
  const results = [];
  const body = new MinecraftBody(bot, { goals: { GoalNear }, Movements, owner: "Owner", session, onResult: (r) => results.push(r) });
  const block = (name, p, properties = {}) => {
    const b = { name, type: name === "air" ? 0 : name === "farmland" ? 4 : 2, boundingBox: ["air", "wheat", "carrots", "potatoes", "beetroots", "torch"].includes(name) ? "empty" : "block", position: p,
      getProperties: () => Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, typeof value === "number" ? String(value) : value])) };
    bot.registry.blocksByName[name] = { id: b.type };
    world.set(p.toString(), b); return b;
  };
  const setItems = (value) => { items = value; };
  return { bot, body, block, setItems, results };
}

test("new actions reject missing/invalid coordinates, crops, booleans and counts before execution", () => {
  for (const value of [request("goto"), request("goto", { position: { x: Infinity, y: 64, z: 0 } }), request("place", { material: "泥土", position: { x: 1.5, y: 64, z: 0 } }),
    request("plant", { material: "火把", count: 1 }), request("till", { count: 17 }), request("door", { open: "false" }), request("smelt", { material: "炸药", count: 1 })]) assert.throws(() => validateAction(value));
});

test("home is safe and dimension-bound, survives rebirth in the same session, and rejects unloaded/remote destinations", async () => {
  const session = {};
  const { bot, body, block } = setup(session);
  assert.equal((await body.execute(request("set_home"))).status, "completed"); await flush();
  bot.entity.position = new Position(5.5);
  assert.equal((await body.execute(request("home"))).status, "completed"); await flush();
  const reborn = setup(session);
  assert.deepEqual(reborn.body.snapshot().bookmarks.home.position, { x: 0.5, y: 64, z: 0.5 });
  reborn.bot.game.dimension = "the_nether";
  assert.match((await reborn.body.execute(request("home"))).reason, /其他维度/);
  block("lava", new Position(2, 63, 0));
  assert.equal((await body.execute(request("goto", { position: { x: 2.5, y: 64, z: 0.5 } }))).status, "failed"); await flush();
  assert.equal((await body.execute(request("goto", { id: "far", position: { x: 100, y: 64, z: 0 } }))).status, "failed");
});

test("equip checks real slots; armor never replaces a superior equipped piece", async () => {
  const { body, bot, setItems } = setup();
  setItems([{ name: "iron_helmet", type: 2, count: 1 }, { name: "diamond_boots", type: 3, count: 1 }, { name: "shield", type: 4, count: 1 }]);
  bot.inventory.slots[5] = { name: "diamond_helmet", type: 5 };
  assert.equal((await body.execute(request("equip_armor"))).status, "completed"); await flush();
  assert.equal(bot.inventory.slots[5].name, "diamond_helmet");
  assert.equal(bot.inventory.slots[8].name, "diamond_boots");
  assert.ok(bot.pathfinder.movements.blocksToAvoid.has(4));
  assert.equal((await body.execute(request("equip_shield"))).status, "completed"); await flush();
  assert.equal(bot.inventory.slots[45].name, "shield");
  assert.equal((await body.execute(request("equip", { material: "shield" }))).status, "completed");
});

test("movement also excludes farmland and hazardous floors below an empty walking cell", () => {
  const { body, bot, block } = setup();
  const foot = new Position(2, 64, 0);
  block("farmland", foot.offset(0, -1, 0));
  assert.equal(body.safePosition(foot), false);
  assert.equal(bot.pathfinder.movements.exclusionAreasStep[0](bot.blockAt(foot)), Infinity);
  block("magma_block", foot.offset(0, -1, 0));
  assert.equal(bot.pathfinder.movements.exclusionAreasStep[0](bot.blockAt(foot)), Infinity);
  block("stone", foot.offset(0, -1, 0));
  assert.equal(bot.pathfinder.movements.exclusionAreasStep[0](bot.blockAt(foot)), 0);
});

test("placement refuses occupied or unsupported cells and confirms both block and inventory", async () => {
  const { body, bot, setItems, block } = setup();
  const item = { name: "torch", type: 5, count: 2 };
  setItems([item]);
  let calls = 0;
  bot.placeBlock = async (ground) => { calls++; block("torch", ground.position.offset(0, 1, 0)); item.count--; };
  assert.equal((await body.execute(request("place", { material: "火把", position: { x: 0, y: 64, z: 0 } }))).status, "failed"); await flush();
  assert.equal(calls, 0);
  const result = await body.execute(request("place", { id: "safe-place", material: "火把", position: { x: 2, y: 64, z: 0 } }));
  assert.equal(result.status, "completed");
  assert.equal(result.progress.inventoryDelta.torch, -1);
  assert.equal(calls, 1);
});

function chest(runtime) {
  const { bot, block } = runtime;
  const p = new Position(2, 64, 0);
  block("chest", p); bot.registry.blocksByName.chest = { id: 2 };
  const window = { inventoryStart: 27, inventoryEnd: 63, slots: Array(63).fill(null), close() { this.closed = true; runtime.setItems(this.slots.slice(27).filter(Boolean)); } };
  bot.openContainer = async () => {
    window.slots.fill(null, 27);
    bot.inventory.items().forEach((item, index) => { window.slots[27 + index] = { ...item }; });
    return window;
  };
  return window;
}

test("chest transfer verifies both sides and preserves the shared escape reserve", async () => {
  const runtime = setup(); const { body, bot, setItems } = runtime;
  const window = chest(runtime);
  const stack = { name: "diamond", type: 5, metadata: 0, count: 3 };
  setItems([stack, { name: "dirt", type: 6, count: 3 }]);
  window.deposit = async (type, _metadata, amount) => { assert.equal(type, 5); window.slots[27].count -= amount; window.slots[0] = { name: "diamond", type, count: amount }; };
  window.withdraw = async (_type, _metadata, amount) => { window.slots[27].count += amount; window.slots[0].count -= amount; };
  await body.execute(request("bind_chest")); await flush();
  const result = await body.execute(request("deposit", { material: "diamond", count: 2 })); await flush();
  assert.equal(result.status, "completed"); assert.equal(result.progress.inventoryDelta.diamond, -2); assert.ok(window.closed);
  assert.equal((await body.execute(request("withdraw", { material: "diamond", count: 1 }))).status, "completed"); await flush();
  assert.equal((await body.execute(request("deposit", { id: "reserve", material: "泥土", count: 1 }))).status, "failed");
  assert.equal(bot.inventory.items()[1].count, 3);
});

test("cancelling container open prevents a late transfer and closes the late window", async () => {
  const runtime = setup(); const { body, bot, setItems } = runtime;
  const window = chest(runtime); setItems([{ name: "diamond", type: 5, count: 3 }]);
  window.slots[27] = { name: "diamond", type: 5, count: 3 };
  await body.execute(request("bind_chest")); await flush();
  let release, called = 0;
  bot.openContainer = () => new Promise((r) => { release = () => r(window); });
  window.deposit = async () => { called++; };
  const pending = body.execute(request("deposit", { material: "diamond", count: 1 }));
  await flush(); body.cancel(); assert.equal((await pending).status, "cancelled");
  await assert.rejects(body.execute(request("look")), /正在停止/);
  release(); await flush(); assert.equal(called, 0); assert.ok(window.closed); assert.equal(body.snapshot().inventory.diamond, 3);
});

test("beds refuse other dimensions before activation; sleep and wake require actual sleeping state", async () => {
  const { body, bot, block } = setup();
  block("white_bed", new Position(2, 64, 0));
  await body.execute(request("bind_bed")); await flush();
  assert.equal((await body.execute(request("sleep"))).status, "completed"); await flush();
  assert.equal(body.snapshot().sleeping, true);
  assert.equal((await body.execute(request("wake"))).status, "completed"); await flush();
  bot.game.dimension = "the_nether";
  assert.equal((await body.execute(request("sleep", { id: "explosive-bed" }))).status, "failed"); assert.equal(bot.isSleeping, false);
});

test("modern wake uses the named leave_bed mapping instead of numeric stop_sprinting", async () => {
  const { body, bot } = setup();
  bot.isSleeping = true;
  bot.supportFeature = (name) => name === "entityActionUsesStringMapper";
  let sent;
  bot._client = { write(name, packet) { sent = { name, packet }; bot.isSleeping = false; } };
  bot.wake = () => { throw new Error("legacy numeric wake must not run"); };
  assert.equal((await body.execute(request("wake"))).status, "completed");
  assert.deepEqual(sent, { name: "entity_action", packet: { entityId: 1, actionId: "leave_bed", jumpBoost: 0 } });
});

test("harvest targets mature crops only; planting confirms seed consumption and avoids occupied farmland", async () => {
  const { body, bot, block, setItems } = setup();
  const p = new Position(2, 64, 0);
  block("wheat", p, { age: 6 });
  let digs = 0; bot.dig = async () => { digs++; block("air", p); };
  assert.equal((await body.execute(request("harvest", { material: "小麦", count: 1 }))).status, "failed"); await flush();
  assert.equal(digs, 0);
  block("wheat", p, { age: 7 });
  assert.equal((await body.execute(request("harvest", { id: "ripe", material: "小麦", count: 1 }))).status, "completed"); await flush();
  block("farmland", p.offset(0, -1, 0));
  const seeds = { name: "wheat_seeds", type: 8, count: 2 }; setItems([seeds]);
  bot.placeBlock = async (ground) => { block("wheat", ground.position.offset(0, 1, 0), { age: 0 }); seeds.count--; };
  const planted = await body.execute(request("plant", { material: "小麦", count: 1 }));
  assert.equal(planted.status, "completed"); assert.equal(planted.progress.inventoryDelta.wheat_seeds, -1);
});

test("confirmed first soil plus unavailable second soil reports partial even without an inventory delta", async () => {
  const { body, bot, block, setItems } = setup();
  const p = new Position(2, 63, 0);
  block("dirt", p); block("water", new Position(4, 63, 0));
  setItems([{ name: "iron_hoe", type: 8, count: 1 }]);
  bot.activateBlock = async () => { block("farmland", p); };
  const result = await body.execute(request("till", { count: 2 }));
  assert.equal(result.status, "partial"); assert.equal(result.progress.changed, 1);
  assert.deepEqual(result.progress.inventoryDelta, {});
});

test("busy furnace is closed without inserting fuel or taking someone else's output", async () => {
  const { body, bot, block, setItems } = setup();
  block("furnace", new Position(2, 64, 0)); bot.registry.blocksByName.furnace = { id: 2 };
  setItems([{ name: "raw_iron", type: 3, count: 2 }, { name: "coal", type: 4, count: 2 }]);
  let calls = 0;
  const furnace = { inputItem: () => null, fuelItem: () => null, outputItem: () => ({ name: "iron_ingot", count: 1 }), close() { this.closed = true; }, putFuel: async () => { calls++; } };
  bot.openFurnace = async () => furnace;
  const result = await body.execute(request("smelt", { material: "铁", count: 1 }));
  assert.equal(result.status, "failed"); assert.equal(calls, 0); assert.ok(furnace.closed);
});

test("stopped furnace work never takes late output; residual materials remain reported as uncertain", async () => {
  const { body, bot, block, setItems } = setup();
  block("furnace", new Position(2, 64, 0)); bot.registry.blocksByName.furnace = { id: 2 };
  const input = { name: "raw_iron", type: 3, count: 2 }, coal = { name: "coal", type: 4, count: 2 }; setItems([input, coal]);
  let release, took = false;
  const furnace = { fuel: 0, inputItem: () => null, fuelItem: () => null, outputItem: () => null, close() { this.closed = true; },
    putFuel: async () => { coal.count--; }, putInput: () => new Promise((r) => { input.count--; release = r; }), takeOutput: async () => { took = true; } };
  bot.openFurnace = async () => furnace;
  const pending = body.execute(request("smelt", { material: "铁", count: 1 })); await flush();
  body.cancel(); const result = await pending; assert.ok(result.effectsUncertain);
  furnace.outputItem = () => ({ name: "iron_ingot", count: 1 }); release(); await flush();
  assert.equal(took, false); assert.ok(furnace.closed);
});

test("defend rejects players, pets and low health before attacking", async () => {
  const { body, bot, setItems } = setup();
  setItems([{ name: "iron_sword", type: 5, count: 1 }]);
  bot.entities[2] = { id: 2, name: "player", position: new Position(2.5) };
  bot.entities[3] = { id: 3, name: "wolf", position: new Position(2.5) };
  let attacks = 0; bot.attack = () => { attacks++; };
  assert.equal((await body.execute(request("defend"))).status, "failed"); await flush();
  bot.entities[4] = { id: 4, name: "husk", position: new Position(2.5) }; bot.health = 6;
  assert.equal((await body.execute(request("defend", { id: "hurt" }))).status, "failed"); assert.equal(attacks, 0);
});

test("escaping refuses a deep pit without issuing jump or block placement", async () => {
  const { body, bot, block, setItems } = setup();
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) block("stone", new Position(x, 65, z));
  setItems([{ name: "dirt", type: 2, count: 3 }]);
  let mutations = 0; bot.setControlState = () => { mutations++; }; bot.placeBlock = async () => { mutations++; };
  assert.equal((await body.execute(request("escape"))).status, "failed"); assert.equal(mutations, 0);
});

test("defend refuses a blocked ray and confirms the death event rather than disappearance", async () => {
  const { body, bot, setItems } = setup();
  setItems([{ name: "iron_sword", type: 5, count: 1 }]);
  const hostile = { id: 2, name: "husk", height: 1.95, position: new Position(2.5) }; bot.entities[2] = hostile;
  let attacks = 0;
  bot.world = { raycast: () => ({ name: "glass" }) };
  bot.attack = () => { attacks++; bot.emit("entityDead", hostile); };
  assert.match((await body.execute(request("defend"))).reason, /视线/); await flush();
  assert.equal(attacks, 0); assert.equal(bot.listenerCount("entityDead"), 0);
  bot.world.raycast = () => null;
  const result = await body.execute(request("defend", { id: "visible-hostile", timeoutMs: 2000 }));
  assert.equal(result.status, "completed"); assert.equal(result.progress.defeated, "husk");
  assert.equal(attacks, 1); assert.equal(bot.listenerCount("entityDead"), 0);
});

test("inventory-only chest change is never declared a successful transfer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const runtime = setup(); const { body, setItems } = runtime;
  const window = chest(runtime);
  const item = { name: "diamond", type: 5, count: 3 }; setItems([item]);
  window.deposit = async () => { window.slots[27].count--; };
  await body.execute(request("bind_chest")); await flush();
  const pending = body.execute(request("deposit", { material: "diamond", count: 1 })); await flush();
  t.mock.timers.tick(1000);
  const result = await pending; assert.equal(result.status, "timed_out"); assert.ok(result.effectsUncertain);
  await flush(); assert.ok(window.closed);
});

test("cancelled shallow escape clears jump and never places a later block", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { body, bot, block, setItems } = setup();
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) if (x || z) block("stone", new Position(x, 64, z));
  setItems([{ name: "dirt", type: 2, count: 3 }]);
  const controls = {}; let placements = 0;
  const order = [];
  bot.lookAt = async () => { order.push("look"); };
  bot.setControlState = (key, value) => { controls[key] = value; if (value) order.push(key); };
  bot.clearControlStates = () => { controls.jump = false; };
  bot.placeBlock = async () => { placements++; };
  const pending = body.execute(request("escape")); await flush();
  assert.equal(controls.jump, true);
  assert.deepEqual(order, ["look", "jump"]);
  body.cancel(); assert.equal((await pending).status, "cancelled"); assert.equal(controls.jump, false);
  t.mock.timers.tick(100); await flush(); assert.equal(placements, 0); assert.equal(body.snapshot().activeAction, null);
});
