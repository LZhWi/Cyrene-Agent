"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { MinecraftBody } = require("./body.cjs");

class Position {
  constructor(x = 0, y = 64, z = 0) { Object.assign(this, { x, y, z }); }
  distanceTo(p) { return Math.hypot(this.x - p.x, this.y - p.y, this.z - p.z); }
  offset(x, y, z) { return new Position(this.x + x, this.y + y, this.z + z); }
  floored() { return new Position(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)); }
  clone() { return new Position(this.x, this.y, this.z); }
  toString() { return `${this.x},${this.y},${this.z}`; }
}
class GoalNear { constructor(x, y, z, range) { Object.assign(this, { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z), range }); } }
class GoalFollow { constructor(entity) { this.entity = entity; } }
class Movements { constructor() { this.blocksToAvoid = new Set(); this.exclusionAreasStep = []; } }
const air = (p) => ({ type: 0, name: "air", boundingBox: "empty", position: p });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup() {
  let items = [];
  const results = [];
  const bot = {
    entity: { position: new Position() }, players: { Owner: { username: "Owner", entity: { position: new Position(8) } } },
    health: 20, food: 20, oxygenLevel: 20, game: { dimension: "overworld" },
    registry: { blocksByName: { oak_log: { id: 1 }, dirt: { id: 2 }, crafting_table: { id: 3 } }, itemsByName: { oak_planks: { id: 5 } } },
    inventory: { items: () => items },
    pathfinder: { stops: 0, setGoal(goal) { this.goal = goal; if (!goal) this.stops++; }, setMovements(movements) { this.movements = movements; },
      async goto(goal) { bot.entity.position = new Position(goal.x, goal.y, goal.z); } },
    stopDigging() {}, clearControlStates() {}, deactivateItem() {},
    blockAt: air, findBlocks: () => [], canDigBlock: () => true, equip: async () => {},
    recipesFor: () => [{ result: { count: 4 } }],
    async craft(_recipe, times) { items = [{ name: "oak_planks", type: 5, count: 4 * times }]; },
    async toss(_type, _meta, count) { items[0].count -= count; },
    findBlock: () => null,
  };
  const body = new MinecraftBody(bot, { goals: { GoalNear, GoalFollow }, Movements, owner: "Owner", onResult: (result) => results.push(result) });
  return { body, bot, results, setItems(value) { items = value; } };
}
const action = (id, kind, rest = {}) => ({ id, action: kind, timeoutMs: 1000, ...rest });

test("come verifies actual position instead of the return of goto", async () => {
  const { body, bot } = setup();
  bot.pathfinder.goto = async () => {};
  const result = await body.execute(action("not-arrived", "come"));
  assert.equal(result.status, "failed");
  assert.match(result.reason, /位置未达到目标/);
  await flush();
  bot.pathfinder.goto = async (goal) => { bot.entity.position = new Position(goal.x, goal.y, goal.z); };
  const done = await body.execute(action("arrived", "come"));
  assert.equal(done.status, "completed");
  assert.equal(done.after.position.x, 8);
  assert.equal(bot.pathfinder.goal, null);
});

test("timeout clears path and quarantines a goto that has not settled", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { body, bot, results } = setup();
  let release;
  bot.pathfinder.goto = () => new Promise((resolve) => { release = resolve; });
  const pending = body.execute(action("timeout", "come"));
  t.mock.timers.tick(1000);
  const result = await pending;
  assert.equal(result.status, "timed_out");
  assert.equal(bot.pathfinder.goal, null);
  assert.equal(body.snapshot().activeAction.draining, true);
  await assert.rejects(body.execute(action("overlap", "come")), /正在停止/);
  release();
  await flush();
  assert.equal(body.snapshot().activeAction, null);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "timed_out");
});

test("follow is active, exclusive, cancellable and has a deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { body, bot, results } = setup();
  assert.equal((await body.execute(action("follow", "follow"))).status, "active");
  await assert.rejects(body.execute(action("overlap", "come")), /已有动作/);
  t.mock.timers.tick(1000);
  assert.equal(results.at(-1).status, "timed_out");
  assert.equal(body.snapshot().activeAction, null);
  assert.equal(bot.pathfinder.goal, null);
  await body.execute(action("follow2", "follow"));
  body.cancel();
  assert.equal(results.at(-1).status, "cancelled");
});

