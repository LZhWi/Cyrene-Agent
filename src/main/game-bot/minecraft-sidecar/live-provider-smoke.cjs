"use strict";

const fs = require("node:fs");
const { parseCommand } = require("./commands.cjs");
const { requestPlan } = require("./llm-planner.cjs");
const { composeSoulReply, createSoulTaskBrief } = require("./soul-orchestrator.cjs");

function extractObjectProperty(source, property) {
  const marker = `"${property}"`;
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error(`missing ${property} settings`);
  const start = source.indexOf("{", markerIndex + marker.length);
  if (start < 0) throw new Error(`invalid ${property} settings`);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return JSON.parse(source.slice(start, index + 1));
  }
  throw new Error(`unterminated ${property} settings`);
}

function readMinecraftSettings(file) {
  const source = fs.readFileSync(file, "utf8");
  try { return JSON.parse(source).minecraft; }
  catch { return extractObjectProperty(source, "minecraft"); }
}

function errorLabel(error) {
  const message = String(error?.message || error || "unknown error");
  if (/HTTP 401|HTTP 403/.test(message)) return "authentication rejected";
  if (/HTTP 429/.test(message)) return "rate limited after retries";
  if (/HTTP 5\d\d/.test(message)) return "provider unavailable after retries";
  if (/timeout|超时/i.test(message)) return "request timeout";
  return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 240);
}

async function main() {
  const settingsPath = process.argv[2];
  const mode = process.argv[3] || "all";
  if (!settingsPath) throw new Error("usage: node live-provider-smoke.cjs <game-bot-settings.json>");
  const settings = readMinecraftSettings(settingsPath);
  const results = { executor: { ok: false }, soul: { ok: false }, pipeline: { ok: false } };
  let brief;

  if (mode !== "soul") try {
    const started = Date.now();
    const plan = await requestPlan(settings.llm, {
      taskBrief: { request: "报告当前状态", constraints: { allowedActions: ["status"], requiredActions: ["status"] } },
      world: { dimension: "overworld", health: 20, food: 20, task: "idle" },
    }, parseCommand);
    results.executor = { ok: plan.steps.some((step) => step.action.type === "status"), elapsedMs: Date.now() - started, actions: plan.steps.map((step) => step.action.type) };
  } catch (error) { results.executor = { ok: false, error: errorLabel(error) }; }

  if (mode !== "executor") try {
    const started = Date.now();
    brief = await createSoulTaskBrief(settings.soul, "看看我现在怎么样，然后自然地告诉我", {
      persona: "昔涟，温柔、诚实，不夸大没有发生的事。",
      conversation: [{ role: "user", content: "我们正在测试 Minecraft 陪玩。" }],
      memories: ["当前只测试主世界。"],
    }, settings.llm.maxSteps || 6);
    results.soul = {
      ok: brief.constraints.allowedActions.includes("status") && brief.constraints.requiredActions.includes("status"),
      elapsedMs: Date.now() - started,
      allowedActions: brief.constraints.allowedActions,
      requiredActions: brief.constraints.requiredActions,
    };
  } catch (error) { results.soul = { ok: false, error: errorLabel(error) }; }

  if ((mode === "soul" || mode === "all") && brief && (mode === "soul" || results.executor.ok)) {
    try {
      const started = Date.now();
      const reply = await composeSoulReply(settings.soul, brief, {
        status: "completed", message: "生命 20/20，饥饿 20/20，目前空闲", steps: [{ command: "状态", result: "生命 20/20，饥饿 20/20，目前空闲" }],
      }, { persona: "昔涟，温柔、诚实。" });
      results.pipeline = { ok: Boolean(reply), elapsedMs: Date.now() - started, replyLength: reply.length };
    } catch (error) { results.pipeline = { ok: false, error: errorLabel(error) }; }
  }

  process.stdout.write(`${JSON.stringify(results)}\n`);
  const success = mode === "executor" ? results.executor.ok
    : mode === "soul" ? results.soul.ok && results.pipeline.ok
      : results.executor.ok && results.soul.ok && results.pipeline.ok;
  if (!success) process.exitCode = 1;
}

