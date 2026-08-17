"use strict";

const fs = require("node:fs");
const path = require("node:path");
const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const { Vec3 } = require("vec3");
const { CRAFT_ALIASES, MATERIAL_ALIASES, parseCommand } = require("./commands.cjs");
const { ESCAPE_BLOCKS, ESCAPE_RESERVE, countMatching, escapeBlockCount: countEscapeBlocks, transferableCount } = require("./safety.cjs");
const { MIN_TOOL_DURABILITY, durabilityRemaining, selectUsableTool } = require("./tools.cjs");
const { cropSpec, isEmptyFarmland, isMatureCrop } = require("./crops.cjs");
const { ORE_ALIASES, hasExposedFace, tunnelSliceIssue } = require("./mining.cjs");
const { ARMOR_SLOTS, bestArmor, bestWeapon, isHostile, threatResponse } = require("./combat.cjs");
const { shelterTargets } = require("./building.cjs");
const { breedSpec } = require("./animals.cjs");
const { environmentDanger } = require("./environment.cjs");
const { bedPlacementCandidates, isBedPlacementSafe } = require("./bed.cjs");
const { needsTorch } = require("./lighting.cjs");
const { isBoatEntity, reconcileOwnVehicle, waitForVehicleState } = require("./boat.cjs");
const { acceptAppearance, refreshAppearance, skinVersion } = require("./appearance.cjs");
const { currentWindowSlot, customNameText, playerWindowItemCount, playerWindowItems } = require("./windows.cjs");
const { requestPlan } = require("./llm-planner.cjs");
const { ALLOWED_ACTIONS, createExecutionReport, createTaskBrief, isFailedActionResult, normalizeReadOnlyTaskBrief, shouldReplyAtActionStart, shouldReportSuccess } = require("./llm-contracts.cjs");
const { chooseAutonomousTask, composeActionStartReply, composeSoulReply, createSoulTaskBrief, summarizeGameConversation } = require("./soul-orchestrator.cjs");
const { AUTONOMY_DELAYS, allowedActions, autonomousActionIssue, canStartAutonomous, nextDelayIndex, worldChangeFingerprint } = require("./autonomy.cjs");
const { startThirdPersonViewer } = require("./viewer-service.cjs");
const { createChatOutput } = require("./chat-output.cjs");
const { commandFeedbackContext, isPlayerCommandFeedback } = require("./chat-source.cjs");

const SEARCH_RADIUS = 24;
const DANGER_HEALTH = 8;
const FARM_REACH = 4.25;
const COLLECT_BLOCK_ALIASES = Object.freeze({
  ...MATERIAL_ALIASES,
  // Normal grassy terrain is grass_block but drops dirt without Silk Touch.
  "泥土": ["dirt", "grass_block"],
});
let bot = null;
let chatOutput = null;
let stopping = false;
let startedAt = 0;
let spawnedAt = 0;
let settings = null;
let reconnects = 0;
let eating = false;
let dangerRetreating = false;
let defending = true;
let combatBusy = false;
let shieldRaised = false;
let shieldRaisedAt = 0;
let lastDefenseAt = 0;
let fleeingUntil = 0;
let lastEnvironmentEscapeAt = 0;
let armorRefreshTimer = null;
let autoSleepBusy = false;
let lastAutoSleepAttemptAt = 0;
let autoLightingBusy = false;
let lastAutoLightAt = 0;
let lastDeathPosition = null;
let safeRoute = [];
let taskSerial = 0;
let activeTask = null;
let llmBusy = false;
let llmSerial = 0;
let lastBotChat = "";
let currentLlmTask = null;
let autonomousLlmActive = false;
const pendingSoulContexts = new Map();
const pendingVision = new Map();
const players = new Set();
const highlights = [];
const gameConversation = [];
let gameConversationSummary = "";
let summaryRefreshBusy = false;
let lastSummaryTurnCount = 0;
let viewerService = null;
let autonomyTimer = null;
let lastUserAt = Date.now();
let lastAutonomyAt = Date.now();
let autonomyDelayIndex = 0;
let lastAutonomyFingerprint = "";
let gamebotAppearance = { skinVersion: "unknown", description: "" };
const AIR_BLOCKS = new Set(["air", "cave_air", "void_air"]);

const send = (payload) => process.send?.(payload);
const progress = (message) => send({ type: "progress", message });

function sendModelReply(message) {
  const sent = chatOutput?.model(message) || false;
  if (sent) progress(`Minecraft 模型回复：${String(message).trim()}`);
  return sent;
}

function remember(text) {
  if (highlights.length < 80) highlights.push(text.slice(0, 240));
}

function recordGameChat(role, name, content) {
  const text = String(content || "").replace(/\s+/g, " ").trim().slice(0, 600);
  if (!text) return;
  gameConversation.push({ role, name: String(name || "").slice(0, 32), content: text, at: Date.now() });
  if (gameConversation.length > 80) gameConversation.splice(0, gameConversation.length - 80);
  void refreshGameConversationSummary();
}

async function refreshGameConversationSummary() {
  if (summaryRefreshBusy || !settings?.soul?.enabled) return;
  const pending = gameConversation.length - lastSummaryTurnCount;
  const pendingChars = gameConversation.slice(lastSummaryTurnCount).reduce((total, turn) => total + turn.content.length, 0);
  if (pending < 20 && pendingChars < 5_000) return;
  summaryRefreshBusy = true;
  try {
    const cutoff = Math.max(0, gameConversation.length - 12);
    gameConversationSummary = await summarizeGameConversation(
      settings.soul,
      gameConversationSummary,
      gameConversation.slice(lastSummaryTurnCount, cutoff),
    );
    lastSummaryTurnCount = cutoff;
  } catch (error) {
    progress(`Minecraft 聊天滚动摘要暂时失败，保留近期原文：${errorMessage(error)}`);
  } finally {
    summaryRefreshBusy = false;
  }
}

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  const unsupported = message.match(/No data available for version\s+(.+)/i);
  return unsupported
    ? `当前 Mineflayer 暂不支持 Minecraft ${unsupported[1]}。请改用受支持的服务器版本，或配置协议转换代理。`
    : message;
}

function isAirBlock(block) {
  return AIR_BLOCKS.has(block?.name);
}

function ownerEntity() {
  return settings?.owner ? bot?.players?.[settings.owner]?.entity : null;
}

function compactWorldState() {
  const currentSkinVersion = skinVersion(bot.players?.[bot.username]);
  gamebotAppearance = refreshAppearance(gamebotAppearance, currentSkinVersion);
  const inventory = bot.inventory.items().slice(0, 18).map((item) => ({ name: item.name, count: item.count }));
  const nearbyBlocks = bot.findBlocks({ matching: () => true, maxDistance: 12, count: 512 })
    .map((position) => bot.blockAt(position)?.name)
    .filter(Boolean);
  const blockCounts = Object.entries(nearbyBlocks.reduce((counts, name) => {
    counts[name] = (counts[name] || 0) + 1;
    return counts;
  }, {})).sort((left, right) => right[1] - left[1]).slice(0, 20);
  const nearbyEntities = Object.values(bot.entities)
    .filter((entity) => entity !== bot.entity && entity.position?.distanceTo(bot.entity.position) <= 16)
    .slice(0, 16)
    .map((entity) => ({
      name: entity.name,
      username: entity.username || null,
      distance: Math.round(entity.position.distanceTo(bot.entity.position)),
      isOwner: Boolean(settings?.owner && entity.username === settings.owner),
    }));
  const owner = ownerEntity();
  return {
    cameraPerspective: "third_person_behind_gamebot",
    cameraSubject: { role: "gamebot", username: bot.username },
    gamebotAppearance: { skinVersion: currentSkinVersion, description: gamebotAppearance.description || null },
    // position 是 bot 自身坐标；user.position 供模型区分“你在这里/用户在那里”，
    // 避免把 bot 坐标误当作“用户那边”复述或设点。
    user: { username: settings?.owner || null, visible: Boolean(owner), position: positionSnapshot(owner?.position) },
    health: Math.round(bot.health),
    food: Math.round(bot.food),
    oxygen: bot.oxygenLevel,
    position: positionSnapshot(bot.entity.position),
    dimension: bot.game?.dimension || "overworld",
    time: bot.time?.timeOfDay,
    weather: bot.isRaining ? "rain" : "clear",
    activeTask: activeTask?.name || null,
    heldItem: bot.heldItem?.name || null,
    inventory,
    nearbyBlocks: blockCounts,
    nearbyEntities,
    hasHome: Boolean(homePosition()),
    hasBoundChest: Boolean(boundChestPosition()),
    hasBoundBed: Boolean(boundBedPosition()),
  };
}

