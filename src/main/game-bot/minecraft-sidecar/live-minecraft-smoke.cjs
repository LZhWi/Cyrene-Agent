"use strict";

const path = require("node:path");
const { fork } = require("node:child_process");
const { readMinecraftSettings } = require("./live-provider-smoke.cjs");

const settingsPath = process.argv[2];
if (!settingsPath) throw new Error("usage: node live-minecraft-smoke.cjs <game-bot-settings.json>");
const original = readMinecraftSettings(settingsPath);
const reasoningOverride = process.argv[3];
const fullPipeline = process.argv[4] === "soul";
const settings = {
  ...original,
  username: "CyreneLlmSmoke",
  owner: "CyreneLlmSmokeOwner",
  auth: "offline",
  reconnect: false,
  soul: {
    ...original.soul,
    cacheSessionId: `smoke-${Date.now()}`,
    enabled: fullPipeline,
    ...(process.env.MC_SOUL_MOCK_URL ? { baseUrl: process.env.MC_SOUL_MOCK_URL, apiKey: "mock-key", model: "mock-soul", reasoning: "off" } : {}),
  },
  llm: { ...original.llm, enabled: true, ...(reasoningOverride ? { reasoning: reasoningOverride } : {}) },
  profilesFolder: path.join(__dirname, ".smoke-auth-unused"),
  stateFile: path.join(__dirname, ".smoke-state-unused.json"),
};
const child = fork(path.join(__dirname, "sidecar.cjs"), [], { cwd: __dirname, stdio: ["ignore", "ignore", "pipe", "ipc"] });
let spawned = false;
let finished = false;
let diagnostics = "";
const progressMessages = [];
const timer = setTimeout(() => finish({ ok: false, error: "Minecraft smoke timeout", progress: progressMessages.slice(-8) }), 90000);

function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (child.connected) child.send({ type: "stop" });
  setTimeout(() => { if (!child.killed) child.kill(); }, 3000).unref();
  if (!result.ok) process.exitCode = 1;
}

child.on("message", (message) => {
  if (message?.type === "progress" && message.message) progressMessages.push(String(message.message).slice(0, 240));
  if (message?.type === "progress" && /Minecraft 已登录/.test(String(message.message)) && !spawned) {
    spawned = true;
    child.send({
      type: "llm_task_brief",
      taskBrief: fullPipeline ? "看看我现在怎么样，然后自然地告诉我" : {
        version: 1, source: "cyrene_soul_readonly", request: "报告当前状态",
        constraints: { overworldOnly: true, deterministicSkillsOnly: true, maxSteps: 2, allowedActions: ["status"], requiredActions: ["status"] },
        contextHints: [],
      },
    });
  }
  if (message?.type === "soul_context_request" && message.requestId) {
    child.send({
      type: "soul_context_response", requestId: message.requestId,
      context: {
        version: 1, source: "gamebot_readonly_snapshot",
        persona: "昔涟温柔、诚实，不夸大没有发生的事。",
        conversation: [{ role: "user", content: "我们正在做 Minecraft 陪玩联调。" }],
        memories: ["当前只测试主世界。"],
      },
    });
  }
  if (message?.type === "llm_task_report") {
    const report = message.report || {};
    finish({
      ok: report.status === "completed" && Array.isArray(report.steps) && report.steps.some((step) => ["状态", "status"].includes(step.command)),
      status: report.status,
      steps: Array.isArray(report.steps) ? report.steps.map((step) => step.command) : [],
      server: `${settings.host}:${settings.port}`,
      soul: fullPipeline,
      progress: progressMessages.slice(-6),
    });
  }
});
child.stderr?.on("data", (chunk) => {
  diagnostics = `${diagnostics}${String(chunk)}`.replace(/\s+/g, " ").trim().slice(-600);
});
child.on("exit", (code) => {
  if (!finished) finish({ ok: false, error: `sidecar exited ${code}${diagnostics ? `: ${diagnostics}` : ""}` });
});
child.send({ type: "start", settings });
