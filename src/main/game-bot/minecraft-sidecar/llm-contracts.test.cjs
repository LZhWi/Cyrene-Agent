"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { augmentAllowedActionsFromRequest, augmentTaskBriefActions, createExecutionReport, createTaskBrief, isFailedActionResult, isTerminalAction, normalizeReadOnlyTaskBrief, shouldReplyAtActionStart, shouldReportSuccess } = require("./llm-contracts.cjs");

test("creates an isolated GameBot task brief without chat history", () => {
  const brief = createTaskBrief(" 帮我弄点木头 ", 99);
  assert.equal(brief.request, "帮我弄点木头");
  assert.equal(brief.constraints.maxSteps, 8);
  assert.equal(brief.constraints.overworldOnly, true);
  assert.deepEqual(brief.contextHints, []);
  assert.equal("conversationHistory" in brief, false);
});

test("reports meaningful results but keeps low-impact successes silent", () => {
  assert.equal(shouldReportSuccess("collect"), true);
  assert.equal(shouldReportSuccess("shelter"), true);
  assert.equal(shouldReportSuccess("status"), true);
  assert.equal(shouldReportSuccess("follow"), false);
  assert.equal(shouldReportSuccess("door"), false);
  assert.equal(shouldReportSuccess("eat"), false);
});

test("keeps atomic utility actions silent from start to successful finish", () => {
  for (const action of ["door", "eat", "equip_armor", "equip_shield", "hold_item", "sleep", "wake", "mount_boat", "dismount"]) {
    assert.equal(shouldReplyAtActionStart(action), false);
    assert.equal(shouldReportSuccess(action), false);
  }
  assert.equal(shouldReplyAtActionStart("follow"), true);
  assert.equal(shouldReplyAtActionStart("collect"), true);
});

test("waits for real results before replying to read-only actions", () => {
  for (const action of ["status", "observe", "inventory", "list_chest", "list_trades"]) {
    assert.equal(shouldReplyAtActionStart(action), false);
    assert.equal(shouldReportSuccess(action), true);
  }
});

test("recognizes concrete execution failures without treating success details as failures", () => {
  assert.equal(isFailedActionResult("第三视角暂时不可用；只能读取结构化状态"), true);
  assert.equal(isFailedActionResult("附近没有安全的放置位置。"), true);
  assert.equal(isFailedActionResult("背包里没有工作台。"), true);
  assert.equal(isFailedActionResult("泥土已挖完；没有自动入包的掉落物可以捡东西拾取。"), false);
  assert.equal(isFailedActionResult("已经开始跟随。"), false);
});

test("finishes read-only and established persistent actions without a second model call", () => {
  assert.equal(isTerminalAction("status", { constraints: { allowedActions: ["status"] } }), true);
  assert.equal(isTerminalAction("inventory", { constraints: { allowedActions: ["inventory"] } }), true);
  assert.equal(isTerminalAction("follow"), true);
  assert.equal(isTerminalAction("explore_follow"), true);
  assert.equal(isTerminalAction("collect"), false);
});

test("continues planning when a read-only action is only an intermediate step", () => {
  const collectTask = { constraints: { allowedActions: ["observe", "collect"] } };
  const chestTask = { constraints: { allowedActions: ["list_chest", "withdraw"] } };
  assert.equal(isTerminalAction("observe", collectTask), false);
  assert.equal(isTerminalAction("list_chest", chestTask), false);
  assert.equal(isTerminalAction("observe", { constraints: { allowedActions: ["observe"] } }), true);
});

test("completes implied peripheral actions without removing Soul grants", () => {
  assert.deepEqual(
    augmentAllowedActionsFromRequest("把木头放进箱子", ["collect", "deposit"]),
    ["collect", "deposit", "place_chest", "bind_chest", "list_chest", "deposit_held"],
  );
  assert.deepEqual(augmentAllowedActionsFromRequest("先来我这里安家", ["set_home"]), ["set_home", "come"]);
  // 无关键词命中时原样返回；12 项上限下 Soul 原授权优先保留，补全项填入剩余名额。
  assert.deepEqual(augmentAllowedActionsFromRequest("到处转转", ["explore_follow"]), ["explore_follow"]);
  const padded = Array.from({ length: 10 }, (_, index) => `extra${index}`);
  assert.deepEqual(augmentAllowedActionsFromRequest("合成工作台", padded), [...padded, "craft", "place_table"]);
  // 原授权占满 12 项名额时，多出的补全项才被裁掉。
  const overPadded = Array.from({ length: 11 }, (_, index) => `extra${index}`);
  assert.deepEqual(augmentAllowedActionsFromRequest("合成工作台", overPadded), [...overPadded, "craft"]);
});