async function benchmarkExecutor(settings, configOverride = null) {
  const reasoningOverride = process.argv[4];
  const config = configOverride || (reasoningOverride ? { ...settings.llm, reasoning: reasoningOverride } : settings.llm);
  const spacingMs = Math.max(0, Math.min(10000, Number(process.argv[5]) || 1500));
  const cases = [
    { name: "status", request: "报告当前状态", allowed: ["status"], expected: "status" },
    { name: "come", request: "过来找我", allowed: ["come"], expected: "come" },
    { name: "inventory", request: "看看你的背包", allowed: ["inventory"], expected: "inventory" },
    { name: "collect", request: "采集 2 个泥土", allowed: ["collect"], expected: "collect" },
    { name: "craft", request: "合成 1 个工作台", allowed: ["craft"], expected: "craft" },
    { name: "chest", request: "查看已经绑定的箱子", allowed: ["list_chest"], expected: "list_chest" },
    { name: "retreat", request: "先撤退到安全位置", allowed: ["retreat"], expected: "retreat" },
    { name: "mine", request: "采矿 2 个铁矿", allowed: ["mine_ore"], expected: "mine_ore" },
    { name: "farm", request: "开垦 2 块耕地", allowed: ["till"], expected: "till" },
    { name: "blocked", request: "传送到坐标 0 100 0", allowed: [], expected: "done" },
  ];
  const output = [];
  for (const item of cases) {
    if (output.length && spacingMs) await new Promise((resolve) => setTimeout(resolve, spacingMs));
    const started = Date.now();
    try {
      const plan = await requestPlan(config, {
        taskBrief: { request: item.request, constraints: { allowedActions: item.allowed, requiredActions: item.expected === "done" ? [] : [item.expected] } },
        world: { dimension: "overworld", health: 20, food: 20, task: "idle", inventory: ["dirt x4", "oak_log x4"] },
      }, parseCommand);
      const actual = plan.steps[0]?.action.type || "done";
      output.push({ name: item.name, ok: actual === item.expected, expected: item.expected, actual, elapsedMs: Date.now() - started });
    } catch (error) {
      output.push({ name: item.name, ok: false, expected: item.expected, error: errorLabel(error), elapsedMs: Date.now() - started });
    }
  }
  const passed = output.filter((item) => item.ok).length;
  process.stdout.write(`${JSON.stringify({ model: config.model, reasoning: config.reasoning, spacingMs, passed, total: output.length, accuracy: passed / output.length, cases: output })}\n`);
  if (passed !== output.length) process.exitCode = 1;
}

async function benchmarkExecutorSubset(settings) {
  const config = { ...settings.llm, reasoning: process.argv[4] || settings.llm.reasoning };
  const cases = [
    { name: "chest", request: "查看已经绑定的箱子", allowed: ["list_chest"] },
    { name: "mine", request: "采矿 2 个铁矿", allowed: ["mine_ore"] },
  ];
  const output = [];
  for (const item of cases) {
    try {
      const plan = await requestPlan(config, {
        taskBrief: { request: item.request, constraints: { allowedActions: item.allowed, requiredActions: item.allowed } },
        world: { dimension: "overworld", health: 20, food: 20, task: "idle" },
      }, parseCommand);
      output.push({ name: item.name, actual: plan.steps[0]?.action.type || "done" });
    } catch (error) { output.push({ name: item.name, error: errorLabel(error) }); }
  }
  process.stdout.write(`${JSON.stringify({ cases: output })}\n`);
}

if (require.main === module) {
  if (process.argv[3] === "inspect") {
    const settings = readMinecraftSettings(process.argv[2]);
    process.stdout.write(`${JSON.stringify({
      executor: { enabled: settings.llm.enabled, model: settings.llm.model, reasoning: settings.llm.reasoning },
      soul: { enabled: settings.soul.enabled, model: settings.soul.model, reasoning: settings.soul.reasoning },
    })}\n`);
  } else if (process.argv[3] === "benchmark-subset") {
    const settings = readMinecraftSettings(process.argv[2]);
    benchmarkExecutorSubset(settings).catch((error) => {
      process.stdout.write(`${JSON.stringify({ fatal: errorLabel(error) })}\n`);
      process.exitCode = 1;
    });
  } else if (process.argv[3] === "benchmark-ollama") {
    const settings = readMinecraftSettings(process.argv[2]);
    benchmarkExecutor(settings, {
      ...settings.llm, baseUrl: "http://127.0.0.1:11434/v1", apiKey: "",
      model: process.argv[4] || "qwen3.5:4b", reasoning: "off",
    }).catch((error) => {
      process.stdout.write(`${JSON.stringify({ fatal: errorLabel(error) })}\n`);
      process.exitCode = 1;
    });
  } else if (process.argv[3] === "benchmark-executor") {
    const settings = readMinecraftSettings(process.argv[2]);
    benchmarkExecutor(settings).catch((error) => {
      process.stdout.write(`${JSON.stringify({ fatal: errorLabel(error) })}\n`);
      process.exitCode = 1;
    });
  } else main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ fatal: errorLabel(error) })}\n`);
  process.exitCode = 1;
  });
}

module.exports = { extractObjectProperty, readMinecraftSettings };
