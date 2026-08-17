"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCommand } = require("./commands.cjs");
const { requestDecision } = require("./llm-planner.cjs");
const { chooseAutonomousTask, compactContext, composeActionStartReply, composeSessionSummary, composeSoulReply, createSoulTaskBrief, isVisibleOpinionRequest, providerBody, requestSoul, stripThinking, summarizeGameConversation } = require("./soul-orchestrator.cjs");

test("keeps separate bounded entry and exit context views", () => {
  const context = compactContext({
    entryPersona: "entry", exitPersona: "exit", exitExpressionRules: "rules", memories: Array(9).fill("memory"),
    gameConversation: Array.from({ length: 25 }, (_, index) => ({ role: "user", content: `turn ${index}` })),
    gameSummary: "earlier", worldbook: ["world"],
  });
  assert.equal(context.entryPersona, "entry");
  assert.equal(context.exitPersona, "exit");
  assert.equal(context.exitExpressionRules, "rules");
  assert.equal(context.memories.length, 5);
  assert.equal(context.gameConversation.length, 20);
  assert.equal(context.gameConversation[0].content, "turn 5");
});

function response(content) { return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) }; }

test("adapts reasoning controls for Kimi, Qwen, GLM and generic providers", () => {
  assert.deepEqual(providerBody({ baseUrl: "https://api.moonshot.cn/v1", reasoning: "off" }), { thinking: { type: "disabled" } });
  assert.deepEqual(providerBody({ baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", reasoning: "off" }), { enable_thinking: false });
  assert.deepEqual(providerBody({ baseUrl: "https://api.minimaxi.com/v1", reasoning: "low" }), {});
  assert.deepEqual(providerBody({ baseUrl: "https://open.bigmodel.cn/api/paas/v4", reasoning: "off" }), { thinking: { type: "disabled" } });
  assert.deepEqual(providerBody({ baseUrl: "https://open.bigmodel.cn/api/paas/v4", reasoning: "low" }), { thinking: { type: "enabled" } });
});

test("uses each provider's compatible token-limit field", async () => {
  const captured = [];
  for (const baseUrl of ["https://api.moonshot.cn/v1", "https://api.minimaxi.com/v1"]) {
    await requestSoul({ baseUrl, apiKey: "", model: "model", reasoning: "off" }, [], 700, async (_url, options) => {
      captured.push(JSON.parse(options.body));
      return response("ok");
    });
  }
  assert.equal(captured[0].max_tokens, 700);
  assert.equal("max_completion_tokens" in captured[0], false);
  assert.equal(captured[1].max_completion_tokens, 700);
  assert.equal("max_tokens" in captured[1], false);
});

test("creates a bounded task brief from a read-only snapshot", async () => {
  const brief = await createSoulTaskBrief(
    { baseUrl: "https://api.moonshot.cn/v1", apiKey: "secret", model: "kimi-k2.6", reasoning: "off", cacheSessionId: "session-1" },
    "帮我找个地方安家", { persona: "温柔", conversation: [{ role: "user", content: "想住水边" }], memories: ["喜欢湖景"] }, 5,
    async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.thinking.type, "disabled");
      assert.equal(body.prompt_cache_key, "minecraft:session-1:entry");
      assert.doesNotMatch(JSON.stringify(body), /secret/);
      return response('{"request":"在主世界寻找安全的临水建家地点","allowedActions":["explore_follow","set_home","teleport"],"requiredActions":["explore_follow"],"contextHints":[{"kind":"memory","text":"用户喜欢湖景"}]}');
    },
  );
  assert.equal(brief.source, "cyrene_soul_readonly");
  assert.equal(brief.constraints.maxSteps, 5);
  assert.deepEqual(brief.constraints.allowedActions, ["explore_follow", "set_home"]);
  assert.deepEqual(brief.constraints.requiredActions, ["explore_follow"]);
  assert.deepEqual(brief.contextHints, [{ kind: "memory", text: "用户喜欢湖景" }]);
});

test("classifies a request for an opinion about the visible place as observation only", async () => {
  const brief = await createSoulTaskBrief(
    { baseUrl: "https://example.test/v1", apiKey: "", model: "soul", reasoning: "off" },
    "你看我们选这个地方作为家怎么样？", { memories: ["用户想找有山有水、能看日落的地方"] }, 4,
    async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.match(JSON.stringify(body.messages), /不得自行推断.*bind_chest/);
      return response('{"request":"把这里设置为家点","allowedActions":["observe","set_home"],"requiredActions":["set_home"],"contextHints":[{"kind":"memory","text":"用户想找有山有水、能看日落的地方"}]}');
    },
  );
  assert.deepEqual(brief.constraints.allowedActions, ["observe"]);
  assert.deepEqual(brief.constraints.requiredActions, ["observe"]);
  assert.equal(isVisibleOpinionRequest("你看看我们现在这个地方安家好嘛？我感觉挺合适"), true);
  assert.equal(isVisibleOpinionRequest("这里很合适，就设置家吧"), false);
  assert.equal(isVisibleOpinionRequest("那你先来我这里嘛，我们就在这里安家啦"), false);
});