test("cancelled craft never reports success or permits a concurrent late mutation", async () => {
  const { body, bot, results, setItems } = setup();
  let release;
  bot.craft = () => new Promise((resolve) => { release = () => { setItems([{ name: "oak_planks", type: 5, count: 4 }]); resolve(); }; });
  const pending = body.execute(action("craft", "craft", { material: "木板", count: 4 }));
  const result = body.cancel();
  assert.equal((await pending).status, "cancelled");
  assert.equal(result.effectsUncertain, true);
  await assert.rejects(body.execute(action("next", "come")), /正在停止/);
  release();
  await flush();
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "cancelled");
  assert.equal(body.snapshot().inventory.oak_planks, 4);
  assert.equal(body.snapshot().activeAction, null);
});

test("craft requires inventory confirmation and reports the measured delta", async () => {
  const { body } = setup();
  const result = await body.execute(action("craft", "craft", { material: "木板", count: 5 }));
  assert.equal(result.status, "completed");
  assert.equal(result.progress.inventoryDelta.oak_planks, 8);
  assert.equal(result.effectsUncertain, false);
});

test("confirmed first dig plus unavailable second block reports partial, not fake full collection", async () => {
  const { body, bot } = setup();
  const position = new Position(2);
  const target = { type: 1, name: "oak_log", position, boundingBox: "block" };
  let removed = false;
  bot.findBlocks = () => removed ? [] : [position];
  bot.blockAt = (p) => p.toString() === position.toString() && !removed ? target : air(p);
  bot.pathfinder.goto = async () => {};
  bot.dig = async () => { removed = true; };
  const result = await body.execute(action("collect", "collect", { material: "木头", count: 2 }));
  assert.equal(result.status, "partial");
  assert.equal(result.progress.dug, 1);
  assert.deepEqual(result.progress.inventoryDelta, {});
});

test("collect rejects danger, underground targets and the block supporting its own feet", () => {
  const { body, bot } = setup();
  const block = (position) => ({ type: 2, name: "dirt", position, boundingBox: "block" });
  assert.equal(body.safeBlock(block(new Position(0, 63)), 63), false);
  assert.equal(body.safeBlock(block(new Position(2, 62)), 63), false);
  bot.blockAt = (p) => ({ ...air(p), name: "lava" });
  assert.equal(body.safeBlock(block(new Position(2, 64)), 63), false);
  assert.equal(bot.pathfinder.movements.canDig, false);
  assert.equal(bot.pathfinder.movements.allow1by1towers, false);
});

test("give preserves escape reserve and distinguishes tossed from picked up", async () => {
  const { body, bot, setItems } = setup();
  bot.players.Owner.entity.position = new Position(2);
  setItems([{ name: "dirt", type: 2, count: 5 }]);
  const result = await body.execute(action("give", "give", { material: "泥土", count: 4 }));
  assert.equal(result.status, "partial");
  assert.equal(result.progress.transferred, 2);
  assert.equal(result.after.inventory.dirt, 3);
  assert.match(result.progress.note, /未确认主人拾取/);
});

test("unknown/invalid requests never reach the bot; duplicate IDs never replay", async () => {
  const { body } = setup();
  await assert.rejects(body.execute(action("unknown", "shell")), /不支持/);
  await assert.rejects(body.execute(action("too-many", "collect", { material: "泥土", count: 17 })), /数量/);
  await assert.rejects(body.execute(action("invalid", "collect", { material: "钻石", count: 1 })), /清单/);
  await body.execute(action("same", "come"));
  await flush();
  await assert.rejects(body.execute(action("same", "come")), /不会重放/);
});

test("death/disconnect cancels follow without replay; low health interrupts active movement", async () => {
  const { body, bot, results } = setup();
  await body.execute(action("follow", "follow"));
  bot.health = 5;
  body.reflex();
  assert.equal(results.at(-1).status, "cancelled");
  assert.match(results.at(-1).reason, /生命值/);
  bot.health = 20;
  await body.execute(action("follow2", "follow"));
  body.disconnect();
  assert.equal(results.at(-1).status, "disconnected");
  await assert.rejects(body.execute(action("next", "come")), /已断开/);
});