test("augments task briefs only when an active goal exists", () => {
  const brief = {
    version: 1, source: "cyrene_soul_readonly", request: "把原木存入箱子",
    constraints: { overworldOnly: true, deterministicSkillsOnly: true, maxSteps: 5, allowedActions: ["collect", "deposit"], requiredActions: ["deposit"] },
    contextHints: [],
  };
  const augmented = augmentTaskBriefActions(brief);
  assert.deepEqual(augmented.constraints.allowedActions, ["collect", "deposit", "place_chest", "bind_chest", "list_chest", "deposit_held"]);
  assert.deepEqual(augmented.constraints.requiredActions, ["deposit"]);
  // observe-only（纯评价）任务跳过补全；无变化时返回原对象。
  const observeOnly = { ...brief, request: "你觉得这里怎么样", constraints: { ...brief.constraints, allowedActions: ["observe"], requiredActions: ["observe"] } };
  assert.equal(augmentTaskBriefActions(observeOnly), observeOnly);
  const unchanged = { ...brief, request: "随便走走" };
  assert.equal(augmentTaskBriefActions(unchanged), unchanged);
});

test("augments from the raw user request when the Soul rewrite drops keywords", () => {
  const brief = {
    version: 1, source: "cyrene_soul_readonly", request: "砍 6 个木头回来",
    constraints: { overworldOnly: true, deterministicSkillsOnly: true, maxSteps: 5, allowedActions: ["collect", "deposit"], requiredActions: ["collect"] },
    contextHints: [],
  };
  // 改写稿没有“箱子”，但用户原话有：补全仍应触发。
  const augmented = augmentTaskBriefActions(brief, "就放在我们家里的箱子里就好啦");
  assert.ok(augmented.constraints.allowedActions.includes("bind_chest"));
  assert.ok(augmented.constraints.allowedActions.includes("list_chest"));
});

test("accepts only bounded distilled hints from the read-only Soul bridge", () => {
  const brief = normalizeReadOnlyTaskBrief({
    version: 1,
    source: "cyrene_soul_readonly",
    request: " 陪我找个适合建家的地方 ",
    constraints: { maxSteps: 99, overworldOnly: false },
    contextHints: [
      { kind: "persona", text: "说话温柔一些" },
      { kind: "memory", text: "用户喜欢临水的家" },
      { kind: "command", text: "/tp @s 0 100 0" },
      "raw history is rejected",
    ],
  }, 5);
  assert.deepEqual(brief, {
    version: 1,
    source: "cyrene_soul_readonly",
    request: "陪我找个适合建家的地方",
    constraints: { overworldOnly: true, deterministicSkillsOnly: true, maxSteps: 5, allowedActions: [], requiredActions: [] },
    contextHints: [
      { kind: "persona", text: "说话温柔一些" },
      { kind: "memory", text: "用户喜欢临水的家" },
    ],
  });
  assert.equal(normalizeReadOnlyTaskBrief({ version: 1, source: "minecraft_game_chat", request: "状态" }, 5), null);
  assert.equal(normalizeReadOnlyTaskBrief({ version: 1, source: "cyrene_soul_readonly", request: "" }, 5), null);
});

test("bounds execution reports for a future read-only Soul adapter", () => {
  const report = createExecutionReport({ request: "盖房" }, "completed", [
    { command: "采集3个橡木", result: "完成" },
  ], "材料准备好了");
  assert.deepEqual(report, {
    version: 1, source: "minecraft_gamebot", request: "盖房", status: "completed",
    message: "材料准备好了", steps: [{ command: "采集3个橡木", result: "完成" }],
  });
});

test("keeps established persistent plans distinct from completed tasks", () => {
  assert.equal(createExecutionReport({ request: "跟随" }, "active", [{ command: "跟随", result: "已建立" }], "持续中").status, "active");
});
