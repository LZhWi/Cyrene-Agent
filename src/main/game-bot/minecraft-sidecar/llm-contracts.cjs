"use strict";

const TASK_SOURCES = new Set(["minecraft_game_chat", "cyrene_soul_readonly"]);
const HINT_KINDS = new Set(["persona", "conversation", "memory"]);
const ALLOWED_ACTIONS = new Set([
  "follow", "explore_follow", "come", "status", "observe", "inventory", "set_home", "home", "pickup", "escape", "retreat",
  "platform", "shelter", "place_table", "place_furnace", "place_chest", "bind_chest", "list_chest", "deposit_held",
  "bind_bed", "place_bed", "sleep", "wake", "eat", "equip_armor", "equip_shield", "hold_item", "place_torch",
  "door", "fish", "fill_water", "place_water", "milk_cow", "breed", "shear_sheep", "recover_death", "place_boat",
  "mount_boat", "dismount", "list_trades", "trade", "enchant", "rename", "till", "plant_crop", "harvest_crop",
  "smelt", "deposit", "withdraw", "craft", "mine_ore", "tunnel", "collect", "give", "give_held",
]);
const PERSISTENT_TERMINAL_ACTIONS = new Set(["follow", "explore_follow"]);
const READ_ONLY_TERMINAL_ACTIONS = new Set(["status", "observe", "inventory", "list_chest", "list_trades"]);
const TERMINAL_ACTIONS = new Set([...PERSISTENT_TERMINAL_ACTIONS, ...READ_ONLY_TERMINAL_ACTIONS]);
const SILENT_SUCCESS_ACTIONS = new Set([
  "follow", "explore_follow", "come", "door", "eat", "equip_armor", "equip_shield", "hold_item",
  "sleep", "wake", "mount_boat", "dismount",
]);
const SILENT_START_ACTIONS = new Set([
  ...READ_ONLY_TERMINAL_ACTIONS,
  "door", "eat", "equip_armor", "equip_shield", "hold_item", "sleep", "wake", "mount_boat", "dismount",
]);

function boundedMaxSteps(value, maximum = 8) {
  const parsed = Number(value);
  const safeMaximum = Math.max(1, Math.min(Number(maximum) || 6, 8));
  return Number.isFinite(parsed) ? Math.max(1, Math.min(Math.trunc(parsed), safeMaximum)) : safeMaximum;
}

function normalizeContextHints(value) {
  return (Array.isArray(value) ? value : []).slice(0, 6).flatMap((hint) => {
    if (!hint || typeof hint !== "object" || Array.isArray(hint)) return [];
    const kind = HINT_KINDS.has(hint.kind) ? hint.kind : null;
    const text = typeof hint.text === "string" ? hint.text.trim().slice(0, 160) : "";
    return kind && text ? [{ kind, text }] : [];
  });
}

function normalizeAllowedActions(value) {
  return Array.from(new Set((Array.isArray(value) ? value : [])
    .filter((action) => typeof action === "string" && ALLOWED_ACTIONS.has(action)))).slice(0, 10);
}

function normalizeRequiredActions(value, allowedActions) {
  const allowed = new Set(allowedActions);
  return normalizeAllowedActions(value).filter((action) => allowed.has(action)).slice(0, 6);
}

function createTaskBrief(request, maxSteps, options = {}) {
  const source = TASK_SOURCES.has(options.source) ? options.source : "minecraft_game_chat";
  const allowedActions = normalizeAllowedActions(options.allowedActions);
  return {
    version: 1,
    source,
    request: String(request || "").trim().slice(0, 300),
    constraints: {
      overworldOnly: true,
      deterministicSkillsOnly: true,
      maxSteps: boundedMaxSteps(maxSteps, 8),
      allowedActions,
      requiredActions: normalizeRequiredActions(options.requiredActions, allowedActions),
    },
    // These hints are distilled, read-only context. The GameBot side never
    // reads conversation history or memory directly.
    contextHints: normalizeContextHints(options.contextHints),
  };
}

function normalizeReadOnlyTaskBrief(value, configuredMaxSteps) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.version !== 1 || value.source !== "cyrene_soul_readonly") return null;
  const request = typeof value.request === "string" ? value.request.trim().slice(0, 300) : "";
  if (!request) return null;
  return createTaskBrief(request, boundedMaxSteps(value.constraints?.maxSteps, configuredMaxSteps), {
    source: "cyrene_soul_readonly",
    contextHints: value.contextHints,
    allowedActions: value.constraints?.allowedActions,
    requiredActions: value.constraints?.requiredActions,
  });
}

