"use strict";
const { randomUUID } = require("node:crypto");
const { MATERIAL_ALIASES, CRAFT_ALIASES, MAX_COUNT } = require("./legacy/commands.cjs");
const { ESCAPE_BLOCKS, escapeBlockCount, transferableCount } = require("./legacy/safety.cjs");
const { selectUsableTool } = require("./legacy/tools.cjs");
const { environmentDanger, HAZARDOUS_BLOCKS } = require("./legacy/environment.cjs");
const { runCommon, COMMON_ACTIONS, COUNT_ACTIONS, ITEM_ACTIONS, CROPS, SMELTS } = require("./common-actions.cjs");

const ACTIONS = new Set(["come", "follow", "collect", "craft", "give", "pickup", "eat", "retreat", ...COMMON_ACTIONS]);
const MATERIAL_ACTIONS = new Set(["collect", "craft", "give"]);
const COLLECT_MATERIALS = { ...MATERIAL_ALIASES, "煤矿": ["coal_ore", "deepslate_coal_ore"], "铁矿": ["iron_ore", "deepslate_iron_ore"], "铜矿": ["copper_ore", "deepslate_copper_ore"] };
const UNSAFE_FOOD = new Set(["rotten_flesh", "pufferfish", "spider_eye", "poisonous_potato", "suspicious_stew", "chorus_fruit", "chicken"]);
const offsets = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const point = (p) => p && ({ x: p.x, y: p.y, z: p.z });
const counts = (items) => items.reduce((out, item) => {
  out[item.name] = (out[item.name] || 0) + item.count;
  return out;
}, {});

function validateAction(value) {
  if (!value || typeof value !== "object" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.id || "")) throw new Error("动作 ID 无效");
  if (!ACTIONS.has(value.action)) throw new Error("不支持的动作");
  const timeoutMs = value.timeoutMs ?? 60000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new Error("超时应为 1000..300000 毫秒");
  if (MATERIAL_ACTIONS.has(value.action) || ITEM_ACTIONS.has(value.action)) {
    if (typeof value.material !== "string" || !value.material || value.material.length > 64) throw new Error("材料无效");
    if (["plant", "harvest"].includes(value.action) && !CROPS[value.material]) throw new Error("作物应为小麦、胡萝卜、马铃薯或甜菜");
    if (value.action === "smelt" && !SMELTS[value.material]) throw new Error("物品不在烧炼清单中");
    if (value.action === "collect" && !COLLECT_MATERIALS[value.material]) throw new Error("材料不在安全采集清单中");
    if (value.action === "craft" && !CRAFT_ALIASES[value.material] && !Object.values(CRAFT_ALIASES).includes(value.material)) throw new Error("物品不在合成清单中");
  }
  if (MATERIAL_ACTIONS.has(value.action) || COUNT_ACTIONS.has(value.action)) {
    if (!Number.isInteger(value.count) || value.count < 1 || value.count > MAX_COUNT) throw new Error(`数量应为 1..${MAX_COUNT}`);
  }
  let position;
  if (["goto", "place"].includes(value.action)) {
    const p = value.position;
    if (!p || ![p.x, p.y, p.z].every(Number.isFinite) || Math.abs(p.x) > 30000000 || Math.abs(p.z) > 30000000 || p.y < -2048 || p.y > 2048) throw new Error("目标坐标无效");
    if (value.action === "place" && ![p.x, p.y, p.z].every(Number.isInteger)) throw new Error("放置坐标应为整数方块坐标");
    position = { x: p.x, y: p.y, z: p.z };
  }
  if (value.action === "door" && typeof value.open !== "boolean") throw new Error("开门状态应为布尔值");
  if (value.action === "pickup" && (!Number.isInteger(value.count) || value.count < 1 || value.count > MAX_COUNT)) throw new Error(`掉落实体上限应为 1..${MAX_COUNT}`);
  return { id: value.id, action: value.action, timeoutMs, material: value.material, count: value.count, position, open: value.open };
}