function requestVisionObservation(focus = "") {
  if (!settings?.autonomy?.visionEnabled || !viewerService) return Promise.resolve(null);
  const requestId = `vision-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pendingVision.delete(requestId); resolve(null); }, 45_000);
    pendingVision.set(requestId, (observation) => { clearTimeout(timer); resolve(observation); });
    send({ type: "vision_request", requestId, structuredWorld: compactWorldState(), focus: String(focus).slice(0, 600) });
  });
}

async function runAutonomyCycle() {
  const mode = settings?.autonomy?.mode || "passive";
  const world = bot ? compactWorldState() : null;
  const fingerprint = world ? worldChangeFingerprint(world) : "";
  const lowChange = Boolean(lastAutonomyFingerprint && lastAutonomyFingerprint === fingerprint);
  if (lastAutonomyFingerprint && !lowChange) autonomyDelayIndex = 0;
  if (!canStartAutonomous({
    mode, stopping, llmBusy, activeTask,
    danger: dangerRetreating || combatBusy || bot?.health <= DANGER_HEALTH,
    dimension: bot?.game?.dimension,
    lastUserAt, lastRunAt: lastAutonomyAt, runCooldownMs: AUTONOMY_DELAYS[autonomyDelayIndex],
  })) return;
  if (!settings?.soul?.enabled || !settings?.llm?.enabled) return;
  lastAutonomyAt = Date.now();
  try {
    const vision = await requestVisionObservation();
    if (settings?.autonomy?.mode !== mode || Date.now() - lastUserAt < 20_000 || activeTask || llmBusy) return;
    const context = await requestSoulContext(`Minecraft ${mode} 模式自主观察`);
    if (settings?.autonomy?.mode !== mode) return;
    const brief = await chooseAutonomousTask(settings.soul, {
      mode, world, vision, allowedActions: allowedActions(mode),
    }, context, settings.llm.maxSteps);
    lastAutonomyFingerprint = fingerprint;
    if (settings?.autonomy?.mode !== mode) return;
    if (!brief) {
      autonomyDelayIndex = nextDelayIndex(autonomyDelayIndex, lowChange);
      return;
    }
    autonomyDelayIndex = 0;
    if (Date.now() - lastUserAt < 20_000 || activeTask || llmBusy) return;
    progress(`Minecraft 自主目标：${brief.request}`);
    remember(`自主选择目标：${brief.request}`);
    await runLlmTask(brief, { autonomous: true, soulContext: context });
  } catch (error) {
    progress(`Minecraft 自主观察暂时停止，本轮不行动：${errorMessage(error)}`);
  }
}

function startAutonomyLoop() {
  if (autonomyTimer) clearInterval(autonomyTimer);
  if ((settings?.autonomy?.mode || "passive") === "passive") return;
  autonomyTimer = setInterval(() => { void runAutonomyCycle(); }, 15_000);
  autonomyTimer.unref?.();
}

function updateAutonomy(next) {
  const mode = ["passive", "companion", "survival"].includes(next?.mode) ? next.mode : settings?.autonomy?.mode || "passive";
  const previous = settings?.autonomy?.mode || "passive";
  settings.autonomy = { ...settings.autonomy, mode };
  lastUserAt = Date.now();
  lastAutonomyAt = Date.now();
  autonomyDelayIndex = 0;
  lastAutonomyFingerprint = "";
  if (autonomousLlmActive && (mode === "passive" || mode !== previous)) {
    llmSerial += 1;
    llmBusy = false;
    autonomousLlmActive = false;
    currentLlmTask = null;
    cancelTask();
  }
  startAutonomyLoop();
  progress(`Minecraft 自主模式已切换为：${mode === "passive" ? "被动" : mode === "companion" ? "陪伴" : "生存"}`);
}

// 降级/无 Soul 路径：执行模型直接理解，许可集=全局 ALLOWED_ACTIONS。
// 必须在创建后赋全量：经 options 传会被 normalizeAllowedActions 截成前 10 项画错沙箱；
// 空集又是“纯聊天”语义，同样不能用。
function unconstrainedTaskBrief(request, maxSteps) {
  const brief = createTaskBrief(request, maxSteps);
  brief.constraints.allowedActions = [...ALLOWED_ACTIONS];
  return brief;
}

async function waitForBotResult(timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (!lastBotChat && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  return lastBotChat;
}

// 门感知：开着的门仍带薄碰撞形状，pathfinder 默认（boundingBox 非 empty）视其不可通行，
// 导致 bot 走不出已敞开的门。这里在 Movements 实例上把“开着的门”标记为可通行。
function makeMovementsDoorAware(movements) {
  const baseGetBlock = movements.getBlock.bind(movements);
  movements.getBlock = (pos, dx, dy, dz) => {
    const block = baseGetBlock(pos, dx, dy, dz);
    if (block && !block.safe && typeof block.name === "string" && block.name.endsWith("_door")
      && Boolean(block.getProperties?.().open)) {
      block.safe = true;
      block.physical = false;
    }
    return block;
  };
  return movements;
}

// 路线被关着的门挡住时自助开门：打开可达范围（4 格）内最多两扇关着的门，返回打开数量。
async function openNearbyClosedDoors() {
  let opened = 0;
  for (let pass = 0; pass < 2; pass += 1) {
    const door = bot.findBlock({
      matching: (block) => Boolean(block?.name?.endsWith("_door")) && !block.getProperties?.().open,
      maxDistance: 4,
    });
    if (!door) break;
    try {
      await bot.activateBlock(door);
      await bot.waitForTicks(2);
      opened += 1;
    } catch { break; }
  }
  return opened;
}

function setSafeMovements(restrictDrops = false) {
  const movements = new Movements(bot);
  // Movement may never modify the world. Mining is only allowed through an explicit, counted collect action.
  movements.canDig = false;
  movements.allow1by1towers = false;
  if (restrictDrops) movements.maxDropDown = 0;
  bot.pathfinder.setMovements(makeMovementsDoorAware(movements));
}

function setFarmMovements() {
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.allow1by1towers = false;
  movements.allowParkour = false;
  movements.maxDropDown = 0;
  bot.pathfinder.setMovements(makeMovementsDoorAware(movements));
  bot.setControlState("jump", false);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(settings.stateFile, "utf8"));
  } catch {
    return { homes: {} };
  }
}

function stateKey() {
  return `${settings.host}:${settings.port}/${settings.owner}`;
}

function homePosition() {
  const homes = loadState().homes || {};
  const exact = homes[stateKey()];
  if (exact) return exact;
  // 本机/内网服重启常换端口，精确 key 失配时回退同 host+owner 的唯一记录，
  // 避免“家点明明设过却因端口变化而丢失”；多条候选时宁可不回退。
  const [hostPort, owner] = stateKey().split("/");
  const host = hostPort.split(":")[0];
  const candidates = Object.entries(homes)
    .filter(([key]) => {
      const [keyHostPort, keyOwner] = key.split("/");
      return keyOwner === owner && keyHostPort.split(":")[0] === host;
    })
    .map(([, home]) => home);
  return candidates.length === 1 ? candidates[0] : null;
}

function positionSnapshot(position) {
  return position ? { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) } : null;
}

function isSafeCheckpointPosition(position) {
  if (!bot || !position) return false;
  const feet = position.floored();
  const floor = bot.blockAt(feet.offset(0, -1, 0));
  const body = bot.blockAt(feet);
  const head = bot.blockAt(feet.offset(0, 1, 0));
  if (floor?.boundingBox !== "block" || body?.boundingBox !== "empty" || head?.boundingBox !== "empty") return false;
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => {
    const neighborFloor = bot.blockAt(feet.offset(dx, -1, dz));
    const neighborBody = bot.blockAt(feet.offset(dx, 0, dz));
    const neighborHead = bot.blockAt(feet.offset(dx, 1, dz));
    return neighborFloor?.boundingBox === "block"
      && neighborBody?.boundingBox === "empty"
      && neighborHead?.boundingBox === "empty";
  });
}

function rememberSafeCheckpoint() {
  if (!isSafeCheckpointPosition(bot?.entity?.position)) return;
  const point = positionSnapshot(bot.entity.position);
  const previous = safeRoute.at(-1);
  if (previous && Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z) < 3) return;
  safeRoute.push(point);
  if (safeRoute.length > 12) safeRoute.splice(1, 1);
}

function resetSafeRoute() {
  safeRoute = [];
  rememberSafeCheckpoint();
}

function appendRoutePoint(position) {
  const point = positionSnapshot(position);
  const previous = safeRoute.at(-1);
  if (!point || (previous && point.x === previous.x && point.y === previous.y && point.z === previous.z)) return;
  safeRoute.push(point);
  if (safeRoute.length > 12) safeRoute.splice(1, 1);
}

function saveHome(position) {
  const state = loadState();
  state.homes ||= {};
  state.homes[stateKey()] = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
  fs.mkdirSync(path.dirname(settings.stateFile), { recursive: true });
  fs.writeFileSync(settings.stateFile, JSON.stringify(state, null, 2), "utf8");
}

function boundChestPosition() {
  return loadState().chests?.[stateKey()] || null;
}

function saveBoundChest(position) {
  const state = loadState();
  state.chests ||= {};
  state.chests[stateKey()] = positionSnapshot(position);
  fs.mkdirSync(path.dirname(settings.stateFile), { recursive: true });
  fs.writeFileSync(settings.stateFile, JSON.stringify(state, null, 2), "utf8");
}

function boundBedPosition() {
  return loadState().beds?.[stateKey()] || null;
}

function saveBoundBed(position) {
  const state = loadState();
  state.beds ||= {};
  state.beds[stateKey()] = positionSnapshot(position);
  fs.mkdirSync(path.dirname(settings.stateFile), { recursive: true });
  fs.writeFileSync(settings.stateFile, JSON.stringify(state, null, 2), "utf8");
}

function cancelTask() {
  taskSerial += 1;
  activeTask = null;
  bot?.pathfinder?.setGoal(null);
  bot?.stopDigging?.();
  bot?.clearControlStates?.();
  if (bot?.usingHeldItem) bot.deactivateItem();
  shieldRaised = false;
  shieldRaisedAt = 0;
  fleeingUntil = 0;
}

function beginTask(name, options = {}) {
  cancelTask();
  const task = { id: taskSerial, name, allowLowHealth: Boolean(options.allowLowHealth) };
  activeTask = task;
  return task;
}

function assertTask(task) {
  if (activeTask !== task) throw new Error("任务已停止");
  if (bot.game?.dimension && bot.game.dimension !== "overworld") throw new Error("现阶段只在主世界行动");
  if (!task.allowLowHealth && bot.health <= DANGER_HEALTH) throw new Error("生命值过低，等恢复后再执行这个任务吧");
}

async function goNear(position, range, task) {
  assertTask(task);
  const goal = new goals.GoalNear(position.x, position.y, position.z, range);
  try {
    await bot.pathfinder.goto(goal);
  } catch (error) {
    // 路线被关着的门挡住时，自助开门后重规划一次。
    if (await openNearbyClosedDoors() > 0) await bot.pathfinder.goto(goal);
    else throw error;
  }
  assertTask(task);
}

function registryNames(material) {
  return MATERIAL_ALIASES[material] || null;
}

function isSupportingEntity(block, entity) {
  if (!entity) return false;
  const dx = block.position.x + 0.5 - entity.position.x;
  const dz = block.position.z + 0.5 - entity.position.z;
  const horizontallyClose = Math.hypot(dx, dz) < 1.35;
  const atOrBelowFeet = block.position.y + 1 <= entity.position.y + 0.2;
  return horizontallyClose && atOrBelowFeet;
}

function isSafeToDig(block) {
  return Boolean(block)
    && !isSupportingEntity(block, bot.entity)
    && !isSupportingEntity(block, ownerEntity());
}

function isExposedSurface(block, minimumY) {
  if (!block || block.position.y < minimumY) return false;
  const above = bot.blockAt(block.position.offset(0, 1, 0));
  return Boolean(above && above.boundingBox === "empty");
}

function safeCollectBlock(ids, skipped, minimumY) {
  const positions = bot.findBlocks({ matching: ids, maxDistance: SEARCH_RADIUS, count: 48 });
  for (const position of positions) {
    const key = `${position.x},${position.y},${position.z}`;
    if (skipped.has(key)) continue;
    const block = bot.blockAt(position);
    if (isSafeToDig(block) && isExposedSurface(block, minimumY)) return block;
    skipped.add(key);
  }
  return null;
}

async function confirmBlockRemoved(position, originalType, task) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    assertTask(task);
    const current = bot.blockAt(position);
    if (current && current.type !== originalType) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function equipHarvestTool(block) {
  if (!block.harvestTools) return null;
  const tool = selectUsableTool(bot.inventory.items(), block.harvestTools);
  if (!tool) throw new Error(`缺少可用工具，或合适工具的剩余耐久不高于 ${MIN_TOOL_DURABILITY}`);
  await bot.equip(tool, "hand");
  if (!block.canHarvest(tool.type)) throw new Error("当前工具不能正确采集这个方块");
  return tool;
}

async function eatIfNeeded(force = false) {
  if (!bot || eating || (!force && bot.food >= 14)) return false;
  if (bot.food >= 20) {
    if (force) bot.chat("现在已经吃饱了。");
    return false;
  }
  const food = bot.inventory.items()
    .filter((item) => bot.registry.foodsByName[item.name])
    .sort((a, b) => bot.registry.foodsByName[b.name].foodPoints - bot.registry.foodsByName[a.name].foodPoints)[0];
  if (!food) {
    if (force) bot.chat("背包里没有可吃的食物。");
    return false;
  }
  eating = true;
  try {
    await bot.equip(food, "hand");
    await bot.consume();
    progress(`自动进食：${food.displayName}`);
    remember(`饥饿时吃了 ${food.displayName}`);
    if (force) bot.chat(`吃了 ${food.displayName}。`);
    return true;
  } catch (error) {
    progress(`自动进食失败：${errorMessage(error)}`);
  } finally {
    eating = false;
  }
  return false;
}

async function collectMaterial(material, count) {
  const blockNames = COLLECT_BLOCK_ALIASES[material] || null;
  if (!blockNames) return bot.chat("这个材料暂不在安全采集清单里。可以采集木头、原木、石头、圆石、泥土或沙子。");
  const ids = blockNames.map((name) => bot.registry.blocksByName[name]?.id).filter(Number.isInteger);
  if (!ids.length) return bot.chat("当前服务器版本里找不到这种方块。");
  resetSafeRoute();
  const task = beginTask(`采集 ${material}`);
  setSafeMovements(true);
  const skipped = new Set();
  // Never descend into an existing hole to mine. The task only considers the surface level where it began.
  const minimumY = Math.floor(bot.entity.position.y) - 1;
  let dug = 0;
  bot.chat(`好，我去采集 ${count} 个${material}。说“停止”可以随时叫停我。`);
  try {
    while (dug < count) {
      assertTask(task);
      const block = safeCollectBlock(ids, skipped, minimumY);
      if (!block) throw new Error(`附近 ${SEARCH_RADIUS} 格内没有找到${material}`);
      await goNear(block.position, 2, task);
      rememberSafeCheckpoint();
      if (!isSafeToDig(block)) {
        skipped.add(`${block.position.x},${block.position.y},${block.position.z}`);
        continue;
      }
      if (!bot.canDigBlock(block)) throw new Error(`无法安全挖掘这块${material}`);
      await equipHarvestTool(block);
      const originalType = block.type;
      await bot.dig(block);
      if (!await confirmBlockRemoved(block.position, originalType, task)) {
        skipped.add(`${block.position.x},${block.position.y},${block.position.z}`);
        throw new Error(`未能确认这块${material}已被挖掉，任务已停止`);
      }
      dug += 1;
      await new Promise((resolve) => setTimeout(resolve, 400));
      assertTask(task);
    }
    bot.chat(`${material}已挖完；没有自动入包的掉落物可以用“捡东西”拾取。`);
    remember(`采集了 ${dug} 个${material}`);
  } catch (error) {
    if (activeTask === task) bot.chat(errorMessage(error));
  } finally {
    if (activeTask === task) {
      if (bot) setSafeMovements(false);
      activeTask = null;
    }
  }
}

const ORE_FACE_OFFSETS = Object.freeze([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]);

function exposedOreBlock(ids, skipped) {
  const positions = bot.findBlocks({ matching: ids, maxDistance: 32, count: 96 });
  for (const position of positions) {
    const key = `${position.x},${position.y},${position.z}`;
    if (skipped.has(key)) continue;
    const block = bot.blockAt(position);
    const neighbors = ORE_FACE_OFFSETS.map(([x, y, z]) => bot.blockAt(position.offset(x, y, z)));
    if (block && isSafeToDig(block) && hasExposedFace(neighbors)) return block;
    skipped.add(key);
  }
  return null;
}

async function mineExposedOre(material, count) {
  const names = ORE_ALIASES[material];
  if (!names) return bot.chat("主世界采矿支持：煤、铁、铜、金、红石、青金石、钻石和绿宝石。");
  if (escapeBlockCount() < ESCAPE_RESERVE) return bot.chat(`采矿前需要携带至少 ${ESCAPE_RESERVE} 个泥土或圆石用于紧急脱困。`);
  const ids = names.map((name) => bot.registry.blocksByName[name]?.id).filter(Number.isInteger);
  if (!ids.length) return bot.chat("当前服务器版本没有对应矿石方块。");
  resetSafeRoute();
  const task = beginTask(`采矿 ${material}`);
  const skipped = new Set();
  let mined = 0;
  setSafeMovements(false);
  bot.chat(`我只沿现有通道采集 ${count} 块暴露的${material}矿，不会盲挖墙或脚下。说“停止”或“撤退”可以叫停。`);
  try {
    while (mined < count) {
      assertTask(task);
      const ore = exposedOreBlock(ids, skipped);
      if (!ore) throw new Error(`32 格内没有找到可安全接近的暴露${material}矿`);
      await goNear(ore.position, 2, task);
      rememberSafeCheckpoint();
      const current = bot.blockAt(ore.position);
      const neighbors = ORE_FACE_OFFSETS.map(([x, y, z]) => bot.blockAt(ore.position.offset(x, y, z)));
      if (!current || !names.includes(current.name) || !isSafeToDig(current) || !hasExposedFace(neighbors)) {
        skipped.add(`${ore.position.x},${ore.position.y},${ore.position.z}`);
        continue;
      }
      if (!bot.canDigBlock(current)) throw new Error(`无法安全挖掘这块${material}矿`);
      await equipHarvestTool(current);
      const originalType = current.type;
      await bot.dig(current);
      if (!await confirmBlockRemoved(current.position, originalType, task)) throw new Error(`未能确认${material}矿已挖掉`);
      mined += 1;
      await bot.waitForTicks(4);
    }
    bot.chat(`挖完了 ${mined} 块${material}矿；掉落物可说“捡东西”拾取，需要回程可说“撤退”。`);
    remember(`沿现有通道安全采集了 ${mined} 块${material}矿`);
  } catch (error) {
    if (activeTask === task) bot.chat(`${errorMessage(error)}；已完成 ${mined}/${count} 块`);
  } finally {
    if (activeTask === task) activeTask = null;
  }
}

function cardinalFacing() {
  const yaw = bot.entity.yaw;
  const x = -Math.sin(yaw);
  const z = -Math.cos(yaw);
  return Math.abs(x) > Math.abs(z) ? new Vec3(Math.sign(x), 0, 0) : new Vec3(0, 0, Math.sign(z));
}

function tunnelNeighbors(position) {
  return [
    position.offset(1, 0, 0), position.offset(-1, 0, 0), position.offset(0, 0, 1), position.offset(0, 0, -1),
    position.offset(1, 1, 0), position.offset(-1, 1, 0), position.offset(0, 1, 1), position.offset(0, 1, -1),
  ].map((point) => bot.blockAt(point));
}

async function digTunnelBlock(block, task) {
  if (!block || block.boundingBox === "empty") return;
  if (!isSafeToDig(block) || !bot.canDigBlock(block)) throw new Error(`不能安全挖掘 ${block.displayName || block.name}`);
  await equipHarvestTool(block);
  const originalType = block.type;
  await bot.dig(block);
  if (!await confirmBlockRemoved(block.position, originalType, task)) throw new Error(`未能确认 ${block.displayName || block.name} 已挖除`);
}

async function digHorizontalTunnel(count) {
  const pickaxe = bot.inventory.items().find((item) => item.name.endsWith("_pickaxe") && durabilityRemaining(item) > MIN_TOOL_DURABILITY);
  if (!pickaxe) return bot.chat("安全掘进需要一把剩余耐久足够的镐。");
  if (escapeBlockCount() < ESCAPE_RESERVE) return bot.chat(`安全掘进前需要携带至少 ${ESCAPE_RESERVE} 个脱困方块。`);
  const direction = cardinalFacing();
  const task = beginTask("安全水平掘进");
  let advanced = 0;
  resetSafeRoute();
  rememberSafeCheckpoint();
  bot.chat(`我沿当前朝向水平掘进 ${count} 格；遇到液体、坠落方块、空洞或不可靠地面会立即停下。`);
  try {
    while (advanced < count) {
      assertTask(task);
      const currentFeet = bot.entity.position.floored();
      const targetFeet = currentFeet.plus(direction);
      const feet = bot.blockAt(targetFeet);
      const head = bot.blockAt(targetFeet.offset(0, 1, 0));
      const ceiling = bot.blockAt(targetFeet.offset(0, 2, 0));
      const below = bot.blockAt(targetFeet.offset(0, -1, 0));
      if (entityIntersectsBlock(targetFeet) || entityIntersectsBlock(targetFeet.offset(0, 1, 0))) throw new Error("前方通道内有玩家或生物");
      const issue = tunnelSliceIssue({ feet, head, ceiling, below, neighbors: tunnelNeighbors(targetFeet) });
      if (issue) throw new Error(issue);
      await digTunnelBlock(head, task);
      await digTunnelBlock(feet, task);
      if (bot.blockAt(targetFeet)?.boundingBox !== "empty" || bot.blockAt(targetFeet.offset(0, 1, 0))?.boundingBox !== "empty") {
        throw new Error("两格高通道没有完全打通");
      }
      await goNear(targetFeet, 0, task);
      if (bot.entity.position.distanceTo(targetFeet.offset(0.5, 0, 0.5)) > 1.25) throw new Error("未能安全进入新通道");
      appendRoutePoint(bot.entity.position);
      advanced += 1;
      await autoLightIfNeeded(true);
    }
    bot.chat(`安全掘进完成，共前进 ${advanced} 格；回程路线已经记录。`);
    remember(`安全水平掘进了 ${advanced} 格`);
  } catch (error) {
    if (activeTask === task) bot.chat(`掘进停止：${errorMessage(error)}；已前进 ${advanced}/${count} 格，可说“撤退”原路返回。`);
  } finally { if (activeTask === task) activeTask = null; }
}


async function pickUpNearby() {
  resetSafeRoute();
  const task = beginTask("拾取掉落物");
  let picked = 0;
  bot.chat("我去捡附近的掉落物。说“停止”可以叫停我。");
  try {
    while (picked < 8) {
      assertTask(task);
      const entity = bot.nearestEntity((candidate) => candidate.name === "item" && candidate.position.distanceTo(bot.entity.position) <= SEARCH_RADIUS);
      if (!entity) break;
      await goNear(entity.position, 1, task);
      const deadline = Date.now() + 1800;
      while (bot.entities[entity.id] && Date.now() < deadline) {
        assertTask(task);
        await bot.waitForTicks(1);
      }
      if (bot.entities[entity.id]) throw new Error("已经靠近掉落物，但服务器未确认拾取");
      picked += 1;
    }
    const remaining = bot.nearestEntity((candidate) => candidate.name === "item" && candidate.position.distanceTo(bot.entity.position) <= SEARCH_RADIUS);
    bot.chat(picked ? (remaining ? `已确认捡起 ${picked} 个掉落物，附近还有物品，可再次说“捡东西”。` : `已确认捡起 ${picked} 个掉落物。`) : "附近没有看到掉落物。");
    if (picked) remember(`拾取了附近的掉落物`);
  } catch (error) {
    if (activeTask === task) bot.chat(errorMessage(error));
  } finally {
    if (activeTask === task) activeTask = null;
  }
}

function walkableSurfaceHeight(origin, radius = 3) {
  let highest = null;
  for (let x = origin.x - radius; x <= origin.x + radius; x += 1) {
    for (let z = origin.z - radius; z <= origin.z + radius; z += 1) {
      for (let y = origin.y; y <= origin.y + 2; y += 1) {
        const floor = bot.blockAt(new Vec3(x, y, z));
        const feet = bot.blockAt(new Vec3(x, y + 1, z));
        const head = bot.blockAt(new Vec3(x, y + 2, z));
        if (floor?.boundingBox === "block" && feet?.boundingBox === "empty" && head?.boundingBox === "empty") {
          highest = Math.max(highest ?? y + 1, y + 1);
        }
      }
    }
  }
  return highest;
}

function escapeStack() {
  return bot.inventory.items().find((item) => ESCAPE_BLOCKS.includes(item.name));
}

async function waitForHeight(minimumY, task) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    assertTask(task);
    if (bot.entity.position.y >= minimumY) return true;
    await bot.waitForTicks(1);
  }
  return false;
}

async function waitForJump(startY, task) {
  const deadline = Date.now() + 1200;
  while (Date.now() < deadline) {
    assertTask(task);
    if (bot.entity.position.y >= startY + 0.45) return true;
    await bot.waitForTicks(1);
  }
  return false;
}

async function escapeShallowPit() {
  const task = beginTask("浅坑脱困", { allowLowHealth: true });
  const startFeetY = Math.floor(bot.entity.position.y);
  const origin = bot.entity.position.floored();
  const surfaceY = walkableSurfaceHeight(origin);
  const rise = surfaceY === null ? 0 : surfaceY - startFeetY;
  if (rise <= 0) {
    activeTask = null;
    return bot.chat("这里看起来不是浅坑，我先不放方块。你可以让我“过来”试试现有出口。");
  }
  if (rise > 3) {
    activeTask = null;
    return bot.chat(`这个坑大约有 ${rise} 格深，超过浅坑脱困上限。`);
  }
  if (!escapeStack() || bot.inventory.items().filter((item) => ESCAPE_BLOCKS.includes(item.name)).reduce((sum, item) => sum + item.count, 0) < rise) {
    activeTask = null;
    return bot.chat(`需要至少 ${rise} 个泥土或圆石才能安全垫上去。`);
  }
  bot.chat(`我尝试垫 ${rise} 格出来。`);
  try {
    for (let step = 0; step < rise; step += 1) {
      assertTask(task);
      const stack = escapeStack();
      if (!stack) throw new Error("脱困方块不够了");
      const feetY = Math.floor(bot.entity.position.y);
      const headSpace = bot.blockAt(new Vec3(origin.x, feetY + 2, origin.z));
      if (!headSpace || headSpace.boundingBox !== "empty") throw new Error("头顶空间不足，不能安全垫脚");
      const reference = bot.blockAt(new Vec3(origin.x, feetY - 1, origin.z));
      if (!reference || reference.boundingBox !== "block") throw new Error("脚下没有可用于放置方块的支撑面");
      await bot.equip(stack, "hand");
      const jumpStartY = bot.entity.position.y;
      bot.setControlState("jump", true);
      if (!await waitForJump(jumpStartY, task)) throw new Error("没有成功起跳，未放置垫脚方块");
      await bot.placeBlock(reference, new Vec3(0, 1, 0));
      bot.setControlState("jump", false);
      if (!await waitForHeight(feetY + 0.9, task)) throw new Error("放置后高度没有上升，脱困已停止");
      const placed = bot.blockAt(new Vec3(origin.x, feetY, origin.z));
      if (!placed || placed.boundingBox !== "block") throw new Error("未能确认垫脚方块已放置");
    }
    bot.chat("我垫上来了。");
    remember(`用 ${rise} 个低价值方块完成了浅坑脱困`);
  } catch (error) {
    bot.setControlState("jump", false);
    if (activeTask === task) bot.chat(errorMessage(error));
  } finally {
    bot.setControlState("jump", false);
    if (activeTask === task) activeTask = null;
  }
}

async function retreatToSafety(reason = "用户要求撤退") {
  const route = safeRoute.length ? [...safeRoute].reverse() : [homePosition() || positionSnapshot(ownerEntity()?.position)].filter(Boolean);
  if (!route.length) return bot.chat("还没有可用的安全点。先在安全位置执行一次任务，或设置家点。");
  const finalTarget = route.at(-1);
  const task = beginTask("撤退", { allowLowHealth: true });
  setSafeMovements(false);
  bot.chat("我停止当前行动，返回安全点。");
  try {
    for (const target of route) await goNear(target, 1, task);
    if (Math.hypot(bot.entity.position.x - finalTarget.x, bot.entity.position.y - finalTarget.y, bot.entity.position.z - finalTarget.z) > 2) {
      throw new Error("未能确认已回到原始安全点");
    }
    bot.chat("我回到安全点了。");
    remember(`${reason}，返回了安全检查点`);
  } catch (error) {
    if (activeTask === task) bot.chat(`无法到达安全点：${errorMessage(error)}`);
  } finally {
    if (activeTask === task) activeTask = null;
  }
}

function platformStack() {
  return bot.inventory.items().find((item) => ESCAPE_BLOCKS.includes(item.name));
}

function escapeBlockCount() {
  return countEscapeBlocks(bot.inventory.items());
}

function entityIntersectsBlock(position) {
  return Object.values(bot.entities).some((entity) => {
    if (!entity?.position || entity === bot.entity) return false;
    if (!["player", "mob"].includes(entity.type)) return false;
    return Math.abs(entity.position.x - (position.x + 0.5)) < 0.9
      && Math.abs(entity.position.z - (position.z + 0.5)) < 0.9
      && entity.position.y < position.y + 2
      && entity.position.y + (entity.height || 1.8) > position.y;
  });
}

async function waitForBedPlacement(foot, head, task) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    assertTask(task);
    const footBlock = bot.blockAt(foot);
    const headBlock = bot.blockAt(head);
    if (footBlock && headBlock && bot.isABed(footBlock) && bot.isABed(headBlock)) return footBlock;
    await bot.waitForTicks(1);
  }
  return null;
}

async function waitForPlacedBlock(position, task) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    assertTask(task);
    const block = bot.blockAt(position);
    if (block?.boundingBox === "block") return block;
    await bot.waitForTicks(1);
  }
  return null;
}

function nearbyPlatformCandidates(originFeet) {
  const candidates = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -3; dx <= 2; dx += 1) {
      for (let dz = -3; dz <= 2; dz += 1) {
        const targets = [
          new Vec3(originFeet.x + dx, originFeet.y + dy, originFeet.z + dz),
          new Vec3(originFeet.x + dx + 1, originFeet.y + dy, originFeet.z + dz),
          new Vec3(originFeet.x + dx, originFeet.y + dy, originFeet.z + dz + 1),
          new Vec3(originFeet.x + dx + 1, originFeet.y + dy, originFeet.z + dz + 1),
        ];
        if (targets.some((target) => target.x === originFeet.x && target.y === originFeet.y && target.z === originFeet.z)) continue;
        const centerX = originFeet.x + dx + 1;
        const centerZ = originFeet.z + dz + 1;
        candidates.push({ targets, distance: Math.hypot(centerX - bot.entity.position.x, dy, centerZ - bot.entity.position.z) });
      }
    }
  }
  return candidates.sort((a, b) => a.distance - b.distance);
}

function platformAreaIssue(targets) {
  for (const target of targets) {
    const existing = bot.blockAt(target);
    const foundation = bot.blockAt(target.offset(0, -1, 0));
    const above = bot.blockAt(target.offset(0, 1, 0));
    const head = bot.blockAt(target.offset(0, 2, 0));
    if (!existing || !foundation || !above || !head) return "目标区块尚未加载";
    if (foundation.boundingBox !== "block") return "缺少完整地基";
    if (!isAirBlock(existing)) return `目标位置已有 ${existing.displayName || existing.name}`;
    if (!isAirBlock(above)) return `上方有 ${above.displayName || above.name}`;
    if (!isAirBlock(head)) return `头顶有 ${head.displayName || head.name}`;
    if (entityIntersectsBlock(target)) return "区域内有玩家或生物";
  }
  return null;
}

async function buildSmallPlatform() {
  const stackCount = escapeBlockCount();
  if (stackCount < 4 + ESCAPE_RESERVE) return bot.chat(`铺 2×2 平台需要至少 ${4 + ESCAPE_RESERVE} 个泥土或圆石，其中 ${ESCAPE_RESERVE} 个留作脱困储备。`);
  const originFeet = bot.entity.position.floored();
  const candidates = nearbyPlatformCandidates(originFeet);
  const candidate = candidates.find(({ targets }) => !platformAreaIssue(targets));
  if (!candidate) return bot.chat(`周围没有合格的 2×2 平台区域：${platformAreaIssue(candidates[0].targets)}。`);
  const targets = candidate.targets;
  const task = beginTask("铺设 2×2 平台");
  bot.chat("我在面前铺一个 2×2 小平台。说“停止”可以中断。");
  let placed = 0;
  try {
    for (const target of targets) {
      assertTask(task);
      const stack = platformStack();
      if (!stack) throw new Error("平台方块不够了");
      const reference = bot.blockAt(target.offset(0, -1, 0));
      if (!reference || reference.boundingBox !== "block") throw new Error("找不到安全的地基支撑块");
      await bot.equip(stack, "hand");
      await bot.placeBlock(reference, new Vec3(0, 1, 0));
      const confirmed = await waitForPlacedBlock(target, task);
      if (!confirmed) throw new Error("未能确认平台方块已放置");
      placed += 1;
    }
    bot.chat("2×2 平台铺好了。");
    remember("铺设了一个 2×2 小平台");
  } catch (error) {
    if (activeTask === task) bot.chat(`${errorMessage(error)}；已放置 ${placed}/4 块`);
  } finally {
    if (activeTask === task) activeTask = null;
  }
}

function shelterCandidate() {
  const feet = bot.entity.position.floored();
  const offsets = [[3, -2], [-6, -2], [-2, 3], [-2, -6]];
  for (const [dx, dz] of offsets) {
    const origin = { x: feet.x + dx, y: feet.y, z: feet.z + dz };
    const plan = shelterTargets(origin);
    let valid = true;
    for (let x = 0; x < 4 && valid; x += 1) {
      for (let z = 0; z < 4 && valid; z += 1) {
        const floor = bot.blockAt(new Vec3(origin.x + x, origin.y - 1, origin.z + z));
        const body = bot.blockAt(new Vec3(origin.x + x, origin.y, origin.z + z));
        const head = bot.blockAt(new Vec3(origin.x + x, origin.y + 1, origin.z + z));
        const roof = bot.blockAt(new Vec3(origin.x + x, origin.y + 2, origin.z + z));
        valid = floor?.boundingBox === "block" && body?.boundingBox === "empty" && head?.boundingBox === "empty" && roof?.boundingBox === "empty"
          && !entityIntersectsBlock(body.position) && !entityIntersectsBlock(head.position);
      }
    }
    if (valid) return plan;
  }
  return null;
}

async function buildShelter() {
  const plan = shelterCandidate();
  if (!plan) return bot.chat("附近没有 4×4、三格净高且无玩家/生物的平整空地。请换到开阔地再试。 ");
  const required = plan.all.length + ESCAPE_RESERVE;
  if (escapeBlockCount() < required) return bot.chat(`小避难所需要 ${plan.all.length} 个泥土或圆石，另保留 ${ESCAPE_RESERVE} 个脱困方块；当前共 ${escapeBlockCount()} 个。`);
  const task = beginTask("建造 4×4 避难所");
  let placed = 0;
  bot.chat(`我开始建 4×4 小避难所：两格高墙、完整屋顶和双格门洞，共 ${plan.all.length} 块。说“停止”可以中断。`);
  try {
    for (const point of plan.all) {
      assertTask(task);
      const target = new Vec3(point.x, point.y, point.z);
      const existing = bot.blockAt(target);
      if (existing?.boundingBox === "block") continue;
      let reference = null;
      for (const [dx, dy, dz] of [[0,-1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]) {
        const candidate = bot.blockAt(target.offset(dx, dy, dz));
        if (candidate?.boundingBox === "block") { reference = candidate; break; }
      }
      if (!reference) throw new Error(`目标 ${target} 缺少相邻支撑块`);
      const stack = platformStack();
      if (!stack || escapeBlockCount() <= ESCAPE_RESERVE) throw new Error("建筑方块不足，已保留脱困储备");
      await bot.equip(stack, "hand");
      await goNear(target, 4, task);
      await bot.placeBlock(reference, target.minus(reference.position));
      const confirmed = await waitForPlacedBlock(target, task);
      if (!confirmed) throw new Error(`未确认 ${target} 已放置`);
      placed += 1;
    }
    if (plan.door.some((point) => bot.blockAt(new Vec3(point.x, point.y, point.z))?.boundingBox !== "empty")) throw new Error("门洞净空核对失败");
    bot.chat("4×4 小避难所建好了，门洞与屋顶已核对。 ");
    remember("建造了一座带门洞和屋顶的 4×4 小避难所");
  } catch (error) {
    if (activeTask === task) bot.chat(`${errorMessage(error)}；已放置 ${placed}/${plan.all.length} 块`);
  } finally {
    if (activeTask === task) activeTask = null;
  }
}

function itemCount(name) {
  return bot.inventory.items().filter((item) => item.name === name).reduce((sum, item) => sum + item.count, 0);
}

async function craftItem(alias, count) {
  const configuredName = CRAFT_ALIASES[alias];
  if (!configuredName) return bot.chat("目前支持合成：木板、木棍、工作台、箱子、熔炉、火把、面包，以及常用木/石工具和剑。");
  const candidateNames = alias === "木板"
    ? Object.keys(bot.registry.itemsByName).filter((name) => name.endsWith("_planks"))
    : [configuredName];
  const registryItems = candidateNames.map((name) => bot.registry.itemsByName[name]).filter(Boolean);
  if (!registryItems.length) return bot.chat("当前服务器版本里没有对应物品。");
  const task = beginTask(`合成 ${alias}`);
  try {
    let table = null;
    let item = registryItems
      .find((candidate) => bot.recipesFor(candidate.id, null, count, null)[0]);
    let recipe = item ? bot.recipesFor(item.id, null, count, null)[0] : null;
    if (!recipe) {
      const tableId = bot.registry.blocksByName.crafting_table?.id;
      table = tableId ? bot.findBlock({ matching: tableId, maxDistance: 16 }) : null;
      if (table) {
        await goNear(table.position, 3, task);
        item = registryItems
          .find((candidate) => bot.recipesFor(candidate.id, null, count, table)[0]);
        recipe = item ? bot.recipesFor(item.id, null, count, table)[0] : null;
      }
    }
    if (!item || !recipe) throw new Error(table ? "材料不足，无法完成这次合成" : "材料不足，或这个配方需要附近的工作台");
    const before = itemCount(item.name);
    const outputPerCraft = recipe.result?.count || 1;
    const times = Math.ceil(count / outputPerCraft);
    await bot.craft(recipe, times, table);
    const confirmed = await waitForInventoryItem(item.name, before + count - 1, task);
    await bot.waitForTicks(3);
    const gained = itemCount(item.name) - before;
    if (!confirmed) throw new Error("合成完成后背包没有同步出目标物品");
    if (gained < count) throw new Error(`合成结果未达到目标：只增加了 ${gained} 个`);
    bot.chat(`合成好了：${alias}增加 ${gained} 个。`);
    remember(`合成了 ${alias} x${gained}`);
  } catch (error) {
    if (activeTask === task) bot.chat(errorMessage(error));
  } finally {
    if (activeTask === task) activeTask = null;
  }
}

function safePlacementTarget() {
  const feet = bot.entity.position.floored();
  const candidates = [];
  for (let dx = -3; dx <= 3; dx += 1) {
    for (let dz = -3; dz <= 3; dz += 1) {
      if (dx === 0 && dz === 0) continue;
      const target = feet.offset(dx, 0, dz);
      candidates.push({ target, distance: Math.hypot(dx, dz) });
    }
  }
  return candidates.sort((a, b) => a.distance - b.distance).map(({ target }) => target).find((target) => {
    const foundation = bot.blockAt(target.offset(0, -1, 0));
    const existing = bot.blockAt(target);
    const above = bot.blockAt(target.offset(0, 1, 0));
    return foundation?.boundingBox === "block"
      && isAirBlock(existing)
      && isAirBlock(above)
      && !entityIntersectsBlock(target);
  }) || null;
}

async function placeCraftingTable() {
  const tableId = bot.registry.blocksByName.crafting_table?.id;
  const existing = tableId ? bot.findBlock({ matching: tableId, maxDistance: 16 }) : null;
  if (existing) return bot.chat(`附近已有工作台：${existing.position}。`);
  const item = bot.inventory.items().find((entry) => entry.name === "crafting_table");
  if (!item) return bot.chat("背包里没有工作台，先说“合成工作台”。");
  const target = safePlacementTarget();
  if (!target) return bot.chat("附近没有安全的工作台放置位置。");
  const task = beginTask("放置工作台");
  try {
    const foundation = bot.blockAt(target.offset(0, -1, 0));
    await bot.equip(item, "hand");
    await bot.placeBlock(foundation, new Vec3(0, 1, 0));
    const placed = await waitForPlacedBlock(target, task);
    if (!placed || placed.name !== "crafting_table") throw new Error("未能确认工作台已放置");
    bot.chat(`工作台放好了：${target}。`);
    remember("在安全空地放置了工作台");
  } catch (error) {
    if (activeTask === task) bot.chat(errorMessage(error));
  } finally {
    if (activeTask === task) activeTask = null;
  }
}

async function placeUtilityBlock(itemName, blockName, label) {
  const existingId = bot.registry.blocksByName[blockName]?.id;
  const existing = existingId ? bot.findBlock({ matching: existingId, maxDistance: 16 }) : null;
  if (existing) return bot.chat(`附近已有${label}：${existing.position}。`);
  const item = bot.inventory.items().find((entry) => entry.name === itemName);
  if (!item) return bot.chat(`背包里没有${label}，先说“合成${label}”。`);
  const target = safePlacementTarget();
  if (!target) return bot.chat(`附近没有安全的${label}放置位置。`);
  const task = beginTask(`放置${label}`);
  try {
    const foundation = bot.blockAt(target.offset(0, -1, 0));
    await bot.equip(item, "hand");
    await bot.placeBlock(foundation, new Vec3(0, 1, 0));
    const placed = await waitForPlacedBlock(target, task);
    if (!placed || placed.name !== blockName) throw new Error(`未能确认${label}已放置`);
    bot.chat(`${label}放好了：${target}。`);
    remember(`在安全空地放置了${label}`);
  } catch (error) {
    if (activeTask === task) bot.chat(errorMessage(error));
  } finally {
    if (activeTask === task) activeTask = null;
  }
}

async function placeAndBindBed() {
  const item = bot.inventory.items().find((entry) => entry.name.endsWith("_bed"));
  if (!item) return bot.chat("背包里没有床。可以先说“合成白床”。");
  const candidate = bedPlacementCandidates(bot.entity.position.floored())
    .find((entry) => isBedPlacementSafe(entry, (position) => bot.blockAt(position), entityIntersectsBlock));
  if (!candidate) return bot.chat("附近没有连续两格受支撑、上方空闲且无人占用的安全床位。");
  const task = beginTask("放置并绑定床");
  try {
    const foundation = bot.blockAt(candidate.foot.offset(0, -1, 0));
    await bot.equip(item, "hand");
    await bot.lookAt(candidate.head.offset(0.5, 0.2, 0.5), true);
    await bot.placeBlock(foundation, new Vec3(0, 1, 0));
    const bed = await waitForBedPlacement(candidate.foot, candidate.head, task);
    if (!bed) throw new Error("未能确认床的两格都已经放置");
    saveBoundBed(bed.position);
    bot.chat(`床已放置并绑定：${bed.position}。`);
    remember("在安全空地放置并绑定了一张床");
  } catch (error) {
    if (activeTask === task) bot.chat(`放床失败：${errorMessage(error)}`);
  } finally { if (activeTask === task) activeTask = null; }
}

async function placeTorch() {
  const torch = bot.inventory.items().find((item) => item.name === "torch");
  if (!torch) return bot.chat("背包里没有火把。可以先说“合成火把”。");
  const feet = bot.entity.position.floored();
  const candidates = [];
  for (let dx = -3; dx <= 3; dx += 1) for (let dz = -3; dz <= 3; dz += 1) {
    const target = feet.offset(dx, 0, dz);
    if (target.equals(feet)) continue;
    candidates.push(target);
  }
  const target = candidates.find((point) => isAirBlock(bot.blockAt(point))
    && bot.blockAt(point.offset(0, -1, 0))?.boundingBox === "block" && !entityIntersectsBlock(point));
  if (!target) return bot.chat("附近没有安全的火把位置。");
  const task = beginTask("放置火把");
  try {
    await bot.equip(torch, "hand");
    await bot.placeBlock(bot.blockAt(target.offset(0, -1, 0)), new Vec3(0, 1, 0));
    const placed = await waitForCrop(target, "torch", task);
    if (!placed) throw new Error("未确认火把已放置");
    bot.chat(`火把放好了：${target}。`);
    remember("在附近放置了一支火把照明");
  } catch (error) {
    if (activeTask === task) bot.chat(errorMessage(error));
  } finally { if (activeTask === task) activeTask = null; }
}

async function autoLightIfNeeded(includeTunnel = false) {
  if (!bot?.entity || autoLightingBusy || Date.now() - lastAutoLightAt < 12000) return;
  if (!activeTask || (activeTask.name !== "跟随探索" && !(includeTunnel && activeTask.name === "安全水平掘进"))) return;
  if (combatBusy || bot.nearestEntity((entity) => isHostile(entity) && entity.position.distanceTo(bot.entity.position) <= 14)) return;
  const feet = bot.entity.position.floored();
  const current = bot.blockAt(feet);
  const torchCount = itemCount("torch");
  if (!needsTorch(current, torchCount)) return;
  const candidates = [feet.offset(1, 0, 0), feet.offset(-1, 0, 0), feet.offset(0, 0, 1), feet.offset(0, 0, -1)];
  const target = candidates.find((position) => isAirBlock(bot.blockAt(position))
    && bot.blockAt(position.offset(0, -1, 0))?.boundingBox === "block"
    && !entityIntersectsBlock(position));
  if (!target) return;
  autoLightingBusy = true;
  lastAutoLightAt = Date.now();
  const task = activeTask;
  try {
    assertTask(task);
    const torch = bot.inventory.items().find((item) => item.name === "torch");
    if (!torch) return;
    await bot.equip(torch, "hand");
    await bot.placeBlock(bot.blockAt(target.offset(0, -1, 0)), new Vec3(0, 1, 0));
    if (!await waitForCrop(target, "torch", task)) throw new Error("服务器未确认自动照明火把");
    remember("探索暗处时主动放置了一支火把");
  } catch (error) {
    progress(`自动照明暂未成功：${errorMessage(error)}`);
  } finally { autoLightingBusy = false; }
}

async function setNearestDoor(open) {
  const door = bot.findBlock({ matching: (block) => block?.name?.endsWith("_door"), maxDistance: 6 });
  if (!door) return bot.chat("6 格内没有找到门。");
  const current = Boolean(door.getProperties?.().open);
  if (current === open) return bot.chat(`门已经是${open ? "打开" : "关闭"}的。`);
  try {
    await bot.activateBlock(door);
    await bot.waitForTicks(2);
    const changed = bot.blockAt(door.position);
    if (Boolean(changed?.getProperties?.().open) !== open) throw new Error("门状态未改变");
    bot.chat(`门已${open ? "打开" : "关闭"}。`);
  } catch (error) { bot.chat(`操作门失败：${errorMessage(error)}`); }
}

async function equipShield() {
  const shield = bot.inventory.items().find((item) => item.name === "shield");
  if (!shield) return bot.chat("背包里没有盾牌。可以先说“合成盾牌”。");
  await bot.equip(shield, "off-hand");
  bot.chat("盾牌已装备到副手。");
}

async function holdInventoryItem(alias) {
  const names = resolveContainerNames(alias);
  if (!names) return bot.chat("我还不认识这个物品名称。");
  const item = bot.inventory.items().find((candidate) => names.includes(candidate.name));
  if (!item) return bot.chat(`背包里没有${alias}。`);
  await bot.equip(item, "hand");
  await bot.waitForTicks(2);
  if (bot.heldItem?.type !== item.type) return bot.chat(`没能确认已经拿出${alias}。`);
  bot.chat(`已经把${alias}拿在手上了。`);
}

async function fishOnce() {
  const rod = bot.inventory.items().find((item) => item.name === "fishing_rod" && durabilityRemaining(item) > MIN_TOOL_DURABILITY);
  if (!rod) return bot.chat("没有剩余耐久足够的钓鱼竿。");
  const waterId = bot.registry.blocksByName.water?.id;
  const water = waterId ? bot.findBlock({ matching: waterId, maxDistance: 12 }) : null;
  if (!water) return bot.chat("12 格内没有找到水面。");
  const task = beginTask("钓鱼");
  try {
    await goNear(water.position, 4, task);
    await bot.equip(rod, "hand");
    await bot.lookAt(water.position.offset(0.5, 0.8, 0.5), true);
    await bot.fish();
    bot.chat("这一竿钓完了；掉落物已尝试收入背包。");
    remember("在主世界水边钓了一次鱼");
  } catch (error) {
    if (activeTask === task) bot.chat(`钓鱼失败：${errorMessage(error)}`);
  } finally { if (activeTask === task) activeTask = null; }
}

async function waitForInventoryItem(name, before, task) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    assertTask(task);
    if (itemCount(name) > before) return true;
    await bot.waitForTicks(1);
  }
  return false;
}

async function fillWaterBucket() {
  const bucket = bot.inventory.items().find((item) => item.name === "bucket");
  if (!bucket) return bot.chat("背包里没有空铁桶。可以先说“合成铁桶”。");
  const water = bot.findBlock({
    matching: (block) => block?.name === "water" && Number(block.getProperties?.().level || 0) === 0,
    maxDistance: 16,
  });
  if (!water) return bot.chat("16 格内没有找到水源方块。");
  const task = beginTask("打水");
  try {
    await goNear(water.position, 3, task);
    const before = itemCount("water_bucket");
    await bot.equip(bucket, "hand");
    await bot.lookAt(water.position.offset(0.5, 0.5, 0.5), true);
    bot.activateItem();
    if (!await waitForInventoryItem("water_bucket", before, task)) throw new Error("未能确认铁桶已经装水");
    bot.chat("水打好了。 ");
    remember("用铁桶取了一桶水");
  } catch (error) {
    if (activeTask === task) bot.chat(`打水失败：${errorMessage(error)}`);
  } finally { if (activeTask === task) activeTask = null; }
}

async function placeWaterBucket() {
  const waterBucket = bot.inventory.items().find((item) => item.name === "water_bucket");
  if (!waterBucket) return bot.chat("背包里没有水桶。");
  const target = safePlacementTarget();
  if (!target) return bot.chat("附近没有安全、空闲且不与任何人重叠的放水位置。");
  const task = beginTask("放水");
  try {
    const emptyBefore = itemCount("bucket");
    await bot.equip(waterBucket, "hand");
    await bot.lookAt(target.offset(0.5, 0.2, 0.5), true);
    bot.activateItem();
    if (!await waitForCrop(target, "water", task) || !await waitForInventoryItem("bucket", emptyBefore, task)) {
      throw new Error("未能确认水已放下且铁桶已变空");
    }
    bot.chat(`水放好了：${target}。`);
    remember("在安全空地放置了一桶水");
  } catch (error) {
    if (activeTask === task) bot.chat(`放水失败：${errorMessage(error)}`);
  } finally { if (activeTask === task) activeTask = null; }
}

async function milkNearestCow() {
  const bucket = bot.inventory.items().find((item) => item.name === "bucket");
  if (!bucket) return bot.chat("背包里没有空铁桶。");
  const cow = bot.nearestEntity((entity) => entity.name === "cow" && entity.position.distanceTo(bot.entity.position) <= 16);
  if (!cow) return bot.chat("16 格内没有牛。");
  const task = beginTask("挤牛奶");
  try {
    await goNear(cow.position, 2, task);
    const before = itemCount("milk_bucket");
    await bot.equip(bucket, "hand");
    await bot.activateEntity(cow);
    if (!await waitForInventoryItem("milk_bucket", before, task)) throw new Error("未能确认铁桶里已有牛奶");
    bot.chat("挤到一桶牛奶了。 ");
    remember("从牛身上挤了一桶牛奶");
  } catch (error) {
    if (activeTask === task) bot.chat(`挤奶失败：${errorMessage(error)}`);
  } finally { if (activeTask === task) activeTask = null; }
}

function nearbyEntitiesByName(name, radius = 16) {
  return Object.values(bot.entities)
    .filter((entity) => entity.name === name && entity.position.distanceTo(bot.entity.position) <= radius)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
}

async function breedAnimals(animalName) {
  const spec = breedSpec(animalName);
  if (!spec) return bot.chat("目前支持繁殖牛、羊、猪和鸡。");
  const food = bot.inventory.items().find((item) => spec.foods.includes(item.name) && item.count >= 2);
  if (!food) return bot.chat(`繁殖${animalName}需要至少 2 个合适的饲料。`);
  const adults = nearbyEntitiesByName(spec.entity).filter((entity) => entity.metadata?.[16] !== true).slice(0, 2);
  if (adults.length < 2) return bot.chat(`16 格内没有找到两只可接近的${animalName}。`);
  const task = beginTask(`繁殖${animalName}`);
  try {
    const knownIds = new Set(Object.keys(bot.entities));
    const beforeFood = itemCount(food.name);
    for (const animal of adults) {
      assertTask(task);
      await goNear(animal.position, 2, task);
      await bot.equip(bot.inventory.items().find((item) => item.name === food.name), "hand");
      await bot.activateEntity(animal);
      await bot.waitForTicks(5);
    }
    const deadline = Date.now() + 15000;
    let baby = null;
    while (Date.now() < deadline) {
      assertTask(task);
      baby = nearbyEntitiesByName(spec.entity, 20).find((entity) => !knownIds.has(String(entity.id)));
      if (baby) break;
      await bot.waitForTicks(5);
    }
    const consumed = beforeFood - itemCount(food.name);
    if (consumed < 2 || !baby) throw new Error(`已消耗 ${consumed}/2 份饲料，但没有确认新生${animalName}`);
    bot.chat(`${animalName}繁殖成功，已经确认幼崽出现。`);
    remember(`繁殖了${animalName}`);
  } catch (error) {
    if (activeTask === task) bot.chat(`繁殖失败：${errorMessage(error)}`);
  } finally { if (activeTask === task) activeTask = null; }
}

async function shearNearestSheep() {
  const shears = bot.inventory.items().find((item) => item.name === "shears" && durabilityRemaining(item) > MIN_TOOL_DURABILITY);
  if (!shears) return bot.chat("没有剩余耐久足够的剪刀。可以先说“合成剪刀”。");
  const sheep = nearbyEntitiesByName("sheep")[0];
  if (!sheep) return bot.chat("16 格内没有羊。");
  const task = beginTask("剪羊毛");
  try {
    const woolNames = Object.keys(bot.registry.itemsByName).filter((name) => name.endsWith("_wool"));
    const before = woolNames.reduce((total, name) => total + itemCount(name), 0);
    await goNear(sheep.position, 2, task);
    await bot.equip(shears, "hand");
    await bot.activateEntity(sheep);
    const deadline = Date.now() + 4000;
    let gained = 0;
    while (Date.now() < deadline) {
      assertTask(task);
      const drop = bot.nearestEntity((entity) => entity.name === "item" && entity.position.distanceTo(bot.entity.position) <= 8);
      if (drop) await goNear(drop.position, 0, task);
      gained = woolNames.reduce((total, name) => total + itemCount(name), 0) - before;
      if (gained > 0) break;
      await bot.waitForTicks(2);
    }
    if (gained < 1) throw new Error("未能确认获得羊毛，羊可能已经被剪过");
    bot.chat(`剪羊毛成功，获得 ${gained} 个羊毛。`);
    remember(`剪下了 ${gained} 个羊毛`);
  } catch (error) {
    if (activeTask === task) bot.chat(`剪羊毛失败：${errorMessage(error)}`);
  } finally { if (activeTask === task) activeTask = null; }
}

async function recoverDeathItems() {
  if (!lastDeathPosition) return bot.chat("本次联机还没有记录到死亡位置。");
  const task = beginTask("找回遗物", { allowLowHealth: true });
  try {
    bot.chat(`我去上次死亡位置 ${lastDeathPosition.floored()} 找回遗物。`);
    await goNear(lastDeathPosition, 2, task);
    let recovered = 0;
    while (recovered < 24) {
      assertTask(task);
      const drop = bot.nearestEntity((entity) => entity.name === "item" && entity.position.distanceTo(lastDeathPosition) <= 12);
      if (!drop) break;
      await goNear(drop.position, 0, task);
      const deadline = Date.now() + 1800;
      while (bot.entities[drop.id] && Date.now() < deadline) {
        assertTask(task);
        await bot.waitForTicks(1);
      }
      if (bot.entities[drop.id]) throw new Error("已到达掉落物旁，但服务器未确认拾取");
      recovered += 1;
    }
    bot.chat(recovered ? `已在死亡点确认捡回 ${recovered} 个掉落实体。` : "已经到达死亡点，但附近没有看到掉落物。");
    remember(recovered ? `返回死亡位置并确认捡回 ${recovered} 个掉落实体` : "返回上次死亡位置寻找遗物，但没有看到掉落物");
  } catch (error) {
    if (activeTask === task) bot.chat(`无法到达死亡位置：${errorMessage(error)}`);
  } finally { if (activeTask === task) activeTask = null; }
}

async function placeBoat() {
  const boat = bot.inventory.items().find((item) => item.name.endsWith("_boat") && !item.name.includes("chest"));
  if (!boat) return bot.chat("背包里没有普通船。可以先说“合成橡木船”。");
  const waterPositions = bot.findBlocks({
    matching: (block) => block?.name === "water" && Number(block.getProperties?.().level || 0) === 0,
    maxDistance: 12,
    count: 128,
  });
  const surfaceWater = waterPositions
    .map((position) => bot.blockAt(position))
    .filter((block) => block && bot.blockAt(block.position.offset(0, 1, 0))?.boundingBox === "empty")
    .sort((left, right) => {
      const horizontal = (block) => Math.hypot(block.position.x + 0.5 - bot.entity.position.x, block.position.z + 0.5 - bot.entity.position.z);
      const leftDistance = horizontal(left);
      const rightDistance = horizontal(right);
      const leftPenalty = leftDistance >= 2.5 && leftDistance <= 5 ? Math.abs(leftDistance - 3.5) : 20 + Math.abs(leftDistance - 3.5);
      const rightPenalty = rightDistance >= 2.5 && rightDistance <= 5 ? Math.abs(rightDistance - 3.5) : 20 + Math.abs(rightDistance - 3.5);
      return leftPenalty - rightPenalty;
    });
  const water = surfaceWater[0];
  if (!water) return bot.chat("12 格内没有找到可以放船的水面。");
  const task = beginTask("放船");
  try {
    await goNear(water.position, 4, task);
    const knownIds = new Set(Object.keys(bot.entities));
    await bot.equip(boat, "hand");
    await bot.lookAt(water.position.offset(0.5, 0.5, 0.5), true);
    // A shallow ray can pass over the water surface on modern Java versions.
    // Keep the horizontal aim selected by lookAt, but pitch down far enough for
    // the normal Mineflayer item-use path to hit the nearby source block.
    await bot.look(bot.entity.yaw, Math.min(bot.entity.pitch, -25 * Math.PI / 180), true);
    bot.activateItem();
    let entity = null;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      assertTask(task);
      entity = Object.values(bot.entities).find((candidate) => isBoatEntity(candidate) && !knownIds.has(String(candidate.id)));
      if (entity) break;
      await bot.waitForTicks(2);
    }
    if (!entity) throw new Error("未能确认船实体已经出现");
    bot.chat("船已经放到水面上了。 ");
    remember("在水面放置了一艘船");
  } catch (error) {
    if (activeTask === task) bot.chat(`放船失败：${errorMessage(error)}`);
  } finally { if (activeTask === task) activeTask = null; }
}

async function mountNearestBoat() {
  const boat = bot.nearestEntity((entity) => isBoatEntity(entity) && entity.position.distanceTo(bot.entity.position) <= 12);
  if (!boat) return bot.chat("12 格内没有船。");
  const task = beginTask("上船");
  try {
    await goNear(boat.position, 2, task);
    bot.mount(boat);
    await waitForVehicleState(() => bot.vehicle, boat);
    if (bot.vehicle !== boat) throw new Error("未能确认已经坐上船");
    bot.chat("我上船了。 ");
    remember("坐上了一艘船");
  } catch (error) {
    if (activeTask === task) bot.chat(`上船失败：${errorMessage(error)}`);
  } finally { if (activeTask === task) activeTask = null; }
}

async function dismountVehicle() {
  if (!bot.vehicle) return bot.chat("我现在没有乘坐载具。");
  if (bot.supportFeature("newPlayerInputPacket")) bot._client.write("player_input", { inputs: { shift: true } });
  else bot.dismount();
  await waitForVehicleState(() => bot.vehicle, null, 6000);
  if (bot.vehicle) return bot.chat("未能确认已经离开载具。");
  bot.chat("我已经下来了。 ");
}

function nearestVillager() {
  return bot.nearestEntity((entity) => entity.name === "villager" && entity.position.distanceTo(bot.entity.position) <= 12);
}

function tradeDescription(trade, index) {
  const inputs = trade.inputs.map((item, inputIndex) => `${item.displayName}×${inputIndex === 0 ? trade.realPrice : item.count}`).join(" + ");
  return `${index + 1}: ${inputs} → ${trade.outputItem.displayName}×${trade.outputItem.count}${trade.tradeDisabled ? "（售罄）" : ""}`;
}

async function withVillager(actionName, fn) {
  const entity = nearestVillager();
  if (!entity) return bot.chat("12 格内没有村民。");
  const task = beginTask(actionName);
  let villager = null;
  try {
    await goNear(entity.position, 2, task);
    villager = await bot.openVillager(entity);
    await fn(villager, task);
  } catch (error) {
    if (activeTask === task) bot.chat(`${actionName}失败：${errorMessage(error)}`);
  } finally {
    villager?.close();
    if (activeTask === task) activeTask = null;
  }
}

async function listVillagerTrades() {
  return withVillager("查看交易", async (villager) => {
    const summary = villager.trades.slice(0, 8).map(tradeDescription).join("；");
    bot.chat(summary ? `村民交易：${summary}` : "这个村民暂时没有交易。 ");
  });
}

async function executeVillagerTrade(index) {
  return withVillager("村民交易", async (villager, task) => {
    const trade = villager.trades[index - 1];
    if (!trade) throw new Error(`没有第 ${index} 项交易`);
    if (trade.tradeDisabled) throw new Error("这项交易已经售罄");
    const outputBefore = playerWindowItemCount(villager, trade.outputItem.name);
    await bot.trade(villager, index - 1, 1);
    assertTask(task);
    const gained = playerWindowItemCount(villager, trade.outputItem.name) - outputBefore;
    if (gained < trade.outputItem.count) throw new Error("交易完成包未能确认获得商品");
    bot.chat(`交易完成：${tradeDescription(trade, index - 1)}。`);
    remember(`与村民完成了交易：${trade.outputItem.displayName} x${gained}`);
  });
}

async function enchantHeldItem(choice) {
  const held = bot.heldItem;
  if (!held) return bot.chat("请先把要附魔的物品拿在手上。");
  const lapis = bot.inventory.items().find((item) => item.name === "lapis_lazuli");
  if (!lapis) return bot.chat("背包里没有青金石。");
  const table = bot.findBlock({ matching: (block) => block?.name === "enchanting_table", maxDistance: 12 });
  if (!table) return bot.chat("12 格内没有附魔台。");
  const task = beginTask("附魔");
  let window = null;
  try {
    await goNear(table.position, 3, task);
    window = await bot.openEnchantmentTable(table);
    const heldSlot = currentWindowSlot(window, held.slot);
    const lapisSlot = currentWindowSlot(window, lapis.slot);
    if (heldSlot === null || lapisSlot === null) throw new Error("无法定位附魔物品在容器中的槽位");
    await bot.moveSlotItem(heldSlot, 0);
    await bot.moveSlotItem(lapisSlot, 1);
    const lapisBefore = window.slots[1]?.count || 0;
    const enchanted = await window.enchant(choice - 1);
    const lapisAfter = window.slots[1]?.count || 0;
    await window.takeTargetItem();
    const enchantments = enchanted?.enchants;
    if (!enchanted || !enchantments || Object.keys(enchantments).length === 0 || lapisAfter >= lapisBefore) {
      throw new Error("未能确认物品已附魔并消耗青金石");
    }
    bot.chat(`附魔完成，选择了第 ${choice} 档。`);
    remember(`给 ${held.displayName} 完成了一次附魔`);
  } catch (error) {
    if (activeTask === task) bot.chat(`附魔失败：${errorMessage(error)}`);
  } finally { window?.close(); if (activeTask === task) activeTask = null; }
}

async function renameHeldItem(name) {
  const held = bot.heldItem;
  if (!held) return bot.chat("请先把要重命名的物品拿在手上。");
  const anvilBlock = bot.findBlock({ matching: (block) => ["anvil", "chipped_anvil", "damaged_anvil"].includes(block?.name), maxDistance: 12 });
  if (!anvilBlock) return bot.chat("12 格内没有铁砧。");
  const task = beginTask("重命名物品");
  let anvil = null;
  try {
    await goNear(anvilBlock.position, 3, task);
    const beforeLevel = bot.experience.level;
    anvil = await bot.openAnvil(anvilBlock);
    await anvil.rename(held, name);
    await bot.waitForTicks(3);
    const renamed = playerWindowItems(anvil).find((item) => item?.type === held.type && customNameText(item) === name);
    if (renamed) {
      anvil.close();
      anvil = null;
      await bot.waitForTicks(3);
      const inventoryRenamed = bot.inventory.items().find((item) => item.type === held.type && customNameText(item) === name);
      if (!inventoryRenamed) throw new Error("重命名成品没有同步回背包");
      await bot.equip(inventoryRenamed, "hand");
    }
    if (!renamed || bot.experience.level >= beforeLevel) throw new Error("未能确认物品名称和经验消耗");
    bot.chat(`物品已经重命名为“${name}”。`);
    remember(`用铁砧把物品重命名为 ${name}`);
  } catch (error) {
    if (activeTask === task) bot.chat(`重命名失败：${errorMessage(error)}`);
  } finally { anvil?.close(); if (activeTask === task) activeTask = null; }
}

const CONTAINER_ITEM_ALIASES = Object.freeze({
  ...MATERIAL_ALIASES,
  ...CRAFT_ALIASES,
});

const SMELT_ALIASES = Object.freeze({
  "铁": { inputs: ["raw_iron", "iron_ore", "deepslate_iron_ore"], output: "iron_ingot" },
  "铜": { inputs: ["raw_copper", "copper_ore", "deepslate_copper_ore"], output: "copper_ingot" },
  "金": { inputs: ["raw_gold", "gold_ore", "deepslate_gold_ore"], output: "gold_ingot" },
  "玻璃": { inputs: ["sand", "red_sand"], output: "glass" },
  "石头": { inputs: ["cobblestone"], output: "stone" },
  "砖": { inputs: ["clay_ball"], output: "brick" },
  "绿色染料": { inputs: ["cactus"], output: "green_dye" },
  "牛肉": { inputs: ["beef"], output: "cooked_beef" },
  "猪肉": { inputs: ["porkchop"], output: "cooked_porkchop" },
  "鸡肉": { inputs: ["chicken"], output: "cooked_chicken" },
  "羊肉": { inputs: ["mutton"], output: "cooked_mutton" },
  "土豆": { inputs: ["potato"], output: "baked_potato" },
  "木炭": { inputs: MATERIAL_ALIASES["原木"], output: "charcoal" },
});
const FURNACE_FUELS = Object.freeze(["coal", "charcoal", "oak_planks", "birch_planks", "spruce_planks", "jungle_planks", "acacia_planks", "dark_oak_planks", "mangrove_planks", "cherry_planks", "pale_oak_planks"]);

async function smeltItems(alias, requested) {
  const recipe = SMELT_ALIASES[alias];
  if (!recipe) return bot.chat("目前支持烧炼铁、铜、金、玻璃、石头、砖、绿色染料、常见肉类、土豆和木炭。");
  const furnaceId = bot.registry.blocksByName.furnace?.id;
  const furnaceBlock = furnaceId ? bot.findBlock({ matching: furnaceId, maxDistance: 16 }) : null;
  if (!furnaceBlock) return bot.chat("16 格内没有熔炉。可以先说“合成熔炉”并放置。");
  const input = bot.inventory.items().find((item) => recipe.inputs.includes(item.name));
  const fuel = bot.inventory.items().find((item) => FURNACE_FUELS.includes(item.name));
  if (!input) return bot.chat(`背包里没有可烧炼的${alias}原料。`);
  if (!fuel) return bot.chat("背包里没有煤、木炭或木板燃料。");
  const amount = Math.min(requested, input.count);
  const task = beginTask(`烧炼 ${alias}`);
  let furnace = null;
  try {
    await goNear(furnaceBlock.position, 3, task);
    furnace = await bot.openFurnace(furnaceBlock);
    if (furnace.inputItem() || furnace.outputItem()) throw new Error("熔炉输入或输出槽已有物品，请先清空以便严格核对");
    const fuelNeeded = Math.max(1, Math.ceil(amount / 8));
    await furnace.putFuel(fuel.type, fuel.metadata, Math.min(fuelNeeded, fuel.count));
    await furnace.putInput(input.type, input.metadata, amount);
    const outputType = bot.registry.itemsByName[recipe.output]?.id;
    const deadline = Date.now() + amount * 12000 + 5000;
    while (Date.now() < deadline) {
      assertTask(task);
      const output = furnace.outputItem();
      if (output?.type === outputType && output.count >= amount) break;
      await bot.waitForTicks(5);
    }
    const output = furnace.outputItem();
    if (output?.type !== outputType || output.count < amount) throw new Error(`烧炼超时，未确认获得 ${amount} 个成品`);
    const before = furnace.items().filter((item) => item.name === recipe.output).reduce((sum, item) => sum + item.count, 0);
    await furnace.takeOutput();
    const gained = furnace.items().filter((item) => item.name === recipe.output).reduce((sum, item) => sum + item.count, 0) - before;
    if (gained < amount) throw new Error(`成品数量核对失败：只增加 ${gained} 个`);
    bot.chat(`${alias}烧好了，获得 ${gained} 个成品。`);
    remember(`烧炼了 ${alias} x${gained}`);
  } catch (error) {
    if (activeTask === task) bot.chat(errorMessage(error));
  } finally {
    furnace?.close();
    if (activeTask === task) activeTask = null;
  }
}

async function bindNearestChest() {
  const chestId = bot.registry.blocksByName.chest?.id;
  const chest = chestId ? bot.findBlock({ matching: chestId, maxDistance: 8 }) : null;
  if (!chest) return bot.chat("8 格内没有找到普通箱子。");
  saveBoundChest(chest.position);
  bot.chat(`已绑定箱子：${chest.position}。`);
  remember("绑定了一只私人箱子");
}

async function bindNearestBed() {
  const bed = bot.findBlock({ matching: (block) => bot.isABed(block), maxDistance: 8 });
  if (!bed) return bot.chat("8 格内没有找到床。把我带到床边再绑定吧。");
  saveBoundBed(bed.position);
  bot.chat(`已绑定床：${bed.position}。`);
  remember("绑定了一张床");
}

async function sleepInBoundBed() {
  const position = boundBedPosition();
  if (!position) return bot.chat("还没有绑定床。先在床边说“绑定床”。");
  const task = beginTask("睡觉");
  try {
    const bed = bot.blockAt(new Vec3(position.x, position.y, position.z));
    if (!bed || !bot.isABed(bed)) throw new Error("绑定位置已经不再是床");
    await goNear(bed.position, 2, task);
    await bot.sleep(bed);
    if (!bot.isSleeping) throw new Error("未能确认已经入睡");
    bot.chat("我睡下了。早上会自动醒来。");
    remember("在绑定的床上睡觉");
  } catch (error) {
    if (activeTask === task) bot.chat(`睡不了：${errorMessage(error)}`);
  } finally {
    if (activeTask === task) activeTask = null;
  }
}

async function autoSleepIfSafe() {
  if (!bot?.entity || bot.isSleeping || activeTask || autoSleepBusy || Date.now() - lastAutoSleepAttemptAt < 30000) return;
  if (bot.time.isDay && !(bot.isRaining && bot.thunderState > 0)) return;
  if (bot.nearestEntity((entity) => isHostile(entity) && entity.position.distanceTo(bot.entity.position) <= 12)) return;
  const position = boundBedPosition();
  if (!position) return;
  const bed = bot.blockAt(new Vec3(position.x, position.y, position.z));
  if (!bed || !bot.isABed(bed)) return;
  autoSleepBusy = true;
  lastAutoSleepAttemptAt = Date.now();
  const task = beginTask("夜间自动睡觉");
  try {
    await goNear(bed.position, 2, task);
    await bot.sleep(bed);
    if (!bot.isSleeping) throw new Error("服务器未确认入睡");
    bot.chat("天黑了，附近也很安全，我先睡下啦。 ");
    remember("夜晚安全时主动回绑定的床睡觉");
  } catch (error) {
    progress(`自动睡觉暂未成功：${errorMessage(error)}`);
  } finally {
    if (activeTask === task) activeTask = null;
    autoSleepBusy = false;
  }
}

async function wakeFromBed() {
  if (!bot.isSleeping) return bot.chat("我现在没有在睡觉。");
  try {
    await bot.wake();
    if (bot.isSleeping) throw new Error("未能确认已经起床");
    bot.chat("我起来了。");
  } catch (error) {
    bot.chat(`起床失败：${errorMessage(error)}`);
  }
}

function findFarmBlock(predicate) {
  const positions = bot.findBlocks({ matching: () => true, maxDistance: 16, count: 4096 });
  return positions.map((position) => bot.blockAt(position)).find((block) => Boolean(block) && predicate(block)) || null;
}

function hasNearbyWater(position) {
  for (let x = -4; x <= 4; x += 1) {
    for (let z = -4; z <= 4; z += 1) {
      if (bot.blockAt(position.offset(x, 0, z))?.name === "water") return true;
    }
  }
  return false;
}

function tillableSoils() {
  const positions = bot.findBlocks({ matching: () => true, maxDistance: 16, count: 4096 });
  return positions.map((position) => bot.blockAt(position)).filter((block) => {
    if (!["dirt", "grass_block", "dirt_path"].includes(block.name)) return false;
    if (!isAirBlock(bot.blockAt(block.position.offset(0, 1, 0)))) return false;
    if (!hasNearbyWater(block.position)) return false;
    return isSafeToDig(block);
  });
}

function farmReachDistance(block) {
  return bot.entity.position.distanceTo(block.position.offset(0.5, 1, 0.5));
}

function standingOnFarmland() {
  return bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))?.name === "farmland";
}

function safeFarmApproach(target) {
  const candidates = [];
  for (let dx = -4; dx <= 4; dx += 1) {
    for (let dz = -4; dz <= 4; dz += 1) {
      const horizontalDistance = Math.hypot(dx, dz);
      if (horizontalDistance < 1.5 || horizontalDistance > 4.1) continue;
      const bodyPosition = target.position.offset(dx, 1, dz);
      const floor = bot.blockAt(bodyPosition.offset(0, -1, 0));
      const body = bot.blockAt(bodyPosition);
      const head = bot.blockAt(bodyPosition.offset(0, 1, 0));
      if (floor?.boundingBox !== "block" || body?.boundingBox !== "empty" || head?.boundingBox !== "empty") continue;
      if (entityIntersectsBlock(bodyPosition)) continue;
      const floorIsFarm = floor.name === "farmland"
        || (["dirt", "grass_block", "dirt_path"].includes(floor.name) && hasNearbyWater(floor.position));
      candidates.push({ bodyPosition, floorIsFarm, distance: bot.entity.position.distanceTo(bodyPosition.offset(0.5, 0, 0.5)) });
    }
  }
  candidates.sort((left, right) => Number(left.floorIsFarm) - Number(right.floorIsFarm) || left.distance - right.distance);
  return candidates[0]?.bodyPosition || null;
}

async function reachFarmBlock(block, task) {
  setFarmMovements();
  if (!standingOnFarmland() && farmReachDistance(block) <= FARM_REACH && !isSupportingEntity(block, bot.entity)) return;
  const approach = safeFarmApproach(block);
  if (!approach) throw new Error("找不到不会踩坏农田的安全操作位置");
  await bot.pathfinder.goto(new goals.GoalBlock(approach.x, approach.y, approach.z));
  assertTask(task);
  if (farmReachDistance(block) > FARM_REACH || isSupportingEntity(block, bot.entity)) throw new Error("无法从安全位置触及目标农田");
}

async function tillFarmland(count) {
  const hoe = bot.inventory.items().find((item) => item.name.endsWith("_hoe") && durabilityRemaining(item) > MIN_TOOL_DURABILITY);
  if (!hoe) return bot.chat("需要一把剩余耐久足够的锄。可以先说“合成木锄”或“合成石锄”。");
  const task = beginTask("开垦耕地");
  setFarmMovements();
  let tilled = 0;
  try {
    while (tilled < count) {
      assertTask(task);
      const candidates = tillableSoils().sort((left, right) => farmReachDistance(left) - farmReachDistance(right));
      let soil = candidates.find((block) => farmReachDistance(block) <= FARM_REACH) || null;
      if (!soil && candidates.length) {
        const approach = safeFarmApproach(candidates[0]);
        if (!approach) throw new Error("找不到不会踩住待开垦方块的安全操作位置");
        await bot.pathfinder.goto(new goals.GoalBlock(approach.x, approach.y, approach.z));
        assertTask(task);
        soil = tillableSoils().sort((left, right) => farmReachDistance(left) - farmReachDistance(right))
          .find((block) => farmReachDistance(block) <= FARM_REACH) || null;
      }
      if (!soil) throw new Error("16 格内没有临水、上方空闲且不在任何人脚下的可开垦土地");
      const current = bot.blockAt(soil.position);
      if (!["dirt", "grass_block", "dirt_path"].includes(current?.name) || !hasNearbyWater(current.position) || !isSafeToDig(current)) continue;
      await bot.equip(hoe, "hand");
      await bot.activateBlock(current, new Vec3(0, 1, 0), new Vec3(0.5, 1, 0.5));
      const confirmed = await waitForCrop(current.position, "farmland", task);
      if (!confirmed) throw new Error("未能确认土地已经开垦");
      tilled += 1;
    }
    bot.chat(`开垦好了 ${tilled} 块耕地。`);
    remember(`开垦了 ${tilled} 块耕地`);
  } catch (error) {
    if (activeTask === task) bot.chat(`${errorMessage(error)}；已开垦 ${tilled}/${count} 块`);
  } finally {
    setSafeMovements();
    if (activeTask === task) activeTask = null;
  }
}

async function waitForCrop(position, expectedName, task) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    assertTask(task);
    if (bot.blockAt(position)?.name === expectedName) return true;
    await bot.waitForTicks(1);
  }
  return false;
}

async function plantCrop(cropName, count) {
  const spec = cropSpec(cropName);
  if (!spec) return bot.chat("目前支持种植小麦、胡萝卜、马铃薯和甜菜。");
  const task = beginTask(`种${cropName}`);
  let planted = 0;
  try {
    while (planted < count) {
      assertTask(task);
      const seeds = bot.inventory.items().find((item) => item.name === spec.seed);
      if (!seeds) throw new Error(`背包里没有可种植的${cropName}`);
      const farmland = findFarmBlock((block) => isEmptyFarmland(block, bot.blockAt(block.position.offset(0, 1, 0))));
      if (!farmland) throw new Error("16 格内没有空闲耕地");
      await reachFarmBlock(farmland, task);
      const currentFarmland = bot.blockAt(farmland.position);
      const target = farmland.position.offset(0, 1, 0);
      if (!isEmptyFarmland(currentFarmland, bot.blockAt(target)) || isSupportingEntity(currentFarmland, bot.entity)) continue;
      await bot.equip(seeds, "hand");
      await bot.placeBlock(currentFarmland, new Vec3(0, 1, 0));
      if (!await waitForCrop(target, spec.block, task)) throw new Error(`未能确认${cropName}已经种下`);
      await bot.waitForTicks(20);
      if (bot.blockAt(target)?.name !== spec.block) throw new Error(`${cropName}种下后被踩掉，已停止以保护农田`);
      planted += 1;
    }
    bot.chat(`种好了 ${planted} 株${cropName}。`);
    remember(`种植了 ${planted} 株${cropName}`);
  } catch (error) {
    if (activeTask === task) bot.chat(`${errorMessage(error)}；已种 ${planted}/${count} 株`);
  } finally {
    setSafeMovements();
    if (activeTask === task) activeTask = null;
  }
}

async function harvestCrop(cropName, count) {
  const spec = cropSpec(cropName);
  if (!spec) return bot.chat("目前支持收割并补种小麦、胡萝卜、马铃薯和甜菜。");
  const task = beginTask(`收割${cropName}`);
  let harvested = 0;
  try {
    while (harvested < count) {
      assertTask(task);
      const seeds = bot.inventory.items().find((item) => item.name === spec.seed);
      if (!seeds) throw new Error(`至少保留 1 个可种植的${cropName}后才能收割并补种`);
      const crop = findFarmBlock((block) => isMatureCrop(block, spec));
      if (!crop) throw new Error(`16 格内没有成熟${cropName}`);
      const farmland = bot.blockAt(crop.position.offset(0, -1, 0));
      if (farmland?.name !== "farmland") continue;
      await reachFarmBlock(farmland, task);
      if (!isMatureCrop(bot.blockAt(crop.position), spec) || isSupportingEntity(farmland, bot.entity)) continue;
      const originalType = crop.type;
      await bot.dig(crop);
      if (!await confirmBlockRemoved(crop.position, originalType, task)) throw new Error("未能确认成熟小麦已收割");
      const currentSeeds = bot.inventory.items().find((item) => item.name === spec.seed);
      if (!currentSeeds) throw new Error("收割后种子尚未入包，已停止以免留下空地");
      await bot.equip(currentSeeds, "hand");
      await bot.placeBlock(farmland, new Vec3(0, 1, 0));
      if (!await waitForCrop(crop.position, spec.block, task)) throw new Error("已收割，但未能确认补种成功");
      harvested += 1;
    }
    bot.chat(`收割并补种了 ${harvested} 株${cropName}；掉落物可说“捡东西”拾取。`);
    remember(`收割并补种了 ${harvested} 株${cropName}`);
  } catch (error) {
    if (activeTask === task) bot.chat(`${errorMessage(error)}；已完成 ${harvested}/${count} 株`);
  } finally {
    setSafeMovements();
    if (activeTask === task) activeTask = null;
  }
}

async function openBoundChest(task) {
  const position = boundChestPosition();
  if (!position) throw new Error("还没有绑定箱子");
  const block = bot.blockAt(new Vec3(position.x, position.y, position.z));
  if (!block || block.name !== "chest") throw new Error("绑定位置已不再是普通箱子");
  await goNear(block.position, 3, task);
  assertTask(task);
  return bot.openContainer(block);
}

function resolveContainerNames(alias) {
  const configured = CONTAINER_ITEM_ALIASES[alias];
  if (!configured) return null;
  return Array.isArray(configured) ? configured : [configured];
}

async function listBoundChest() {
  const task = beginTask("查看绑定箱子");
  let container = null;
  try {
    container = await openBoundChest(task);
    const items = container.containerItems();
    const summary = items.slice(0, 12).map((item) => `${item.displayName}×${item.count}`).join("，") || "空";
    bot.chat(`绑定箱子：${summary}。`);
  } catch (error) {
    if (activeTask === task) bot.chat(errorMessage(error));
  } finally {
    container?.close();
    if (activeTask === task) activeTask = null;
  }
}

async function waitForContainerTransfer(container, names, inventoryBefore, containerBefore, amount, mode, task) {
  const deadline = Date.now() + 2500;
  let inventoryDelta = 0;
  let containerDelta = 0;
  while (Date.now() < deadline) {
    assertTask(task);
    const inventoryAfter = container.items().filter((item) => names.includes(item.name)).reduce((sum, item) => sum + item.count, 0);
    const containerAfter = container.containerItems().filter((item) => names.includes(item.name)).reduce((sum, item) => sum + item.count, 0);
    inventoryDelta = inventoryAfter - inventoryBefore;
    containerDelta = containerAfter - containerBefore;
    const verified = mode === "deposit"
      ? inventoryDelta === -amount && containerDelta === amount
      : inventoryDelta === amount && containerDelta === -amount;
    if (verified) return { verified, inventoryDelta, containerDelta };
    await bot.waitForTicks(1);
  }
  return { verified: false, inventoryDelta, containerDelta };
}

async function transferBoundChest(mode, alias, requested) {
  const names = resolveContainerNames(alias);
  if (!names) return bot.chat("我还不认识这个箱子物品名称。");
  const task = beginTask(mode === "deposit" ? `存入 ${alias}` : `取出 ${alias}`);
  let container = null;
  try {
    container = await openBoundChest(task);
    const sourceItems = mode === "deposit" ? container.items() : container.containerItems();
    const source = sourceItems.find((item) => names.includes(item.name));
    if (!source) throw new Error(mode === "deposit" ? `背包里没有${alias}` : `箱子里没有${alias}`);
    const available = countMatching(sourceItems, names);
    const reserveLimited = mode === "deposit" && names.some((name) => ESCAPE_BLOCKS.includes(name));
    const transferable = transferableCount({ available, totalEscapeBlocks: escapeBlockCount(), reserveLimited });
    const amount = Math.min(requested, transferable);
    if (!amount) throw new Error(`这些方块需要保留 ${ESCAPE_RESERVE} 个用于紧急脱困`);
    const inventoryBefore = container.items().filter((item) => names.includes(item.name)).reduce((sum, item) => sum + item.count, 0);
    const containerBefore = container.containerItems().filter((item) => names.includes(item.name)).reduce((sum, item) => sum + item.count, 0);
    if (mode === "deposit") await container.deposit(source.type, source.metadata, amount, source.nbt);
    else await container.withdraw(source.type, source.metadata, amount, source.nbt);
    const result = await waitForContainerTransfer(container, names, inventoryBefore, containerBefore, amount, mode, task);
    if (!result.verified) throw new Error(`箱子与背包数量变化未通过核对（背包 ${result.inventoryDelta}，箱子 ${result.containerDelta}）`);
    bot.chat(`${mode === "deposit" ? "存入" : "取出"}了 ${amount} 个${alias}。`);
    remember(`${mode === "deposit" ? "向箱子存入" : "从箱子取出"} ${alias} x${amount}`);
  } catch (error) {
    if (activeTask === task) bot.chat(errorMessage(error));
  } finally {
    container?.close();
    if (activeTask === task) activeTask = null;
  }
}

async function depositHeldStack() {
  const held = bot.heldItem;
  if (!held) return bot.chat("我手上现在没有东西。");
  const amount = transferableCount({
    available: held.count,
    totalEscapeBlocks: escapeBlockCount(),
    reserveLimited: ESCAPE_BLOCKS.includes(held.name),
  });
  if (!amount) return bot.chat(`这些方块需要保留 ${ESCAPE_RESERVE} 个用于紧急脱困。`);
  const task = beginTask(`存入手持的 ${held.displayName}`);
  let container = null;
  try {
    container = await openBoundChest(task);
    const names = [held.name];
    const inventoryBefore = container.items().filter((item) => names.includes(item.name)).reduce((sum, item) => sum + item.count, 0);
    const containerBefore = container.containerItems().filter((item) => names.includes(item.name)).reduce((sum, item) => sum + item.count, 0);
    await container.deposit(held.type, held.metadata, amount, held.nbt);
    const result = await waitForContainerTransfer(container, names, inventoryBefore, containerBefore, amount, "deposit", task);
    if (!result.verified) throw new Error(`箱子与背包数量变化未通过核对（背包 ${result.inventoryDelta}，箱子 ${result.containerDelta}）`);
    bot.chat(`把手上的 ${held.displayName}×${amount} 存进箱子了。`);
    remember(`向箱子存入手持的 ${held.displayName} x${amount}`);
  } catch (error) {
    if (activeTask === task) bot.chat(errorMessage(error));
  } finally {
    container?.close();
    if (activeTask === task) activeTask = null;
  }
}

async function giveMaterial(material, requested) {
  const names = registryNames(material);
  if (!names) return bot.chat("我还不认识这个物品名称。");
  const stacks = bot.inventory.items().filter((item) => names.includes(item.name));
  const available = stacks.reduce((sum, item) => sum + item.count, 0);
  if (!available) return bot.chat(`我身上没有${material}。`);
  const requestedNamesAreEscapeBlocks = names.some((name) => ESCAPE_BLOCKS.includes(name));
  const distributable = transferableCount({ available, totalEscapeBlocks: escapeBlockCount(), reserveLimited: requestedNamesAreEscapeBlocks });
  if (!distributable) return bot.chat(`这些方块需要保留 ${ESCAPE_RESERVE} 个用于紧急脱困。`);
  const count = Math.min(requested, distributable);
  const entity = ownerEntity();
  if (!entity) return bot.chat("我暂时看不到你，靠近我一点好吗？");
  const task = beginTask(`交付 ${material}`);
  try {
    await goNear(entity.position, 2, task);
    let remaining = count;
    for (const stack of stacks) {
      assertTask(task);
      const amount = Math.min(stack.count, remaining);
      await bot.toss(stack.type, stack.metadata, amount);
      remaining -= amount;
      if (!remaining) break;
    }
    bot.chat(`给你 ${count} 个${material}。`);
    remember(`向用户交付 ${material} x${count}`);
  } catch (error) {
    if (activeTask === task) bot.chat(errorMessage(error));
  } finally {
    if (activeTask === task) activeTask = null;
  }
}

function retreatFromDanger() {
  if (!bot || dangerRetreating || bot.health > DANGER_HEALTH) return;
  dangerRetreating = true;
  cancelTask();
  bot.chat("我生命值太低，已停止任务并撤退。");
  progress(`生命值降至 ${Math.round(bot.health)}/20，已中止任务`);
  remember("生命值过低时停止了任务并撤退");
  void retreatToSafety("生命值过低").catch((error) => progress(`自动撤退失败：${errorMessage(error)}`));
}

async function equipBestArmor(report = true) {
  const equipped = [];
  for (const [suffix, destination] of Object.entries(ARMOR_SLOTS)) {
    const armor = bestArmor(bot.inventory.items(), suffix);
    if (!armor) continue;
    await bot.equip(armor, destination);
    equipped.push(armor.displayName);
  }
  if (report) bot.chat(equipped.length ? `已穿上当前最好的护甲：${equipped.join("、")}。` : "背包里没有可穿戴护甲。");
  return equipped;
}

function scheduleArmorRefresh() {
  if (armorRefreshTimer) clearTimeout(armorRefreshTimer);
  armorRefreshTimer = setTimeout(() => {
    armorRefreshTimer = null;
    if (bot?.entity) void equipBestArmor(false).catch((error) => progress(`自动换装失败：${errorMessage(error)}`));
  }, 750);
}

function restoreSurvivalPolicy(source) {
  defending = true;
  dangerRetreating = false;
  shieldRaised = false;
  shieldRaisedAt = 0;
  setSafeMovements(false);
  resetSafeRoute();
  rememberSafeCheckpoint();
  scheduleArmorRefresh();
  progress(`${source}：已恢复安全寻路、自动换装和近身自卫`);
}

function ownerInLineOfFire(target) {
  const owner = ownerEntity();
  if (!owner) return false;
  const start = bot.entity.position.offset(0, 1.5, 0);
  const end = target.position.offset(0, Math.min(target.height || 1.6, 1.4), 0);
  const line = end.minus(start);
  const lengthSquared = line.dot(line);
  if (!lengthSquared) return false;
  const projection = Math.max(0, Math.min(1, owner.position.offset(0, 1, 0).minus(start).dot(line) / lengthSquared));
  const nearest = start.plus(line.scaled(projection));
  return projection > 0.05 && projection < 0.95 && nearest.distanceTo(owner.position.offset(0, 1, 0)) < 1.5;
}

async function fleeFromEntity(entity) {
  cancelTask();
  const away = bot.entity.position.minus(entity.position);
  const horizontal = new Vec3(away.x, 0, away.z);
  const length = Math.max(0.01, Math.hypot(horizontal.x, horizontal.z));
  const target = bot.entity.position.offset(horizontal.x / length * 6, 0, horizontal.z / length * 6);
  setSafeMovements(true);
  fleeingUntil = Date.now() + 3000;
  progress(`发现近距离苦力怕，正在拉开距离`);
  remember("发现近距离苦力怕时优先拉开距离");
  await bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 1));
}

async function raiseShield(hostile) {
  const shield = bot.inventory.items().find((item) => item.name === "shield");
  if (!shield) return false;
  await bot.equip(shield, "off-hand");
  await bot.lookAt(hostile.position.offset(0, Math.min(hostile.height || 1.6, 1.4), 0), true);
  if (!bot.usingHeldItem) bot.activateItem(true);
  shieldRaised = true;
  if (!shieldRaisedAt) shieldRaisedAt = Date.now();
  return true;
}

async function shootBow(hostile) {
  const bow = bot.inventory.items().find((item) => item.name === "bow" && durabilityRemaining(item) > MIN_TOOL_DURABILITY);
  const arrow = bot.inventory.items().find((item) => item.name === "arrow");
  if (!bow || !arrow || ownerInLineOfFire(hostile)) return false;
  await bot.equip(bow, "hand");
  await bot.lookAt(hostile.position.offset(0, Math.min(hostile.height || 1.6, 1.4), 0), true);
  bot.activateItem();
  await bot.waitForTicks(24);
  bot.deactivateItem();
  remember(`对 ${hostile.displayName || hostile.name} 进行了安全远射`);
  return true;
}

async function defendNearby() {
  if (!bot || combatBusy || !defending || bot.health <= DANGER_HEALTH || Date.now() < fleeingUntil || Date.now() - lastDefenseAt < 750) return;
  const hostile = bot.nearestEntity((entity) => isHostile(entity) && entity.position.distanceTo(bot.entity.position) <= 14);
  if (!hostile) {
    if (shieldRaised && bot.usingHeldItem) bot.deactivateItem();
    shieldRaised = false;
    shieldRaisedAt = 0;
    fleeingUntil = 0;
    return;
  }
  const distance = hostile.position.distanceTo(bot.entity.position);
  const shield = bot.inventory.items().some((item) => item.name === "shield");
  const bow = bot.inventory.items().some((item) => item.name === "bow" && durabilityRemaining(item) > MIN_TOOL_DURABILITY);
  const arrow = bot.inventory.items().some((item) => item.name === "arrow");
  const response = threatResponse({ name: hostile.name, distance, hasShield: shield, hasBow: bow, hasArrow: arrow });
  if (response === "none") {
    if (shieldRaised && bot.usingHeldItem) bot.deactivateItem();
    shieldRaised = false;
    shieldRaisedAt = 0;
    return;
  }
  combatBusy = true;
  lastDefenseAt = Date.now();
  try {
    if (response === "flee") return await fleeFromEntity(hostile);
    if (response === "shield") {
      if (shieldRaised && Date.now() - shieldRaisedAt >= 1200 && bow && arrow && !ownerInLineOfFire(hostile)) {
        if (bot.usingHeldItem) bot.deactivateItem();
        shieldRaised = false;
        shieldRaisedAt = 0;
        return await shootBow(hostile);
      }
      return await raiseShield(hostile);
    }
    if (bot.usingHeldItem) bot.deactivateItem();
    shieldRaised = false;
    shieldRaisedAt = 0;
    if (response === "bow") return await shootBow(hostile);
    const weapon = bestWeapon(bot.inventory.items());
    if (weapon && durabilityRemaining(weapon) > MIN_TOOL_DURABILITY) await bot.equip(weapon, "hand");
    await bot.lookAt(hostile.position.offset(0, Math.min(hostile.height || 1.6, 1.4), 0), true);
    await bot.attack(hostile);
    remember(`遭遇 ${hostile.displayName || hostile.name} 时进行了近身自卫`);
  } catch (error) {
    progress(`自卫失败：${errorMessage(error)}`);
  } finally {
    combatBusy = false;
  }
}

function nearbyEnvironmentBlocks() {
  const feet = bot.entity.position.floored();
  return [feet.offset(1, 0, 0), feet.offset(-1, 0, 0), feet.offset(0, 0, 1), feet.offset(0, 0, -1)]
    .map((position) => bot.blockAt(position));
}

function nearestBreathablePosition() {
  const origin = bot.entity.position.floored();
  for (let y = 0; y <= 8; y += 1) {
    for (let radius = 0; radius <= 4; radius += 1) {
      for (let x = -radius; x <= radius; x += 1) for (let z = -radius; z <= radius; z += 1) {
        const feet = origin.offset(x, y, z);
        const body = bot.blockAt(feet);
        const head = bot.blockAt(feet.offset(0, 1, 0));
        if (body?.name !== "water" && head?.name !== "water" && body?.boundingBox === "empty" && head?.boundingBox === "empty") return feet;
      }
    }
  }
  return null;
}

function escapeEnvironmentDanger() {
  if (!bot?.entity || Date.now() - lastEnvironmentEscapeAt < 1500) return;
  const feetPosition = bot.entity.position.floored();
  const danger = environmentDanger({
    oxygenLevel: bot.oxygenLevel,
    feet: bot.blockAt(feetPosition),
    head: bot.blockAt(feetPosition.offset(0, 1, 0)),
    below: bot.blockAt(feetPosition.offset(0, -1, 0)),
    neighbors: nearbyEnvironmentBlocks(),
  });
  if (!danger) return;
  lastEnvironmentEscapeAt = Date.now();
  cancelTask();
  setSafeMovements(true);
  if (danger === "drowning") {
    const target = nearestBreathablePosition();
    if (target) bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, 0));
    bot.setControlState("jump", true);
    setTimeout(() => bot?.setControlState("jump", false), 1800);
    progress("氧气过低，已中止任务并尝试上浮到可呼吸位置");
    remember("氧气过低时停止任务并尝试上浮");
    return;
  }
  const safe = [...safeRoute].reverse().find((point) => point.distanceTo(bot.entity.position) >= 3);
  if (safe) bot.pathfinder.setGoal(new goals.GoalNear(safe.x, safe.y, safe.z, 1));
  else {
    const owner = ownerEntity();
    if (owner) bot.pathfinder.setGoal(new goals.GoalNear(owner.position.x, owner.position.y, owner.position.z, 2));
  }
  progress("检测到脚下或邻近环境伤害方块，已中止任务并撤离");
  remember("检测到环境伤害方块时停止任务并撤离");
}

function requestSoulContext(request) {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingSoulContexts.delete(requestId);
      resolve({ version: 1, source: "gamebot_readonly_snapshot", persona: "", conversation: [], memories: [] });
    }, 3000);
    pendingSoulContexts.set(requestId, (context) => {
      clearTimeout(timer);
      resolve(context);
    });
    send({
      type: "soul_context_request",
      requestId,
      request: String(request).slice(0, 300),
      gameConversation: gameConversation.slice(-20),
      gameSummary: gameConversationSummary,
    });
  });
}

async function finishLlmTask(taskBrief, status, history, message, soulContext, options = {}) {
  const report = createExecutionReport(taskBrief, status, history, message);
  const soulEnabled = settings?.soul?.enabled === true;
  const shouldReplyForResult = ["failed", "step_limit", "stopped"].includes(status) || options.reportSuccess === true;
  let reply = !soulEnabled && shouldReplyForResult && options.messageIsModelReply === true ? report.message : "";
  if (soulEnabled && shouldReplyForResult) {
    const previousActionReply = options.previousActionReply
      || (currentLlmTask?.brief === taskBrief ? currentLlmTask.actionStartReply : "");
    const replyContext = previousActionReply ? { ...(soulContext || {}), previousActionReply } : soulContext;
    try { reply = await composeSoulReply(settings.soul, taskBrief, report, replyContext); }
    catch (error) {
      reply = "";
      progress(`Minecraft Soul 最终回复失败：${errorMessage(error)}`);
    }
  }
  if (reply) sendModelReply(reply);
  else if (report.message) progress(`Minecraft 任务结果：${report.message}`);
  send({ type: "llm_task_report", report });
  return report;
}

async function runLlmTask(input, options = {}) {
  const config = settings?.llm;
  if (!config?.enabled) return bot.chat("我没听懂这句话。可以换成界面里列出的精确指令，或在 GameBot 中启用 Minecraft LLM。");
  if (!config.baseUrl || !config.model) return bot.chat("Minecraft LLM 配置不完整，请在 GameBot 中填写 Base URL 和模型。");
  if (llmBusy) return bot.chat("我还在理解上一项自然语言任务；可以说“停止”取消。");
  llmBusy = true;
  autonomousLlmActive = options.autonomous === true;
  let soulContext = options.soulContext || null;
  let taskBrief;
  if (typeof input === "string" && settings?.soul?.enabled) {
    try {
      soulContext = await requestSoulContext(input);
      taskBrief = await createSoulTaskBrief(settings.soul, input, soulContext, config.maxSteps);
    } catch (error) {
      progress(`Minecraft Soul 意图理解失败，降级为执行模型直接理解：${errorMessage(error)}`);
      // 降级/无 Soul 路径：执行模型直接理解，许可集=全局 ALLOWED_ACTIONS。
      taskBrief = unconstrainedTaskBrief(input, config.maxSteps);
    }
  } else {
    taskBrief = typeof input === "string"
      ? unconstrainedTaskBrief(input, config.maxSteps)
      : normalizeReadOnlyTaskBrief(input, config.maxSteps);
  }
  if (!taskBrief) {
    progress("Minecraft 拒绝了无效或越界的只读 TaskBrief");
    llmBusy = false;
    autonomousLlmActive = false;
    return;
  }
  if (!llmBusy || stopping) {
    llmBusy = false;
    autonomousLlmActive = false;
    return;
  }
  const userMessage = taskBrief.request;
  const serial = ++llmSerial;
  const history = [];
  let startReplyStarted = false;
  let reportSuccessfulResult = false;
  currentLlmTask = { brief: taskBrief, history, soulContext, actionStartReply: "", plan: null };
  try {
    if (taskBrief.source === "cyrene_soul_readonly" && taskBrief.constraints.allowedActions.length === 0) {
      await finishLlmTask(taskBrief, "completed", history, "这项请求不需要执行游戏动作，请直接回应用户。", soulContext, {
        reportSuccess: true,
      });
      remember(`自然语言任务“${String(userMessage).slice(0, 80)}”无需游戏动作`);
      return;
    }
    const plan = await requestPlan(config, { taskBrief, world: compactWorldState() }, parseCommand);
    if (serial !== llmSerial || stopping) return;
    currentLlmTask.plan = plan;
    if (plan.reply) progress(`Minecraft 执行模型：${plan.reply}`);
    progress(`Minecraft 任务计划：${plan.steps.map((step) => step.command).join(" → ") || "无需游戏动作"}`);
    if (!plan.steps.length) {
      await finishLlmTask(taskBrief, "completed", history, plan.reply, soulContext, {
        messageIsModelReply: true,
        reportSuccess: true,
      });
      remember(`自然语言任务“${String(userMessage).slice(0, 80)}”无需游戏动作`);
      return;
    }
    for (let stepIndex = 0; stepIndex < plan.steps.length; stepIndex += 1) {
      const planStep = plan.steps[stepIndex];
      planStep.status = "running";
      progress(`Minecraft 执行计划 ${stepIndex + 1}/${plan.steps.length}：${planStep.command}`);
      if (options.autonomous === true) {
        const issue = autonomousActionIssue(planStep.action);
        if (issue) {
          const result = `自主安全策略拒绝：${issue}`;
          planStep.status = "failed";
          history.push({ step: stepIndex + 1, command: planStep.command, result });
          await finishLlmTask(taskBrief, "failed", history, result, soulContext);
          return;
        }
      }
      let startReplyPromise = null;
      if (!startReplyStarted && settings?.soul?.enabled && shouldReplyAtActionStart(planStep.action)) {
        startReplyStarted = true;
        startReplyPromise = composeActionStartReply(settings.soul, taskBrief, planStep, soulContext)
          .then((reply) => {
            if (serial === llmSerial && !stopping) {
              if (currentLlmTask?.brief === taskBrief) currentLlmTask.actionStartReply = reply;
              sendModelReply(reply);
            }
          })
          .catch((error) => progress(`Minecraft Soul 动作开始回复失败：${errorMessage(error)}`));
      }
      lastBotChat = "";
      await handleOwnerCommand(planStep.command, { fromPlanner: true });
      if (startReplyPromise) await startReplyPromise;
      await waitForBotResult();
      if (serial !== llmSerial || stopping) return;
      const actionResult = lastBotChat || "指令已返回；请根据最新世界状态核验实际结果";
      history.push({
        step: stepIndex + 1,
        command: planStep.command,
        result: actionResult,
      });
      if (isFailedActionResult(actionResult)) {
        planStep.status = "failed";
        await finishLlmTask(taskBrief, "failed", history, actionResult, soulContext);
        remember(`自然语言任务“${String(userMessage).slice(0, 80)}”执行失败：${actionResult}`);
        return;
      }
      planStep.status = "succeeded";
      reportSuccessfulResult ||= shouldReportSuccess(planStep.action);
    }
    const allRequiredStepsSucceeded = plan.steps.every((step) => step.status === "succeeded");
    if (!allRequiredStepsSucceeded) throw new Error("任务完成门拒绝：仍有未成功步骤");
    const finalStatus = plan.lifecycle === "persistent" ? "active" : "completed";
    const finalMessage = plan.lifecycle === "persistent" ? "持续任务已经建立并处于活动状态" : history.at(-1)?.result || "计划全部完成";
    await finishLlmTask(taskBrief, finalStatus, history, finalMessage, soulContext, {
      reportSuccess: plan.lifecycle === "finite" && reportSuccessfulResult,
    });
    remember(`自然语言任务“${String(userMessage).slice(0, 80)}”${finalStatus === "active" ? "进入持续活动状态" : "完成全部计划步骤"}`);
  } catch (error) {
    const planningError = errorMessage(error);
    progress(`Minecraft LLM 规划失败：${planningError}`);
    const failureMessage = /计划偏离任务允许动作/.test(planningError)
      ? "执行模型生成了不在本次意图许可范围内的动作；安全校验已阻止执行，世界没有因此被修改。"
      : "我暂时没能把这项自然语言请求整理成可安全执行的计划；世界没有因此被修改。";
    await finishLlmTask(taskBrief, "failed", history, failureMessage, soulContext);
  } finally {
    if (currentLlmTask?.brief === taskBrief) currentLlmTask = null;
    if (serial === llmSerial) {
      llmBusy = false;
      autonomousLlmActive = false;
    }
  }
}

async function handleOwnerCommand(message, options = {}) {
  const command = parseCommand(message);
  if (command.type === "stop") {
    if (currentLlmTask) {
      await finishLlmTask(currentLlmTask.brief, "stopped", currentLlmTask.history, "用户要求停止", currentLlmTask.soulContext);
      currentLlmTask = null;
    }
    llmSerial += 1;
    llmBusy = false;
    cancelTask();
    if (!settings?.soul?.enabled) bot.chat("好，我停下来了。");
    remember("用户让昔涟停止行动");
    return;
  }
  if (bot.game?.dimension && bot.game.dimension !== "overworld") {
    cancelTask();
    return bot.chat("现阶段只支持主世界；请先把我带回主世界再行动。 ");
  }
  if (command.type === "observe") {
    const observation = await requestVisionObservation(command.focus || message);
    if (typeof observation === "string" && observation.trim()) {
      const answer = observation.replace(/\s+/g, " ").trim().slice(0, 220);
      if (options.fromPlanner) bot.chat(answer);
      else sendModelReply(answer);
      remember(`通过第三视角观察：${answer}`);
      return;
    }
    if (observation?.sceneSummary) {
      const answer = `${observation.sceneSummary}${observation.userActivity && observation.userActivity !== "未知" ? `；你看起来${observation.userActivity}` : ""}`.slice(0, 220);
      if (options.fromPlanner) bot.chat(answer);
      else sendModelReply(answer);
      remember(`通过第三视角观察：${answer}`);
      return;
    }
    bot.chat("第三视角暂时不可用；我只能确认当前生命、背包和附近方块等结构化状态。");
    return;
  }
  if (command.type === "equip_armor") return equipBestArmor(true);
  if (command.type === "defend") {
    defending = !defending;
    bot.chat(defending ? "已开启近身自卫；只攻击 4 格内的敌对生物，低血量仍优先撤退。" : "已关闭主动自卫。");
    return;
  }
  if (command.type === "follow") {
    const entity = ownerEntity();
    if (!entity) return bot.chat("我暂时看不到你，靠近我一点好吗？");
    const task = beginTask("跟随");
    bot.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true);
    bot.chat("好呀，我跟着你。");
    remember("开始跟随用户");
    return task;
  }
  if (command.type === "explore_follow") {
    const entity = ownerEntity();
    if (!entity) return bot.chat("我暂时看不到你，靠近我一点好吗？");
    resetSafeRoute();
    const task = beginTask("跟随探索");
    bot.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true);
    bot.chat("好，我跟着你探索并记录回程点。需要时说“撤退”。");
    remember("开始跟随用户探索并记录安全路线");
    return task;
  }
  if (command.type === "come") {
    cancelTask();
    const entity = ownerEntity();
    if (!entity) return bot.chat("我暂时看不到你。");
    if (!safeRoute.length) rememberSafeCheckpoint();
    bot.chat("我来啦。");
    remember("前往用户所在位置");
    // 计划循环以本函数返回作为“步骤完成”：come 原先只挂寻路目标就立即返回，
    // 后续的 set_home 等步骤会读到 bot 半路坐标（家点落在错误位置的根因）。
    // 这里等待到达（封顶 90s、尽力而为）；直接聊天指令走 fire-and-forget 路径，应答不受影响。
    const goal = new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 1);
    const arrive = (async () => {
      try {
        await bot.pathfinder.goto(goal);
      } catch {
        try {
          // 路线被关着的门挡住时，自助开门后重规划一次（与 goNear 同策）。
          if (await openNearbyClosedDoors() > 0) await bot.pathfinder.goto(goal);
        } catch { /* 仍到不了则尽力而为，由后续步骤按最新状态核验 */ }
      }
    })();
    await Promise.race([arrive, new Promise((resolve) => setTimeout(resolve, 90_000))]);
    return;
  }
  if (command.type === "set_home") {
    saveHome(bot.entity.position);
    bot.chat(`记住这里了：${bot.entity.position.floored()}`);
    remember("设置了家点");
    return;
  }
  if (command.type === "home") {
    const home = homePosition();
    if (!home) return bot.chat("还没有家点，先对我说“设置家”。");
    const task = beginTask("回家", { allowLowHealth: true });
    bot.chat("我回家点啦。");
    try {
      await goNear(home, 1, task);
      remember("返回了家点");
    } catch (error) {
      if (activeTask === task) bot.chat(errorMessage(error));
    } finally {
      if (activeTask === task) activeTask = null;
    }
    return;
  }
  if (command.type === "pickup") return pickUpNearby();
  if (command.type === "escape") return escapeShallowPit();
  if (command.type === "retreat") return retreatToSafety();
  if (command.type === "platform") return buildSmallPlatform();
  if (command.type === "shelter") return buildShelter();
  if (command.type === "craft") return craftItem(command.item, command.count);
  if (command.type === "place_table") return placeCraftingTable();
  if (command.type === "place_furnace") return placeUtilityBlock("furnace", "furnace", "熔炉");
  if (command.type === "place_chest") return placeUtilityBlock("chest", "chest", "箱子");
  if (command.type === "place_bed") return placeAndBindBed();
  if (command.type === "place_torch") return placeTorch();
  if (command.type === "door") return setNearestDoor(command.open);
  if (command.type === "equip_shield") return equipShield();
  if (command.type === "hold_item") return holdInventoryItem(command.item);
  if (command.type === "fish") return fishOnce();
  if (command.type === "fill_water") return fillWaterBucket();
  if (command.type === "place_water") return placeWaterBucket();
  if (command.type === "milk_cow") return milkNearestCow();
  if (command.type === "breed") return breedAnimals(command.animal);
  if (command.type === "shear_sheep") return shearNearestSheep();
  if (command.type === "recover_death") return recoverDeathItems();
  if (command.type === "place_boat") return placeBoat();
  if (command.type === "mount_boat") return mountNearestBoat();
  if (command.type === "dismount") return dismountVehicle();
  if (command.type === "list_trades") return listVillagerTrades();
  if (command.type === "trade") return executeVillagerTrade(command.index);
  if (command.type === "enchant") return enchantHeldItem(command.choice);
  if (command.type === "rename") return renameHeldItem(command.name);
  if (command.type === "bind_chest") return bindNearestChest();
  if (command.type === "list_chest") return listBoundChest();
  if (command.type === "bind_bed") return bindNearestBed();
  if (command.type === "sleep") return sleepInBoundBed();
  if (command.type === "wake") return wakeFromBed();
  if (command.type === "eat") return eatIfNeeded(true);
  if (command.type === "till") return tillFarmland(command.count);
  if (command.type === "plant_crop") return plantCrop(command.crop, command.count);
  if (command.type === "harvest_crop") return harvestCrop(command.crop, command.count);
  if (command.type === "smelt") return smeltItems(command.item, command.count);
  if (command.type === "deposit") return transferBoundChest("deposit", command.item, command.count);
  if (command.type === "deposit_held") return depositHeldStack();
  if (command.type === "withdraw") return transferBoundChest("withdraw", command.item, command.count);
  if (command.type === "collect") return collectMaterial(command.material, command.count);
  if (command.type === "mine_ore") return mineExposedOre(command.material, command.count);
  if (command.type === "tunnel") return digHorizontalTunnel(command.count);
  if (command.type === "give") return giveMaterial(command.material, command.count);
  if (command.type === "give_held") {
    const held = bot.heldItem;
    if (!held) return bot.chat("我手上现在没有东西呢。");
    if (ESCAPE_BLOCKS.includes(held.name)) {
      const amount = transferableCount({ available: held.count, totalEscapeBlocks: escapeBlockCount(), reserveLimited: true });
      if (!amount) return bot.chat(`这 ${ESCAPE_RESERVE} 个方块要留作紧急脱困。`);
      await bot.toss(held.type, held.metadata, amount);
      bot.chat("给你。");
      remember(`向用户交付 ${held.name} x${amount}`);
      return;
    }
    await bot.tossStack(held);
    bot.chat("给你。");
    remember(`向用户交付 ${held.name} x${held.count}`);
    return;
  }
  if (command.type === "status") {
    const task = activeTask ? `，任务：${activeTask.name}` : "，目前空闲";
    bot.chat(`生命 ${Math.round(bot.health)}/20，饥饿 ${Math.round(bot.food)}/20，坐标 ${bot.entity.position.floored()}${task}`);
  }
  if (command.type === "inventory") {
    const items = bot.inventory.items();
    const summary = items.slice(0, 8).map((item) => `${item.displayName}×${item.count}`).join("，") || "空";
    const tools = items.filter((item) => item.maxDurability).slice(0, 4)
      .map((item) => `${item.displayName}耐久${durabilityRemaining(item)}/${item.maxDurability}`).join("，");
    bot.chat(`背包：${summary}；脱困方块 ${escapeBlockCount()} 个（保留 ${ESCAPE_RESERVE} 个）${tools ? `；工具：${tools}` : ""}。`);
    return;
  }
  if (command.type === "unknown" && !options.fromPlanner) return runLlmTask(message);
}

function connect() {
  stopping = false;
  gamebotAppearance = { skinVersion: "unknown", description: "" };
  bot = mineflayer.createBot({
    host: settings.host,
    port: settings.port,
    username: settings.username,
    auth: settings.auth,
    version: settings.version || false,
    profilesFolder: settings.profilesFolder,
    onMsaCode: (data) => {
      const url = data.verification_uri_complete || data.verification_uri || "https://www.microsoft.com/link";
      progress(`Microsoft 登录：请打开 ${url} 并输入代码 ${data.user_code}`);
    },
  });
  bot.loadPlugin(pathfinder);
  bot._client.on("set_passengers", (packet) => reconcileOwnVehicle(bot, packet));
  bot.once("spawn", () => {
    const sendMinecraftChat = bot.chat.bind(bot);
    chatOutput = createChatOutput({ sendChat: sendMinecraftChat, log: progress });
    bot.chat = (message) => {
      lastBotChat = chatOutput.internal(message);
    };
    if (!spawnedAt) spawnedAt = Date.now();
    reconnects = 0;
    restoreSurvivalPolicy("Minecraft 已出生");
    progress(`Minecraft 已登录：${bot.username} @ ${settings.host}:${settings.port}`);
    remember("昔涟进入了服务器");
    if (settings?.autonomy?.visionEnabled) {
      startThirdPersonViewer(bot, { viewDistance: 4 }).then((service) => {
        viewerService = service;
        send({ type: "viewer_ready", viewerUrl: service.url });
        progress("Minecraft 第三视角观察已就绪");
      }).catch((error) => progress(`Minecraft 第三视角启动失败，改用结构化感知：${errorMessage(error)}`));
    }
    startAutonomyLoop();
  });
  bot.on("health", () => {
    if (bot.health > DANGER_HEALTH + 2) dangerRetreating = false;
    retreatFromDanger();
    void eatIfNeeded();
  });
  bot.on("physicsTick", () => {
    if (activeTask?.name === "跟随探索") rememberSafeCheckpoint();
    escapeEnvironmentDanger();
    void defendNearby();
    void autoLightIfNeeded();
  });
  bot.on("time", () => { void autoSleepIfSafe(); });
  bot.on("playerJoined", (player) => {
    players.add(player.username);
    progress(`${player.username} 加入了游戏`);
  });
  bot.on("playerLeft", (player) => progress(`${player.username} 离开了游戏`));
  bot.on("playerCollect", (collector) => {
    if (collector === bot.entity) scheduleArmorRefresh();
  });
  bot.on("respawn", () => restoreSurvivalPolicy("Minecraft 已重生"));
  bot.on("chat", (username, message, translate, jsonMessage) => {
    const ownerCommandFeedback = username === settings.owner
      && isPlayerCommandFeedback(message, translate, jsonMessage);
    progress(ownerCommandFeedback ? `<${username} [游戏指令反馈]> ${message}` : `<${username}> ${message}`);
    if (ownerCommandFeedback) {
      recordGameChat("other", "Minecraft系统（用户指令反馈）", commandFeedbackContext(message));
      remember(`用户执行游戏指令后的系统反馈：${message}`);
      lastUserAt = Date.now();
      lastAutonomyAt = Date.now();
      autonomyDelayIndex = 0;
      return;
    }
    if (username === bot.username) {
      lastBotChat = String(message).slice(0, 240);
      recordGameChat("assistant", username, message);
    } else if (username === settings.owner) {
      recordGameChat("user", username, message);
    } else {
      recordGameChat("other", username, message);
    }
    if (username === settings.owner) {
      lastUserAt = Date.now();
      lastAutonomyAt = Date.now();
      autonomyDelayIndex = 0;
      if (autonomousLlmActive) {
        llmSerial += 1;
        llmBusy = false;
        autonomousLlmActive = false;
        currentLlmTask = null;
        cancelTask();
        progress("用户消息已抢占当前自主目标");
      }
      remember(`用户说：${message}`);
      Promise.resolve(handleOwnerCommand(message)).catch((error) => progress(`指令失败：${errorMessage(error)}`));
    }
  });
  bot.on("death", () => {
    lastDeathPosition = bot.entity?.position?.clone?.() || bot.entity?.position || null;
    cancelTask();
    progress("昔涟在 Minecraft 中死亡");
    remember("昔涟死亡了一次");
  });
  bot.on("kicked", (reason) => progress("Minecraft 被服务器断开：" + String(reason)));
  bot.on("error", (error) => progress("Minecraft 错误：" + errorMessage(error)));
  bot.once("end", () => {
    if (autonomyTimer) clearInterval(autonomyTimer);
    autonomyTimer = null;
    viewerService?.close?.();
    viewerService = null;
    bot = null;
    if (!stopping && settings.reconnect && reconnects < 3) {
      reconnects += 1;
      progress(`连接中断，5 秒后重连（${reconnects}/3）`);
      setTimeout(connect, 5000);
    } else {
      finish();
    }
  });
}

function finish() {
  if (!startedAt || !spawnedAt) return process.exit(0);
  const endedAt = Date.now();
  const minutes = Math.max(1, Math.round((endedAt - startedAt) / 60000));
  const details = highlights.length ? highlights.slice(-20).join("；") : "完成了一次联机会话";
  send({
    type: "session_draft",
    startedAt,
    endedAt,
    serverLabel: `${settings.host}:${settings.port}`,
    players: [...players],
    durationMinutes: minutes,
    highlights: highlights.slice(-30),
    conversationSummary: gameConversationSummary,
    recentConversation: gameConversation.slice(-30),
    fallbackSummary: `与用户进行了一次约 ${minutes} 分钟的 Minecraft 联机。${details}。`,
  });
  setTimeout(() => process.exit(0), 100);
}

process.on("message", (message) => {
  if (message?.type === "start" && !bot) {
    settings = message.settings;
    startedAt = Date.now();
    progress("正在启动 Minecraft 联机玩家……");
    connect();
  }
  if (message?.type === "llm_task_brief" && bot) {
    Promise.resolve(runLlmTask(message.taskBrief)).catch((error) => progress(`只读 TaskBrief 执行失败：${errorMessage(error)}`));
  }
  if (message?.type === "soul_context_response" && typeof message.requestId === "string") {
    const resolve = pendingSoulContexts.get(message.requestId);
    if (resolve) {
      pendingSoulContexts.delete(message.requestId);
      resolve(message.context);
    }
  }
  if (message?.type === "vision_response" && typeof message.requestId === "string") {
    const resolve = pendingVision.get(message.requestId);
    if (resolve) {
      pendingVision.delete(message.requestId);
      if (message.observation && typeof message.observation === "object") {
        const version = skinVersion(bot?.players?.[bot?.username]);
        gamebotAppearance = refreshAppearance(gamebotAppearance, version);
        gamebotAppearance = acceptAppearance(gamebotAppearance, version, message.observation.gamebotAppearance);
      }
      resolve(message.observation || null);
    }
  }
  if (message?.type === "autonomy_update" && settings) updateAutonomy(message.autonomy);
  if (message?.type === "stop") {
    stopping = true;
    cancelTask();
    if (bot) bot.quit("Cyrene GameBot stopped");
    else finish();
  }
});

process.on("SIGTERM", () => {
  stopping = true;
  cancelTask();
  if (bot) bot.quit("Cyrene GameBot stopped");
  else finish();
});