// 确定性蕴含补全表：Soul 是意见型意图层，可能漏授完成目标所需的周边动作（如“放入箱子”漏授 list_chest），
// 导致 planner 合理规划被 allowedActions 卡死。按 request 关键词对 allowedActions 做只增不删的并集补全。
// 真正的安全边界仍是全局 ALLOWED_ACTIONS + 运行时门；这里只是把沙箱圈画完整。
// 模式一律用双字词组起步，避免单字（如“树”命中“地方”）造成误补。
const ACTION_IMPLICATION_RULES = [
  { pattern: /(砍树|砍伐|伐木|砍木|砍柴|采集原木|采集木头|采集木材|收集原木|收集木头|收集木材|获取原木|获取木头|挖树)/, actions: ["collect"] },
  { pattern: /(采矿|挖矿|矿石|矿洞)/, actions: ["mine_ore"] },
  { pattern: /(掘进|巷道|隧道)/, actions: ["tunnel"] },
  { pattern: /(箱子|存入|放进|存放|收纳|装进)/, actions: ["place_chest", "bind_chest", "list_chest", "deposit", "deposit_held"] },
  { pattern: /(取出|拿去|从箱子拿)/, actions: ["bind_chest", "list_chest", "withdraw"] },
  { pattern: /(合成|制作|打造)/, actions: ["craft", "place_table"] },
  { pattern: /(烧炼|冶炼|烧烤|烧制)/, actions: ["smelt", "place_furnace"] },
  { pattern: /(种植|耕地|开垦|农田|作物|播种|收割)/, actions: ["till", "plant_crop", "harvest_crop"] },
  { pattern: /(睡觉|过夜|休息一晚)/, actions: ["bind_bed", "place_bed", "sleep"] },
  { pattern: /(安家|家点|设家|定居)/, actions: ["set_home"] },
  { pattern: /(过来|来我这|到我这里|到我身边)/, actions: ["come"] },
  { pattern: /钓鱼/, actions: ["fish"] },
  { pattern: /(交易|村民)/, actions: ["list_trades", "trade"] },
  { pattern: /(避难所|小屋|盖房|建房)/, actions: ["shelter"] },
  { pattern: /(平台|垫高)/, actions: ["platform"] },
  { pattern: /(给我|交给我)/, actions: ["give", "give_held"] },
];

function augmentAllowedActionsFromRequest(request, allowedActions) {
  const text = String(request || "");
  const completed = new Set(allowedActions);
  for (const rule of ACTION_IMPLICATION_RULES) {
    if (!rule.pattern.test(text)) continue;
    for (const action of rule.actions) {
      if (ALLOWED_ACTIONS.has(action)) completed.add(action);
    }
  }
  // 上限 12：Soul 原授权在前，补全项紧随其后；略宽于 Soul 侧的 10 项上限，
  // 避免原授权占满名额后把完成目标必需的补全动作裁掉。
  return Array.from(completed).slice(0, 12);
}

function augmentTaskBriefActions(brief, additionalRequestText = "") {
  const constraints = brief?.constraints;
  if (!brief || !constraints) return brief;
  const allowedActions = Array.isArray(constraints.allowedActions) ? constraints.allowedActions : [];
  const requiredActions = Array.isArray(constraints.requiredActions) ? constraints.requiredActions : [];
  // observe-only 任务（纯聊天/纯观察评价）不碰：requiredActions 全为只读终态动作时跳过。
  const hasActiveGoal = requiredActions.some((action) => !READ_ONLY_TERMINAL_ACTIONS.has(action));
  if (!allowedActions.length || !hasActiveGoal) return brief;
  // 补全同时匹配 Soul 改写后的 request 与用户原话：Soul 改写可能丢掉“箱子”等关键词，
  // 只看改写稿会让蕴含补全漏触发。
  const expanded = augmentAllowedActionsFromRequest(`${brief.request}\n${additionalRequestText}`, allowedActions);
  if (expanded.length === allowedActions.length && expanded.every((action, index) => action === allowedActions[index])) return brief;
  return { ...brief, constraints: { ...constraints, allowedActions: expanded } };
}

function createExecutionReport(task, status, steps, message) {
  const safeStatus = ["active", "completed", "stopped", "failed", "step_limit"].includes(status) ? status : "failed";
  return {
    version: 1,
    source: "minecraft_gamebot",
    request: String(task?.request || "").slice(0, 300),
    status: safeStatus,
    message: String(message || "").slice(0, 240),
    steps: (Array.isArray(steps) ? steps : []).slice(-8).map((step) => ({
      command: String(step?.command || "").slice(0, 80),
      result: String(step?.result || "").slice(0, 240),
    })),
  };
}

function isTerminalAction(action, taskBrief) {
  const type = String(action || "");
  if (PERSISTENT_TERMINAL_ACTIONS.has(type)) return true;
  if (!READ_ONLY_TERMINAL_ACTIONS.has(type)) return false;
  const allowedActions = Array.isArray(taskBrief?.constraints?.allowedActions)
    ? taskBrief.constraints.allowedActions : [];
  return allowedActions.length > 0 && allowedActions.every((allowed) => READ_ONLY_TERMINAL_ACTIONS.has(allowed));
}

function shouldReportSuccess(action) {
  return !SILENT_SUCCESS_ACTIONS.has(String(action?.type || action || ""));
}

function shouldReplyAtActionStart(action) {
  return !SILENT_START_ACTIONS.has(String(action?.type || action || ""));
}

function isFailedActionResult(result) {
  const text = String(result || "").trim();
  if (/暂时不可用|当前不可用/.test(text)) return true;
  return /(?:失败|无法|未能|暂时看不到|找不到|没有找到|没有可用|没有足够|背包里没有|需要至少|需要一把|超过.+上限|暂不支持|不支持|不是浅坑|不认识|还没有(?:家点|绑定)|周围没有|附近没有|生命值过低|任务已停止|安全策略拒绝)/.test(text);
}

module.exports = { ALLOWED_ACTIONS, SILENT_START_ACTIONS, SILENT_SUCCESS_ACTIONS, TERMINAL_ACTIONS, ACTION_IMPLICATION_RULES, augmentAllowedActionsFromRequest, augmentTaskBriefActions, createExecutionReport, createTaskBrief, isFailedActionResult, isTerminalAction, normalizeAllowedActions, normalizeContextHints, normalizeReadOnlyTaskBrief, normalizeRequiredActions, shouldReplyAtActionStart, shouldReportSuccess };