test("eat waits for delayed inventory confirmation after hunger gains and filters unsafe foods", async () => {
  const { body, bot, setItems } = setup();
  bot.food = 10;
  bot.registry.foodsByName = { rotten_flesh: { foodPoints: 20 }, bread: { foodPoints: 5 }, chicken: { foodPoints: 2 } };
  setItems([{ name: "rotten_flesh", count: 1 }, { name: "bread", count: 2 }, { name: "chicken", count: 1 }]);
  let equipped;
  bot.equip = async (food) => { equipped = food; };
  bot.consume = async () => { bot.food += 5; setTimeout(() => { equipped.count -= 1; }, 30); };
  const result = await body.execute(action("eat", "eat"));
  assert.equal(equipped.name, "bread");
  assert.equal(result.status, "completed");
  assert.equal(result.progress.foodGained, 5);
  assert.equal(result.progress.inventoryDelta.bread, -1);
});

test("pickup requires inventory gain, not only disappearance of a dropped entity", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { body, bot } = setup();
  const entity = { id: 7, name: "item", position: new Position(2) };
  bot.entities = { 7: entity };
  bot.pathfinder.goto = async (goal) => { bot.entity.position = new Position(goal.x, goal.y, goal.z); delete bot.entities[7]; };
  const pending = body.execute(action("pickup", "pickup", { count: 1 }));
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(1000);
  const result = await pending;
  assert.equal(result.status, "timed_out");
  assert.equal(result.progress.pickedStacks, 0);
  assert.equal(result.effectsUncertain, true);
  t.mock.timers.tick(100);
  await flush();
});

test("retreat uses verified checkpoints even at low health; changed terrain rejects the route", async () => {
  const { body, bot } = setup();
  bot.blockAt = (p) => p.y === 63 ? { type: 2, name: "dirt", boundingBox: "block", position: p } : air(p);
  body.reflex();
  bot.entity.position = new Position(5);
  body.reflex();
  bot.health = 5;
  const result = await body.execute(action("retreat", "retreat"));
  assert.equal(result.status, "completed");
  assert.equal(result.after.position.x, 0);
  await flush();
  bot.entity.position = new Position(5);
  bot.blockAt = (p) => ({ ...air(p), name: "lava" });
  const failed = await body.execute(action("changed", "retreat"));
  assert.equal(failed.status, "failed");
  assert.match(failed.reason, /地形已改变/);
});

test("automatic survival is opt-in, serialized and paused after manual stop", async () => {
  const { body, bot, setItems } = setup();
  bot.food = 10;
  bot.registry.foodsByName = { bread: { foodPoints: 5 } };
  setItems([{ name: "bread", count: 2 }]);
  let consumed = 0;
  bot.consume = async () => { consumed++; bot.food = 15; setItems([{ name: "bread", count: 1 }]); };
  body.reflex();
  await flush();
  assert.equal(consumed, 0);
  body.autoSurvival = true;
  body.reflex();
  body.reflex();
  await flush();
  assert.equal(consumed, 1);
  bot.food = 10;
  body.nextSurvivalAt = 0;
  body.cancel();
  body.reflex();
  await flush();
  assert.equal(consumed, 1);
});

test("zero health never starts an automatic escape before the death event", async () => {
  const { body, bot, results } = setup();
  body.autoSurvival = true;
  body.safePositions = [new Position(5)];
  bot.health = 0;
  body.reflex();
  await flush();
  assert.equal(results.length, 0);
  assert.equal(body.snapshot().activeAction, null);
  assert.equal((await body.execute(action("dead", "retreat"))).status, "failed");
});

test("fractional retreat checkpoints must reach their own cell, not a rounded adjacent cell", async () => {
  const { body, bot } = setup();
  bot.blockAt = (p) => p.y === 63 ? { name: "dirt", boundingBox: "block", position: p } : air(p);
  body.safePositions = [new Position(0.5), new Position(9.91)];
  bot.entity.position = new Position(4.34);
  bot.pathfinder.goto = async (goal) => { bot.entity.position = new Position(goal.range >= 1 ? goal.x - 1 : goal.x, goal.y, goal.z); };
  const result = await body.execute(action("fractional", "retreat"));
  assert.equal(result.status, "completed");
  assert.ok(result.after.position.x <= 1);
});