test("puts exit expression rules last and isolates its Kimi cache key", async () => {
  await composeSoulReply(
    { baseUrl: "https://api.moonshot.cn/v1", apiKey: "", model: "kimi-k2.6", reasoning: "off", cacheSessionId: "session-1" },
    { request: "status" }, { status: "completed", message: "ok", steps: [] },
    { exitPersona: "persona", exitExpressionRules: "最后保持自然简洁", memories: [] },
    async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.prompt_cache_key, "minecraft:session-1:exit");
      assert.equal(body.messages.at(-1).role, "system");
      assert.match(body.messages.at(-1).content, /最后保持自然简洁/);
      return response("完成了。");
    },
  );
});

test("creates a non-completion action-start reply with its own cache key", async () => {
  const reply = await composeActionStartReply(
    { baseUrl: "https://api.moonshot.cn/v1", apiKey: "", model: "kimi-k2.6", reasoning: "off", cacheSessionId: "session-1" },
    { request: "跟我走" }, { command: "跟随", action: { type: "follow" } },
    { exitPersona: "persona", exitExpressionRules: "保持自然" },
    async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.prompt_cache_key, "minecraft:session-1:action-start");
      assert.equal(body.messages.at(-1).role, "system");
      assert.match(body.messages[0].content, /绝不能声称已经完成/);
      return response("好呀，我跟着你走。 ");
    },
  );
  assert.equal(reply, "好呀，我跟着你走。");
});

test("composes the final answer only from a bounded execution report", async () => {
  const reply = await composeSoulReply(
    { baseUrl: "https://api.minimaxi.com/v1", apiKey: "", model: "MiniMax-M2.7", reasoning: "off" },
    { request: "找木头" }, { status: "failed", message: "附近没有原木", steps: [] }, { persona: "温柔" },
    async () => response("<think>不要泄露</think>附近暂时没找到原木，我们换个方向再看看吧。"),
  );
  assert.equal(reply, "附近暂时没找到原木，我们换个方向再看看吧。");
});

test("shows the final Soul reply what was already said at action start", async () => {
  await composeSoulReply(
    { baseUrl: "https://example.test/v1", apiKey: "", model: "mock", reasoning: "off" },
    { request: "砍木头" }, { status: "completed", message: "获得 3 个橡木原木", steps: [] },
    { previousActionReply: "我先去附近找找树。" },
    async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.match(body.messages[0].content, /不要复述/);
      assert.match(body.messages[0].content, /本次新增、改变或得到确认的事实/);
      assert.ok(body.messages.some((message) => message.content.includes("我先去附近找找树")));
      return response("砍到三块橡木原木啦。 ");
    },
  );
});

test("summarizes rolling chat and creates an explicit session draft", async () => {
  let call = 0;
  const fetchImpl = async () => response(++call === 1 ? "决定在湖边建家，木屋还没完成。" : "我们一起选了湖边作为家，木屋仍在搭建中。 ");
  const config = { baseUrl: "https://example.test/v1", apiKey: "", model: "mock", reasoning: "off" };
  const rolling = await summarizeGameConversation(config, "", [{ role: "user", content: "住水边" }], fetchImpl);
  const session = await composeSessionSummary(config, { highlights: ["选址"] }, fetchImpl);
  assert.match(rolling, /湖边/);
  assert.match(session, /木屋/);
});