class MinecraftBody {
  constructor(bot, { goals, Movements, owner, autoSurvival = false, session = {}, onResult = () => {} }) {
    this.bot = bot;
    this.goals = goals;
    this.owner = owner;
    this.onResult = onResult;
    this.ready = true;
    this.active = null;
    this.seen = new Set();
    this.autoSurvival = autoSurvival;
    this.session = session;
    this.safePositions = [];
    this.survivalPausedUntil = 0;
    this.nextSurvivalAt = 0;
    const movements = new Movements(bot);
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.allowParkour = false;
    movements.maxDropDown = 0;
    movements.allowSprinting = false;
    for (const name of HAZARDOUS_BLOCKS) {
      const id = bot.registry.blocksByName[name]?.id;
      if (Number.isInteger(id)) movements.blocksToAvoid.add(id);
    }
    const farmland = bot.registry.blocksByName.farmland?.id;
    if (Number.isInteger(farmland)) movements.blocksToAvoid.add(farmland);
    // blocksToAvoid tests the feet/head block, not the solid floor below.
    movements.exclusionAreasStep.push((block) => {
      const below = bot.blockAt(block.position.offset(0, -1, 0));
      return [block, below].some((b) => b && (b.name === "farmland" || HAZARDOUS_BLOCKS.has(b.name))) ? Infinity : 0;
    });
    bot.pathfinder.setMovements(movements);
  }

  snapshot() {
    const bot = this.bot;
    const p = bot.entity?.position;
    const inventory = counts(bot.inventory.items());
    return {
      connected: this.ready, position: point(p), health: bot.health, food: bot.food,
      oxygen: bot.oxygenLevel, dimension: bot.game?.dimension, inventory,
      owner: point(bot.players[this.owner]?.entity?.position),
      bookmarks: { ...this.session }, sleeping: !!bot.isSleeping,
      equipment: Object.fromEntries([["head", 5], ["torso", 6], ["legs", 7], ["feet", 8], ["shield", 45]].map(([name, slot]) => [name, bot.inventory.slots?.[slot]?.name || null])),
      heldItem: bot.heldItem?.name || null,
      survival: { enabled: this.autoSurvival, pausedUntil: this.survivalPausedUntil, safePoints: this.safePositions.map(point) },
      activeAction: this.active && { id: this.active.request.id, action: this.active.request.action, draining: this.active.finished },
      nearbyPlayers: Object.values(bot.players).filter((player) => player.entity && p && player.entity.position.distanceTo(p) <= 32)
        .slice(0, 16).map((player) => ({ name: player.username, position: point(player.entity.position) })),
      sampledAt: new Date().toISOString(),
    };
  }

  halt() {
    // Each cleanup is independent: a failed stopDigging must not leave controls pressed.
    for (const stop of [() => this.bot.pathfinder.setGoal(null), () => this.bot.stopDigging(),
      () => this.bot.clearControlStates(), () => this.bot.deactivateItem()]) {
      try { const pending = stop(); pending?.catch?.(() => {}); } catch {}
    }
  }

  finish(task, status, reason = "") {
    if (task.finished) return task.result;
    task.finished = true;
    clearTimeout(task.timer);
    this.halt();
    const after = this.snapshot();
    const inventoryDelta = {};
    for (const name of new Set([...Object.keys(task.before.inventory), ...Object.keys(after.inventory)])) {
      const delta = (after.inventory[name] || 0) - (task.before.inventory[name] || 0);
      if (delta) inventoryDelta[name] = delta;
    }
    const result = {
      id: task.request.id, action: task.request.action, status, reason,
      startedAt: task.startedAt, finishedAt: new Date().toISOString(),
      effectsUncertain: !!task.mutationIssued && status !== "completed",
      progress: { ...task.progress, inventoryDelta }, before: task.before, after,
    };
    task.result = result;
    task.resolve(result);
    this.onResult(result);
    return result;
  }

  cancel(reason = "手动停止", status = "cancelled") {
    if (reason === "手动停止") this.survivalPausedUntil = Date.now() + 30000;
    const task = this.active;
    this.halt();
    if (!task) return null;
    const result = this.finish(task, status, reason);
    // An outstanding dig/craft/goto retains the slot until its promise settles.
    // A new request cannot race a late world mutation from the cancelled action.
    if (task.request.action === "follow") this.active = null;
    return result;
  }

  disconnect(reason = "连接已断开") {
    this.ready = false;
    this.cancel(reason, "disconnected");
  }

