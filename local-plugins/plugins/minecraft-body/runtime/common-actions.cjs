"use strict";
const { CRAFT_ALIASES, MATERIAL_ALIASES } = require("./legacy/commands.cjs");
const { ESCAPE_BLOCKS, escapeBlockCount, transferableCount } = require("./legacy/safety.cjs");
const { durabilityRemaining, MIN_TOOL_DURABILITY, toolTier } = require("./legacy/tools.cjs");
const { HAZARDOUS_BLOCKS } = require("./legacy/environment.cjs");

const COMMON_ACTIONS = new Set(["goto", "set_home", "home", "look", "equip", "equip_armor", "equip_shield", "place",
  "bind_chest", "list_chest", "deposit", "withdraw", "bind_bed", "sleep", "wake", "door", "till", "plant", "harvest", "smelt", "defend", "escape"]);
const COUNT_ACTIONS = new Set(["deposit", "withdraw", "till", "plant", "harvest", "smelt"]);
const ITEM_ACTIONS = new Set(["equip", "place", "deposit", "withdraw", "plant", "harvest", "smelt"]);
const CROPS = Object.freeze({
  "小麦": { seed: "wheat_seeds", block: "wheat", age: 7 },
  "胡萝卜": { seed: "carrot", block: "carrots", age: 7 },
  "马铃薯": { seed: "potato", block: "potatoes", age: 7 },
  "甜菜": { seed: "beetroot_seeds", block: "beetroots", age: 3 },
});
const SMELTS = Object.freeze({
  "铁": { input: "raw_iron", output: "iron_ingot" }, "铜": { input: "raw_copper", output: "copper_ingot" },
  "金": { input: "raw_gold", output: "gold_ingot" }, "玻璃": { input: "sand", output: "glass" },
  "石头": { input: "cobblestone", output: "stone" }, "牛肉": { input: "beef", output: "cooked_beef" },
  "猪肉": { input: "porkchop", output: "cooked_porkchop" }, "鸡肉": { input: "chicken", output: "cooked_chicken" },
  "羊肉": { input: "mutton", output: "cooked_mutton" }, "马铃薯": { input: "potato", output: "baked_potato" },
  "木炭": { input: "oak_log", output: "charcoal" },
});
const PLACE_ITEMS = new Set(["cobblestone", "dirt", "stone", "torch", "crafting_table", "furnace", "chest",
  "oak_planks", "birch_planks", "spruce_planks", "jungle_planks", "acacia_planks", "dark_oak_planks", "mangrove_planks", "cherry_planks", "pale_oak_planks"]);
const HOSTILES = new Set(["zombie", "husk", "drowned", "skeleton", "stray", "bogged", "spider", "cave_spider", "silverfish", "endermite", "slime", "magma_cube", "pillager", "vindicator"]);
const itemNames = (material) => MATERIAL_ALIASES[material] || [CRAFT_ALIASES[material] || material];
const total = (items, names) => items.filter((item) => item && names.includes(item.name)).reduce((n, item) => n + item.count, 0);
const containerItems = (window) => window.slots.slice(0, window.inventoryStart).filter(Boolean);
const playerItems = (window) => window.slots.slice(window.inventoryStart, window.inventoryEnd).filter(Boolean);
const equipment = [["head", "helmet", 5], ["torso", "chestplate", 6], ["legs", "leggings", 7], ["feet", "boots", 8]];
const armorRank = (name) => ({ leather: 1, gold: 2, golden: 2, chainmail: 3, iron: 4, diamond: 5, netherite: 6, turtle: 3 })[name?.split("_")[0]] || 0;