test("autonomous Soul goals are constrained by the selected mode", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({
      idle: false, request: "捡起附近掉落物", allowedActions: ["collect", "give", "pickup"], requiredActions: ["pickup"],
    }) } }] }),
  });
  const brief = await chooseAutonomousTask(
    { baseUrl: "https://test/v1", model: "soul", reasoning: "off" },
    { mode: "companion", allowedActions: ["collect", "give", "pickup"], world: {}, vision: null },
    {}, 6, fetchImpl,
  );
  assert.deepEqual(brief.constraints.allowedActions, ["pickup"]);
  assert.deepEqual(brief.constraints.requiredActions, ["pickup"]);
});

test("completes missing peripheral actions before the required-action check", async () => {
  const brief = await createSoulTaskBrief(
    { baseUrl: "https://example.test/v1", apiKey: "", model: "soul", reasoning: "off" },
    "帮我把木头放进箱子", {}, 5,
    async () => response('{"request":"把采集到的木头放进箱子","allowedActions":["collect","deposit"],"requiredActions":["deposit"],"contextHints":[]}'),
  );
  assert.deepEqual(brief.constraints.allowedActions, ["collect", "deposit", "place_chest", "bind_chest", "list_chest", "deposit_held"]);
  assert.deepEqual(brief.constraints.requiredActions, ["deposit"]);
});

test("forwards the two most recent saved session summaries through the compacted context", () => {
  const context = compactContext({ recentSessions: [
    { startedAt: 1, endedAt: 2, serverLabel: "a", players: ["Steve"], summary: "old" },
    { startedAt: 3, endedAt: 4, serverLabel: "b", players: ["Alex"], summary: "mid" },
    { startedAt: 5, endedAt: 6, serverLabel: "c", players: ["Cyrene"], summary: "latest" },
  ] });
  assert.deepEqual(context.recentSessions.map((session) => session.serverLabel), ["b", "c"]);
  assert.equal(context.recentSessions[1].summary, "latest");
});

test("rejects an actionable Soul brief that omits its completion requirement", async () => {
  await assert.rejects(() => createSoulTaskBrief(
    { baseUrl: "https://test/v1", model: "soul", reasoning: "off" }, "砍木头", {}, 4,
    async () => response('{"request":"砍木头","allowedActions":["observe","collect"],"contextHints":[]}'),
  ), /必要动作/);
});

test("does not expose provider bodies or credentials on HTTP errors", async () => {
  await assert.rejects(() => requestSoul(
    { baseUrl: "https://example.test/v1", apiKey: "top-secret", model: "large", reasoning: "off" }, [], 100,
    async () => ({ ok: false, status: 401 }),
  ), /^Error: Soul LLM 请求失败（HTTP 401）$/);
  assert.equal(stripThinking("<think>secret</think>答案"), "答案");
});

test("runs the full Soul to executor to Soul contract without sharing raw memory", async () => {
  const soulConfig = { baseUrl: "https://api.moonshot.cn/v1", apiKey: "soul-key", model: "large", reasoning: "off" };
  const plannerConfig = { baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey: "planner-key", model: "glm-4.7-flash", reasoning: "low", maxSteps: 4 };
  const context = { persona: "gentle and honest", conversation: [{ role: "user", content: "private lake preference" }], memories: ["protect farmland"] };
  const brief = await createSoulTaskBrief(soulConfig, "check status", context, 4, async (_url, options) => {
    assert.match(options.headers.Authorization, /^Bearer /);
    return response('{"request":"report current status","allowedActions":["status"],"requiredActions":["status"],"contextHints":[{"kind":"memory","text":"protect farmland"}]}');
  });
  const decision = await requestDecision(plannerConfig, { taskBrief: brief, world: { health: 20 }, history: [] }, parseCommand, async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.deepEqual(body.thinking, { type: "enabled" });
    assert.doesNotMatch(options.body, /private lake preference/);
    return response('{"done":false,"reply":"checking","command":"状态"}');
  });
  assert.equal(decision.action.type, "status");
  const finalReply = await composeSoulReply(soulConfig, brief, {
    status: "completed", message: "healthy", steps: [{ command: decision.command, result: "health 20/20" }],
  }, context, async (_url, options) => {
    assert.match(options.body, /health 20\/20/);
    return response("状态很好，我们可以继续出发啦。");
  });
  assert.equal(finalReply, "状态很好，我们可以继续出发啦。");
});
