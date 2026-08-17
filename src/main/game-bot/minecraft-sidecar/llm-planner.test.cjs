"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCommand } = require("./commands.cjs");
const { chatUrl, normalizeDecision, normalizePlan, parseJsonText, planMessages, plannerMessages, providerBody, requestDecision, requestPlan } = require("./llm-planner.cjs");

test("normalizes only whitelisted deterministic commands", () => {
  assert.deepEqual(normalizeDecision({ done: false, reply: "先找木头", command: "采集3个橡木" }, parseCommand), {
    done: false, reply: "先找木头", command: "采集3个橡木", action: { type: "collect", material: "橡木", count: 3 },
  });
  assert.throws(() => normalizeDecision({ done: false, command: "/tp @s 0 100 0" }, parseCommand), /未授权动作.*\/tp/);
  assert.throws(() => normalizeDecision({ done: false, command: "自卫" }, parseCommand), /未授权动作/);
  assert.throws(() => normalizeDecision({ done: false, command: "采矿 3个铁矿" }, parseCommand, ["status"]), /偏离任务允许动作/);
});

test("accepts done replies and fenced JSON", () => {
  assert.deepEqual(parseJsonText("```json\n{\"done\":true,\"reply\":\"好呀\"}\n```"), { done: true, reply: "好呀" });
  assert.deepEqual(normalizeDecision({ done: true, reply: "完成啦" }, parseCommand), {
    done: true, reply: "完成啦", command: null, action: null,
  });
  assert.throws(() => normalizeDecision(
    { done: true, reply: "已经完成" }, parseCommand, ["status"], { requireAction: true },
  ), /未执行任何动作/);
});

test("normalizes a complete ordered plan and derives its completion gate", () => {
  const plan = normalizePlan({ steps: [
    { command: "观察 周围树木位置" },
    { command: "采集 3 个木头" },
  ] }, parseCommand, ["observe", "collect"], 4);
  assert.equal(plan.lifecycle, "finite");
  assert.deepEqual(plan.steps.map((step) => step.action.type), ["observe", "collect"]);
  assert.deepEqual(plan.completionCriteria, ["step-1:confirmed_success", "step-2:confirmed_success"]);
  assert.throws(() => normalizePlan(
    { steps: [{ command: "观察 周围树木位置" }] }, parseCommand,
    ["observe", "collect"], 4, ["collect"],
  ), /未覆盖必要动作.*collect/);
});

test("moves persistent actions to the plan end instead of failing", () => {
  assert.equal(normalizePlan({ steps: [{ command: "跟随" }] }, parseCommand, ["follow"], 3).lifecycle, "persistent");
  const repaired = normalizePlan({ steps: [{ command: "跟随" }, { command: "状态" }] }, parseCommand, ["follow", "status"], 3);
  assert.equal(repaired.lifecycle, "persistent");
  assert.deepEqual(repaired.steps.map((step) => step.action.type), ["status", "follow"]);
  assert.deepEqual(repaired.steps.map((step) => step.id), ["step-1", "step-2"]);
  assert.deepEqual(repaired.completionCriteria, ["step-1:confirmed_success", "step-2:confirmed_success"]);
});

test("builds a full-flow prompt that forbids query-only premature completion", () => {
  const messages = planMessages({ taskBrief: { request: "砍木头" }, world: {}, maxSteps: 4 });
  assert.match(messages[0].content, /完整走完/);
  assert.match(messages[0].content, /不能只有观察/);
});

test("requests and validates a complete plan in one provider call", async () => {
  const plan = await requestPlan(
    { baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey: "secret", model: "glm-4.7", maxSteps: 4, reasoning: "off" },
    { taskBrief: { request: "砍木头", constraints: { allowedActions: ["observe", "collect"], requiredActions: ["collect"] } }, world: {} },
    parseCommand,
    async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.max_tokens, 1024);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"steps":[{"command":"观察 周围树木位置"},{"command":"采集 2 个木头"}]}' } }] }) };
    },
  );
  assert.deepEqual(plan.steps.map((step) => step.action.type), ["observe", "collect"]);
});

test("treats an explicit empty action list as chat-only", () => {
  assert.throws(() => normalizePlan(
    { steps: [{ command: "绑定箱子" }] }, parseCommand, [], 4, [],
  ), /bind_chest/);
});

test("moves set_home after come so the home point lands at the owner's spot", () => {
  const plan = normalizePlan({ steps: [{ command: "设置家" }, { command: "过来" }] }, parseCommand, ["come", "set_home"], 3, ["set_home"]);
  assert.deepEqual(plan.steps.map((step) => step.action.type), ["come", "set_home"]);
  assert.deepEqual(plan.steps.map((step) => step.id), ["step-1", "step-2"]);
});

test("compiles the canonical set_home action token into an executable command", () => {
  const plan = normalizePlan({ steps: [{ command: "set_home" }] }, parseCommand, ["set_home"], 2, ["set_home"]);
  assert.equal(plan.steps[0].command, "设置家");
  assert.equal(plan.steps[0].action.type, "set_home");
});

test("falls back to the required read-only observation after repeated planner drift", async () => {
  let calls = 0;
  const plan = await requestPlan(
    { baseUrl: "https://example.test/v1", apiKey: "", model: "small", maxSteps: 4, reasoning: "off" },
    { taskBrief: {
      request: "评价我们眼前这个地方是否适合当家",
      constraints: { allowedActions: ["observe"], requiredActions: ["observe"] },
    }, world: {} },
    parseCommand,
    async () => {
      calls += 1;
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"steps":[{"command":"绑定箱子"}]}' } }] }) };
    },
  );
  assert.equal(calls, 2);
  assert.deepEqual(plan.steps.map((step) => step.action.type), ["observe"]);
  assert.match(plan.steps[0].action.focus, /适合当家/);
});