async function runCommon(body, task) {
  const bot = body.bot;
  const { action, material, count, position, open } = task.request;
  const check = () => body.check(task);
  const vec = (p) => bot.entity.position.offset(p.x - bot.entity.position.x, p.y - bot.entity.position.y, p.z - bot.entity.position.z);
  const inventory = () => bot.inventory.items();
  const takeItem = (names) => inventory().find((item) => names.includes(item.name));
  const nearby = (matching, radius = 8) => bot.findBlock({ matching, maxDistance: radius });
  const namesId = (names) => names.map((name) => bot.registry.blocksByName[name]?.id).filter(Number.isInteger);
  const standClear = (p) => !Object.values(bot.entities || {}).some((entity) => entity.position &&
    Math.abs(entity.position.x - p.x - 0.5) < (entity.width || 0.6) / 2 + 0.5 &&
    Math.abs(entity.position.z - p.z - 0.5) < (entity.width || 0.6) / 2 + 0.5 &&
    entity.position.y < p.y + 1 && entity.position.y + (entity.height || 1.8) > p.y);
  const notSupporting = (p) => standClear(p.offset(0, 1, 0));
  const reach = async (block) => {
    if (bot.entity.position.offset(0, 1.5, 0).distanceTo(block.position.offset(0.5, 0.5, 0.5)) <= 4 && notSupporting(block.position)) return;
    const candidates = [];
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
      if (Math.hypot(x, z) < 1.5 || Math.hypot(x, z) > 3) continue;
      const p = block.position.offset(x + 0.5, 1, z + 0.5);
      if (body.safePosition(p) && bot.blockAt(p.floored().offset(0, -1, 0))?.name !== "farmland") candidates.push(p);
    }
    candidates.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
    if (!candidates.length) throw new Error("目标附近没有安全操作位置");
    await body.near(candidates[0], 0.5, task);
    if (bot.entity.position.offset(0, 1.5, 0).distanceTo(block.position.offset(0.5, 0.5, 0.5)) > 4 || !notSupporting(block.position)) throw new Error("目标不在安全操作距离内");
  };
  const bookmark = (name) => {
    const mark = body.session[name];
    if (!mark) throw new Error(`尚未设置${name === "home" ? "家" : name === "chest" ? "箱子" : "床"}`);
    if (mark.dimension !== bot.game.dimension) throw new Error("目标在其他维度，不能自动跨维度");
    if (bot.entity.position.distanceTo(vec(mark.position)) > 32) throw new Error("目标超出32格操作范围，请先带我靠近");
    return vec(mark.position);
  };
  const bind = (name, block) => { body.session[name] = { position: { x: block.position.x, y: block.position.y, z: block.position.z }, dimension: bot.game.dimension }; task.progress[name] = body.session[name]; };

  if (action === "set_home") {
    if (!body.safePosition(bot.entity.position)) throw new Error("当前位置不是安全家点");
    bind("home", { position: bot.entity.position.clone() }); return;
  }
  if (action === "goto" || action === "home") {
    const target = action === "home" ? bookmark("home") : vec(position);
    if (bot.entity.position.distanceTo(target) > 32 || !body.safePosition(target)) throw new Error("目标应在32格内且已加载、地面及身体空间安全");
    await body.near(target, 0.5, task); task.progress.destination = { x: target.x, y: target.y, z: target.z }; return;
  }
  if (action === "look") { await bot.lookAt(body.ownerEntity().position.offset(0, 1.5, 0)); check(); task.progress.note = "已看向主人"; return; }
  if (action === "equip" || action === "equip_shield") {
    const item = takeItem(action === "equip_shield" ? ["shield"] : itemNames(material));
    if (!item) throw new Error("背包没有对应物品");
    task.mutationIssued = true;
    const destination = action === "equip_shield" ? "off-hand" : "hand";
    await bot.equip(item, destination);
    await body.waitFor(() => (destination === "hand" ? bot.heldItem : bot.inventory.slots[45])?.type === item.type, task);
    task.progress.equipped = item.name; return;
  }
  if (action === "equip_armor") {
    task.progress.equipped = [];
    for (const [destination, suffix, slot] of equipment) {
      check();
      const item = inventory().filter((item) => item.name.endsWith(`_${suffix}`) && durabilityRemaining(item) > MIN_TOOL_DURABILITY)
        .sort((a, b) => armorRank(b.name) - armorRank(a.name) || durabilityRemaining(b) - durabilityRemaining(a))[0];
      if (!item || armorRank(item.name) <= armorRank(bot.inventory.slots[slot]?.name)) continue;
      task.mutationIssued = true; await bot.equip(item, destination);
      await body.waitFor(() => bot.inventory.slots[slot]?.type === item.type, task);
      task.progress.equipped.push(item.name);
    }
    task.progress.note = "只替换材质等级更高且耐久可用的护甲；不评价附魔"; return;
  }
  if (action === "place") {
    const item = takeItem(itemNames(material));
    if (!item || !PLACE_ITEMS.has(item.name)) throw new Error("仅支持普通建材、火把、工作台、熔炉和普通箱子");
    const target = vec(position);
    if (target.distanceTo(bot.entity.position) > 8) throw new Error("放置目标应在8格内");
    const ground = bot.blockAt(target.offset(0, -1, 0));
    if (bot.blockAt(target)?.name !== "air" || !standClear(target) || ground?.boundingBox !== "block" || HAZARDOUS_BLOCKS.has(ground.name)) throw new Error("放置格必须空闲、无实体且下方有安全支撑");
    await reach(ground);
    if (bot.blockAt(target)?.name !== "air" || !standClear(target)) throw new Error("放置位置已改变");
    await bot.equip(item, "hand"); check();
    const before = total(inventory(), [item.name]);
    task.mutationIssued = true; await bot.placeBlock(bot.blockAt(ground.position), vec({ x: 0, y: 1, z: 0 }));
    await body.waitFor(() => bot.blockAt(target)?.name === item.name && total(inventory(), [item.name]) < before, task);
    task.progress.placed = { name: item.name, position }; return;
  }
  if (action === "bind_chest" || action === "bind_bed") {
    if (action === "bind_bed" && bot.game.dimension !== "overworld") throw new Error("只允许绑定主世界床，避免床爆炸");
    const block = nearby(action === "bind_chest" ? namesId(["chest"]) : (block) => bot.isABed(block));
    if (!block) throw new Error("8格内没有对应箱子或床");
    bind(action === "bind_chest" ? "chest" : "bed", block); return;
  }
  if (["list_chest", "deposit", "withdraw"].includes(action)) {
    const p = bookmark("chest");
    if (bot.blockAt(p)?.name !== "chest") throw new Error("绑定箱子已消失或改变");
    await body.near(p, 3, task); check();
    const window = await bot.openContainer(bot.blockAt(p));
    try {
      check();
      task.progress.containerBefore = containerItems(window).map((item) => ({ name: item.name, count: item.count }));
      if (action !== "list_chest") {
        const names = itemNames(material);
        const available = action === "deposit" ? playerItems(window) : containerItems(window);
        const item = available.find((item) => names.includes(item.name));
        if (!item || item.count < count) throw new Error("指定物品的单堆数量不足");
        if (action === "deposit" && transferableCount({ available: item.count, totalEscapeBlocks: escapeBlockCount(inventory()), reserveLimited: ESCAPE_BLOCKS.includes(item.name) }) < count) throw new Error("存入后须保留三块逃生材料");
        const before = total(playerItems(window), [item.name]);
        const containerBefore = total(containerItems(window), [item.name]);
        task.mutationIssued = true;
        await window[action](item.type, item.metadata, count, item.nbt);
        const sign = action === "deposit" ? -1 : 1;
        await body.waitFor(() => {
          // Mineflayer copies the window's player slots into bot.inventory only
          // on close. Verify both sides from the active window before closing.
          task.progress.transferEvidence = { item: item.name, inventory: total(playerItems(window), [item.name]), container: total(containerItems(window), [item.name]), inventoryBefore: before, containerBefore, count };
          return task.progress.transferEvidence.inventory === before + sign * count && task.progress.transferEvidence.container === containerBefore - sign * count;
        }, task);
        task.progress.transferred = count;
      }
      task.progress.containerAfter = containerItems(window).map((item) => ({ name: item.name, count: item.count }));
    } finally { window.close(); }
    return;
  }
  if (action === "sleep") {
    if (bot.game.dimension !== "overworld") throw new Error("只允许在主世界睡觉");
    const p = bookmark("bed");
    if (!bot.isABed(bot.blockAt(p))) throw new Error("绑定床已消失");
    await body.near(p, 2, task); check(); task.mutationIssued = true;
    const bed = bot.blockAt(p), props = bed.getProperties();
    const directions = { east: [1, 0], west: [-1, 0], north: [0, -1], south: [0, 1] };
    const [x, z] = directions[props.facing] || [0, 0];
    const head = props.part === "foot" ? p.offset(x, 0, z) : p;
    await bot.sleep(bed);
    await body.waitFor(() => bot.isSleeping && bot.entity.position.floored().toString() === head.toString(), task);
    task.progress.sleeping = true; return;
  }
  if (action === "wake") {
    if (!bot.isSleeping) { task.progress.note = "已经醒着"; return; }
    task.mutationIssued = true;
    // Mineflayer 4.37.1's wake still sends numeric actionId=2. From 1.21.6,
    // the mapped packet requires leave_bed; numeric 2 means stop_sprinting.
    if (bot.supportFeature("entityActionUsesStringMapper")) bot._client.write("entity_action", { entityId: bot.entity.id, actionId: "leave_bed", jumpBoost: 0 });
    else await bot.wake();
    await body.waitFor(() => !bot.isSleeping, task); task.progress.sleeping = false; return;
  }
  if (action === "door") {
    const block = nearby((block) => block.name.endsWith("_door") && block.name !== "iron_door", 4);
    if (!block) throw new Error("4格内没有可手动开关的木门");
    await body.near(block.position, 2, task);
    if (Boolean(bot.blockAt(block.position).getProperties().open) !== open) {
      task.mutationIssued = true; await bot.activateBlock(bot.blockAt(block.position));
      await body.waitFor(() => Boolean(bot.blockAt(block.position)?.getProperties().open) === open, task);
    }
    task.progress.open = open; return;
  }
  if (["till", "plant", "harvest"].includes(action)) {
    const spec = CROPS[material];
    if (bot.game.dimension !== "overworld") throw new Error("农耕仅支持主世界");
    task.progress.changed = 0;
    const skipped = new Set();
    // Avoid stepping or jumping onto cultivated ground, including the approach.
    {
      while (task.progress.changed < count) {
        check();
        const matches = (block) => {
          if (!block || skipped.has(block.position.toString()) || !notSupporting(block.position)) return false;
          if (action === "till") {
            if (!["dirt", "grass_block", "dirt_path"].includes(block.name) || bot.blockAt(block.position.offset(0, 1, 0))?.name !== "air") return false;
            for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) if (bot.blockAt(block.position.offset(x, 0, z))?.name === "water") return true;
            return false;
          }
          if (action === "plant") return block.name === "farmland" && bot.blockAt(block.position.offset(0, 1, 0))?.name === "air";
          return block.name === spec.block && Number(block.getProperties().age) === spec.age;
        };
        // The coarse palette matcher receives blocks without positions.
        // Run position/occupancy/water checks only in the full block pass.
        const ids = namesId(action === "till" ? ["dirt", "grass_block", "dirt_path"] : action === "plant" ? ["farmland"] : [spec.block]);
        const target = bot.findBlock({ matching: ids, useExtraInfo: matches, maxDistance: 8 });
        if (!target) throw new Error("8格内没有临水空闲土地、空耕地或成熟作物");
        skipped.add(target.position.toString()); await reach(target); check();
        // Recheck after approaching: another player can change or occupy the block.
        skipped.delete(target.position.toString());
        if (!matches(bot.blockAt(target.position))) { skipped.add(target.position.toString()); continue; }
        skipped.add(target.position.toString());
        if (action === "harvest") {
          task.mutationIssued = true; await bot.dig(bot.blockAt(target.position));
          await body.waitFor(() => bot.blockAt(target.position)?.name !== spec.block, task);
        } else {
          const item = action === "till" ? inventory().find((item) => item.name.endsWith("_hoe") && durabilityRemaining(item) > MIN_TOOL_DURABILITY) : takeItem([spec.seed]);
          if (!item) throw new Error("缺少可用锄或对应种子");
          await bot.equip(item, "hand"); check();
          const before = action === "plant" ? total(inventory(), [spec.seed]) : 0;
          task.mutationIssued = true;
          if (action === "till") await bot.activateBlock(bot.blockAt(target.position), vec({ x: 0, y: 1, z: 0 }), vec({ x: 0.5, y: 1, z: 0.5 }));
          else await bot.placeBlock(bot.blockAt(target.position), vec({ x: 0, y: 1, z: 0 }));
          await body.waitFor(() => action === "till" ? bot.blockAt(target.position)?.name === "farmland" :
            bot.blockAt(target.position.offset(0, 1, 0))?.name === spec.block && total(inventory(), [spec.seed]) < before, task);
        }
        task.progress.changed++;
      }
    }
    task.progress.note = "按确认改变的地块计数；收割不自动补种，掉落物入包另看背包变化"; return;
  }
  if (action === "smelt") {
    const spec = SMELTS[material];
    const input = takeItem([spec.input]);
    const fuel = takeItem(["coal", "charcoal"]);
    if (!input || input.count < count || !fuel || fuel.count < Math.ceil(count / 8)) throw new Error("需要足量原料和煤/木炭；不会消耗木板或工具作燃料");
    const block = nearby(namesId(["furnace"]));
    if (!block) throw new Error("8格内没有普通熔炉");
    await body.near(block.position, 3, task); check();
    const furnace = await bot.openFurnace(bot.blockAt(block.position));
    let closed = false;
    try {
      check();
      if (furnace.inputItem() || furnace.fuelItem() || furnace.outputItem() || furnace.fuel > 0) throw new Error("熔炉须空闲且三槽清空，避免混用已有物品");
      const before = total(inventory(), [spec.output]);
      task.mutationIssued = true;
      await furnace.putFuel(fuel.type, fuel.metadata, Math.ceil(count / 8)); check();
      await furnace.putInput(input.type, input.metadata, count);
      while (furnace.outputItem()?.name !== spec.output || furnace.outputItem().count < count) {
        check(); await new Promise((resolve) => setTimeout(resolve, 200));
      }
      check(); await furnace.takeOutput();
      furnace.close(); closed = true;
      await body.waitFor(() => total(inventory(), [spec.output]) >= before + count, task);
      task.progress.smelted = count; task.progress.note = "仅确认取入背包的成品；停止后熔炉可继续烧炼，勿盲目重试";
    } finally { if (!closed) furnace.close(); }
    return;
  }
  if (action === "defend") {
    const target = Object.values(bot.entities).filter((entity) => HOSTILES.has(entity.name) && entity.position.distanceTo(bot.entity.position) <= 6)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
    if (!target) throw new Error("6格内没有可近身自卫的敌对生物");
    const weapon = inventory().filter((item) => item.name.endsWith("_sword") && durabilityRemaining(item) > MIN_TOOL_DURABILITY)
      .sort((a, b) => toolTier(b) - toolTier(a))[0];
    if (!weapon) throw new Error("近身自卫需要耐久足够的剑");
    await bot.equip(weapon, "hand"); check();
    const origin = bot.entity.position.clone();
    let dead = false;
    const onDeath = (entity) => { if (entity.id === target.id) dead = true; };
    bot.on("entityDead", onDeath);
    try {
      task.progress.attacks = 0;
      while (!dead) {
        check();
        const current = bot.entities[target.id];
        if (!current || current.position.distanceTo(origin) > 8) throw new Error("目标消失或离开范围，未确认击败");
        if (current.position.distanceTo(bot.entity.position) > 3) await body.near(current.position.clone(), 2, task);
        await bot.lookAt(current.position.offset(0, Math.min(current.height, 1.6), 0));
        check();
        if (dead) break;
        if (current.position.distanceTo(bot.entity.position) > 3) throw new Error("目标不在近身攻击距离");
        // A solid block between eyes and target must prevent attacking through walls.
        const eye = bot.entity.position.offset(0, bot.entity.eyeHeight, 0);
        const delta = current.position.offset(0, Math.min(current.height / 2, 1), 0).minus(eye);
        if (bot.world.raycast(eye, delta.normalize(), delta.norm())) throw new Error("攻击视线被方块遮挡");
        task.mutationIssued = true; bot.attack(current); task.progress.attacks++;
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      task.progress.defeated = target.name;
      task.progress.note = "仅确认目标死亡，不归因击杀者";
    } finally { bot.removeListener("entityDead", onDeath); }
    return;
  }
  if (action === "escape") {
    const origin = bot.entity.position.clone();
    // Only a one-block-deep pit: jump and place one solid block below the feet.
    const p = origin.floored();
    const destinations = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => p.offset(x + 0.5, 1, z + 0.5)).filter((p) => body.safePosition(p));
    if (!destinations.length || !standClear(p.offset(0, 2, 0))) throw new Error("仅支持头顶空闲、有安全出口的一格浅坑");
    const item = takeItem(ESCAPE_BLOCKS);
    if (!item) throw new Error("背包没有可垫脚的普通方块");
    const below = bot.blockAt(p.offset(0, -1, 0));
    if (below?.boundingBox !== "block" || HAZARDOUS_BLOCKS.has(below.name) || bot.blockAt(p)?.name !== "air" || bot.blockAt(p.offset(0, 1, 0))?.name !== "air" || bot.blockAt(p.offset(0, 2, 0))?.name !== "air") throw new Error("浅坑地面或头顶不安全");
    await bot.equip(item, "hand"); check();
    const before = total(inventory(), [item.name]);
    // Finish turning before jumping: an awaited look during placeBlock can
    // outlast the jump and make the server reject placement inside our feet.
    await bot.lookAt(below.position.offset(0.5, 1, 0.5)); check();
    task.mutationIssued = true; bot.setControlState("jump", true);
    try {
      await body.waitFor(() => bot.entity.position.y >= p.y + 1, task);
      await bot.waitForTicks(1); check();
      if (bot.entity.position.y < p.y + 1) throw new Error("起跳高度已不足，未放置垫脚方块");
      await bot.placeBlock(below, vec({ x: 0, y: 1, z: 0 }));
      await body.waitFor(() => bot.blockAt(p)?.name === item.name && total(inventory(), [item.name]) < before, task);
    } finally { bot.setControlState("jump", false); }
    await body.waitFor(() => bot.entity.onGround && Math.abs(bot.entity.position.y - p.y - 1) < 0.15, task);
    if (!body.safePosition(destinations[0])) throw new Error("浅坑出口地形已改变");
    await body.near(destinations[0], 0.5, task);
    task.progress.usedBlock = item.name;
    task.progress.note = "已放置一块垫脚并到达浅坑安全出口"; return;
  }
  throw new Error("不支持的日常动作");
}

module.exports = { runCommon, COMMON_ACTIONS, COUNT_ACTIONS, ITEM_ACTIONS, CROPS, SMELTS, PLACE_ITEMS };