  check(task) {
    if (!this.ready || this.active !== task || task.finished) throw new Error("动作已停止");
    if (this.bot.health <= 0) throw new Error("角色已死亡，停止动作");
    if (this.bot.health <= 6 && !["eat", "retreat", "escape", "wake"].includes(task.request.action)) throw new Error("生命值过低，停止动作");
    const p = this.bot.entity.position.floored();
    const danger = environmentDanger({ oxygenLevel: this.bot.oxygenLevel,
      feet: this.bot.blockAt(p), head: this.bot.blockAt(p.offset(0, 1, 0)), below: this.bot.blockAt(p.offset(0, -1, 0)) });
    if (danger && task.request.action !== "retreat") throw new Error(`环境危险：${danger}`);
  }

  safePosition(position) {
    const p = position.floored();
    const usable = (p) => {
      const blocks = [this.bot.blockAt(p), this.bot.blockAt(p.offset(0, 1, 0)), this.bot.blockAt(p.offset(0, -1, 0))];
      return blocks[0]?.boundingBox === "empty" && blocks[1]?.boundingBox === "empty" && blocks[2]?.boundingBox === "block" &&
        blocks.every((block) => !["water", "lava", "farmland"].includes(block.name) && !HAZARDOUS_BLOCKS.has(block.name));
    };
    return usable(p) && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) => usable(p.offset(x, 0, z)));
  }

  safeFood() {
    return this.bot.inventory.items().filter((item) => !UNSAFE_FOOD.has(item.name) && this.bot.registry.foodsByName?.[item.name])
      .sort((a, b) => this.bot.registry.foodsByName[b.name].foodPoints - this.bot.registry.foodsByName[a.name].foodPoints)[0];
  }

  reflex() {
    if (!this.ready) return;
    const position = this.bot.entity?.position;
    if (position && this.bot.health > 6 && this.active?.request.action !== "retreat" && this.safePosition(position) &&
      (!this.safePositions.length || position.distanceTo(this.safePositions.at(-1)) >= 3)) {
      this.safePositions.push(position.clone());
      if (this.safePositions.length > 8) this.safePositions.splice(1, 1);
    }
    if (this.active && !this.active.finished) {
      try {
        this.check(this.active);
        if (this.active.request.action === "follow") this.ownerEntity();
      } catch (error) { this.cancel(error.message); }
    }
    if (!this.autoSurvival || this.active || !position || this.bot.health <= 0 || Date.now() < Math.max(this.survivalPausedUntil, this.nextSurvivalAt)) return;
    let action;
    if (this.bot.health <= 6 && this.safePositions.some((p) => position.distanceTo(p) >= 2)) action = "retreat";
    else if (this.bot.food < 14 && this.safeFood()) action = "eat";
    if (!action) return;
    this.nextSurvivalAt = Date.now() + 15000;
    void this.execute({ id: `survival-${randomUUID()}`, action, timeoutMs: 10000 }).catch(() => {});
  }

  async execute(value) {
    const request = validateAction(value);
    if (!this.ready) throw new Error("机器人尚未出生或已断开");
    if (this.seen.has(request.id)) throw new Error("重复动作 ID；不会重放");
    if (this.active) throw new Error(this.active.finished ? "上一动作正在停止；请等待或断开重连" : "已有动作运行，请先停止");
    if (this.seen.size >= 4096) throw new Error("本次连接动作数已达上限，请重新连接");
    this.seen.add(request.id);
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const task = { request, resolve, before: this.snapshot(), startedAt: new Date().toISOString(), finished: false, progress: { dug: 0, transferred: 0 } };
    this.active = task;
    task.timer = setTimeout(() => this.cancel("动作超时；已停止控制，不会自动重试", "timed_out"), request.timeoutMs);
    try {
      this.check(task);
      if (request.action === "follow") {
        const entity = this.ownerEntity();
        this.bot.pathfinder.setGoal(new this.goals.GoalFollow(entity, 2), true);
        const result = { id: request.id, action: "follow", status: "active", startedAt: task.startedAt, timeoutMs: request.timeoutMs };
        this.onResult(result);
        return result;
      }
    } catch (error) {
      this.finish(task, "failed", error.message);
      this.active = null;
      return promise;
    }
    // Do not await here: cancellation settles the request before a stuck library call returns.
    this.run(task).then(() => this.finish(task, "completed"), (error) => {
      const inventory = counts(this.bot.inventory.items());
      const changed = task.progress.dug > 0 || task.progress.transferred > 0 || task.progress.pickedStacks > 0 || task.progress.changed > 0 ||
        [...new Set([...Object.keys(inventory), ...Object.keys(task.before.inventory)])]
          .some((name) => (inventory[name] || 0) !== (task.before.inventory[name] || 0));
      this.finish(task, changed ? "partial" : "failed", error.message);
    }).finally(() => { if (this.active === task) this.active = null; });
    return promise;
  }

  ownerEntity() {
    const entity = this.bot.players[this.owner]?.entity;
    if (!entity) throw new Error("主人不在可见范围内");
    return entity;
  }

  async near(position, distance, task) {
    this.check(task);
    await this.bot.pathfinder.goto(new this.goals.GoalNear(position.x, position.y, position.z, distance));
    this.check(task);
    if (this.bot.entity.position.distanceTo(position) > distance + 0.5) throw new Error("寻路已返回，但位置未达到目标");
  }

  safeBlock(block, minimumY) {
    if (!block || block.position.y < minimumY || block.position.y < this.bot.entity.position.y - 1) return false;
    const p = this.bot.entity.position.floored();
    if (block.position.x === p.x && block.position.z === p.z && block.position.y <= p.y) return false;
    const above = this.bot.blockAt(block.position.offset(0, 1, 0));
    if (!above || above.boundingBox !== "empty") return false;
    return offsets.every(([x, y, z]) => {
      const neighbor = this.bot.blockAt(block.position.offset(x, y, z));
      return neighbor && !["water", "lava", "sand", "red_sand", "gravel"].includes(neighbor.name) && !HAZARDOUS_BLOCKS.has(neighbor.name);
    });
  }

  async waitFor(test, task) {
    const deadline = Date.now() + 2500;
    do {
      this.check(task);
      if (test()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new Error("服务器状态未确认预期结果");
  }

  async run(task) {
    const bot = this.bot;
    const { action, material, count } = task.request;
    if (COMMON_ACTIONS.has(action)) return runCommon(this, task);
    if (action === "retreat") {
      const route = [...this.safePositions].reverse().filter((p) => bot.entity.position.distanceTo(p) > 1);
      if (!route.length) throw new Error("没有可返回的已确认安全点");
      for (const target of route) {
        if (!this.safePosition(target)) throw new Error("安全点的地形已改变，停止撤退");
        // GoalNear rounds coordinates to block cells. Require the checkpoint's
        // cell rather than an adjacent cell, then retain the actual-distance check.
        await this.near(target, 0.5, task);
      }
      task.progress.note = "已核验撤回路线终点；未挖掘或放置方块";
      return;
    }
    if (action === "eat") {
      if (bot.food >= 20) { task.progress.note = "已经吃饱，无需消耗食物"; return; }
      const food = this.safeFood();
      if (!food) throw new Error("背包没有安全食物");
      await bot.equip(food, "hand");
      this.check(task);
      const before = bot.food;
      const inventoryBefore = counts(bot.inventory.items())[food.name] || 0;
      task.mutationIssued = true;
      await bot.consume();
      await this.waitFor(() => bot.food > before && (counts(bot.inventory.items())[food.name] || 0) < inventoryBefore, task);
      task.progress.foodGained = bot.food - before;
      task.progress.food = food.name;
      return;
    }
    if (action === "pickup") {
      task.progress.pickedStacks = 0;
      while (task.progress.pickedStacks < count) {
        this.check(task);
        const entity = Object.values(bot.entities).filter((entity) => entity.name === "item" && entity.position.distanceTo(bot.entity.position) <= 8)
          .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
        if (!entity) break;
        const before = counts(bot.inventory.items());
        task.mutationIssued = true;
        await this.near(entity.position.clone(), 0.5, task);
        await this.waitFor(() => {
          const now = counts(bot.inventory.items());
          return !bot.entities[entity.id] && Object.keys(now).some((name) => now[name] > (before[name] || 0));
        }, task);
        task.progress.pickedStacks += 1;
      }
      task.progress.note = "按掉落实体上限拾取；具体物品数量以 inventoryDelta 为准";
      return;
    }
    if (action === "come") {
      await this.near(this.ownerEntity().position.clone(), 2, task);
      if (bot.entity.position.distanceTo(this.ownerEntity().position) > 2.5) throw new Error("主人已移动，尚未到达主人身边");
      return;
    }
    if (action === "collect") {
      if (bot.game.dimension !== "overworld") throw new Error("第一阶段采集仅支持主世界");
      const names = COLLECT_MATERIALS[material];
      const ids = names.map((name) => bot.registry.blocksByName[name]?.id).filter(Number.isInteger);
      if (!ids.length) throw new Error("当前版本没有对应方块");
      const minimumY = Math.floor(bot.entity.position.y) - 1;
      const skipped = new Set();
      while (task.progress.dug < count) {
        this.check(task);
        const positions = bot.findBlocks({ matching: ids, maxDistance: 24, count: 48 });
        const position = positions.find((p) => !skipped.has(p.toString()) && this.safeBlock(bot.blockAt(p), minimumY));
        if (!position) throw new Error("附近没有可安全采集的表面方块");
        skipped.add(position.toString());
        await this.near(position, 2, task);
        const block = bot.blockAt(position);
        if (!block || !ids.includes(block.type) || !this.safeBlock(block, minimumY)) continue;
        if (!bot.canDigBlock(block)) throw new Error("无法挖掘目标方块");
        if (block.harvestTools) {
          const tool = selectUsableTool(bot.inventory.items(), block.harvestTools);
          if (!tool) throw new Error("缺少可用工具或工具耐久不足");
          await bot.equip(tool, "hand");
          this.check(task);
          if (!block.canHarvest(tool.type)) throw new Error("工具不能正确采集目标");
        }
        this.check(task);
        task.mutationIssued = true;
        const originalType = block.type;
        await bot.dig(block);
        await this.waitFor(() => { const current = bot.blockAt(position); return current && current.type !== originalType; }, task);
        task.progress.dug += 1;
      }
      task.progress.note = "已确认方块移除；入包数量以 inventoryDelta 为准";
      return;
    }
    if (action === "craft") {
      const candidates = material === "木板" ? Object.keys(bot.registry.itemsByName).filter((name) => name.endsWith("_planks")) : [CRAFT_ALIASES[material] || material];
      let table = null;
      const findRecipe = () => candidates.map((name) => {
        const item = bot.registry.itemsByName[name];
        return item && { name, recipe: bot.recipesFor(item.id, null, 1, table)[0] };
      }).find((entry) => entry?.recipe);
      let selected = findRecipe();
      if (!selected) {
        const id = bot.registry.blocksByName.crafting_table?.id;
        table = id === undefined ? null : bot.findBlock({ matching: id, maxDistance: 16 });
        if (table) { await this.near(table.position, 3, task); selected = findRecipe(); }
      }
      if (!selected) throw new Error("材料不足，或缺少附近的工作台");
      const before = counts(bot.inventory.items())[selected.name] || 0;
      const times = Math.ceil(count / (selected.recipe.result?.count || 1));
      this.check(task);
      task.mutationIssued = true;
      await bot.craft(selected.recipe, times, table);
      await this.waitFor(() => (counts(bot.inventory.items())[selected.name] || 0) >= before + count, task);
      return;
    }
    if (action === "give") {
      const names = MATERIAL_ALIASES[material] || [CRAFT_ALIASES[material] || material];
      const owner = this.ownerEntity();
      if (bot.entity.position.distanceTo(owner.position) > 3) throw new Error("请让主人站在三格内");
      for (const item of bot.inventory.items().filter((item) => names.includes(item.name))) {
        this.check(task);
        if (bot.entity.position.distanceTo(this.ownerEntity().position) > 3) throw new Error("主人已离开交付范围");
        const amount = Math.min(count - task.progress.transferred, transferableCount({ available: item.count,
          totalEscapeBlocks: escapeBlockCount(bot.inventory.items()), reserveLimited: ESCAPE_BLOCKS.includes(item.name) }));
        if (amount <= 0) continue;
        const before = counts(bot.inventory.items())[item.name] || 0;
        task.mutationIssued = true;
        await bot.toss(item.type, item.metadata, amount);
        await this.waitFor(() => (counts(bot.inventory.items())[item.name] || 0) <= before - amount, task);
        task.progress.transferred += amount;
        if (task.progress.transferred >= count) break;
      }
      task.progress.note = "仅确认从背包投出；未确认主人拾取";
      if (task.progress.transferred < count) throw new Error("物品不足或需保留三块逃生材料");
      return;
    }
    throw new Error("不支持的动作");
  }
}

module.exports = { MinecraftBody, validateAction };