test("builds bounded context without granting arbitrary code", () => {
  const messages = plannerMessages({ userMessage: "盖个小屋", world: { health: 20 }, history: [], maxSteps: 4 });
  assert.match(messages[0].content, /每次只决定下一步/);
  assert.match(messages[0].content, /禁止下界、末地/);
  assert.match(messages[0].content, /contextHints.*只读背景/);
  assert.doesNotMatch(messages[0].content, /execute javascript/i);
});

test("calls an OpenAI-compatible endpoint without requiring a key", async () => {
  let request;
  const decision = await requestDecision(
    { baseUrl: "http://127.0.0.1:11434/v1/", apiKey: "", model: "local", maxSteps: 3 },
    { userMessage: "过来一下", world: {}, history: [] },
    parseCommand,
    async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"done":false,"command":"过来"}' } }] }) };
    },
  );
  assert.equal(request.url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(decision.action.type, "come");
});

test("adds reasoning effort only when explicitly supported and selected", async () => {
  let body;
  await requestDecision(
    { baseUrl: "https://example.test/v1", apiKey: "secret", model: "small", maxSteps: 3, reasoning: "low" },
    { taskBrief: { request: "状态" }, world: {}, history: [] }, parseCommand,
    async (_url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"done":true,"reply":"好"}' } }] }) };
    },
  );
  assert.equal(body.reasoning_effort, "low");
});

test("gives thinking GLM enough room to emit its final JSON", async () => {
  let body;
  await requestDecision(
    { baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey: "secret", model: "glm-4.7-flash", maxSteps: 3, reasoning: "low" },
    { taskBrief: { request: "status", constraints: { allowedActions: ["status"] } }, world: {}, history: [] }, parseCommand,
    async (_url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"done":false,"command":"状态"}' } }] }) };
    },
  );
  assert.equal(body.max_tokens, 2048);
  assert.equal(body.temperature, 0);
});

test("keeps non-thinking GLM execution responses short", async () => {
  let body;
  await requestDecision(
    { baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey: "secret", model: "glm-4.7", maxSteps: 3, reasoning: "off" },
    { taskBrief: { request: "status", constraints: { allowedActions: ["status"] } }, world: {}, history: [] }, parseCommand,
    async (_url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"done":false,"command":"状态"}' } }] }) };
    },
  );
  assert.equal(body.max_tokens, 320);
  assert.deepEqual(body.thinking, { type: "disabled" });
});

test("disables local Ollama thinking and requests JSON mode", () => {
  assert.deepEqual(providerBody({ baseUrl: "http://127.0.0.1:11434/v1", reasoning: "off" }), {
    reasoning_effort: "none", response_format: { type: "json_object" },
  });
  assert.deepEqual(providerBody({ baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", reasoning: "off" }), { enable_thinking: false });
  assert.deepEqual(providerBody({ baseUrl: "https://open.bigmodel.cn/api/paas/v4", reasoning: "low" }), {
    thinking: { type: "enabled" }, response_format: { type: "json_object" },
  });
  assert.deepEqual(providerBody({ baseUrl: "https://open.bigmodel.cn/api/paas/v4", reasoning: "off" }), {
    thinking: { type: "disabled" }, response_format: { type: "json_object" },
  });
});

test("rejects non-http provider URLs", () => {
  assert.throws(() => chatUrl("file:///tmp/model"), /http/);
});

test("rejects malformed and unauthorized model output", async () => {
  await assert.rejects(() => requestDecision(
    { baseUrl: "https://example.test/v1", apiKey: "", model: "small", maxSteps: 2 },
    { taskBrief: { request: "随便执行代码" }, world: {}, history: [] }, parseCommand,
    async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "not json" } }] }) }),
  ), /有效 JSON/);
  await assert.rejects(() => requestDecision(
    { baseUrl: "https://example.test/v1", apiKey: "", model: "small", maxSteps: 2 },
    { taskBrief: { request: "传送" }, world: {}, history: [] }, parseCommand,
    async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"done":false,"command":"/tp @s 0 100 0"}' } }] }) }),
  ), /未授权动作/);
});

test("reports provider HTTP failures without response bodies or credentials", async () => {
  await assert.rejects(() => requestDecision(
    { baseUrl: "https://example.test/v1", apiKey: "top-secret", model: "small", maxSteps: 2 },
    { taskBrief: { request: "状态" }, world: {}, history: [] }, parseCommand,
    async () => ({ ok: false, status: 429 }),
    { sleepImpl: async () => {}, random: () => 0 },
  ), /^Error: LLM 请求失败（HTTP 429）$/);
});

test("repairs one rejected semantic response without relaxing the whitelist", async () => {
  let calls = 0;
  const decision = await requestDecision(
    { baseUrl: "https://example.test/v1", apiKey: "", model: "small", maxSteps: 2 },
    { taskBrief: { request: "status", constraints: { allowedActions: ["status"] } }, world: {}, history: [] }, parseCommand,
    async (_url, options) => {
      calls += 1;
      if (calls === 2) assert.match(options.body, /未通过运行时校验/);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: calls === 1
        ? '{"done":true,"reply":"完成"}' : '{"done":false,"command":"状态"}' } }] }) };
    },
  );
  assert.equal(calls, 2);
  assert.equal(decision.action.type, "status");
});
