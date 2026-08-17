"use strict";

const http = require("node:http");
const path = require("node:path");
const { fork } = require("node:child_process");
const { readMinecraftSettings } = require("./live-provider-smoke.cjs");

const settingsPath = process.argv[2];
if (!settingsPath) throw new Error("usage: node live-autonomy-loop-smoke.cjs <game-bot-settings.json>");

let soulCalls = 0;
const soulServer = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    soulCalls += 1;
    const content = body.includes("exactWorldState")
      ? JSON.stringify({ idle: false, request: "查看当前状态", allowedActions: ["status"], requiredActions: ["status"] })
      : "我看过当前状态了，周围暂时安全。";
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

soulServer.listen(0, "127.0.0.1", () => {
  const original = readMinecraftSettings(settingsPath);
  const settings = {
    ...original,
    username: "CyreneAutoLoop", owner: "NoSuchOwner", auth: "offline", reconnect: false,
    autonomy: { mode: "companion", visionEnabled: false },
    soul: { ...original.soul, enabled: true, baseUrl: `http://127.0.0.1:${soulServer.address().port}/v1`, apiKey: "mock", model: "mock-soul", reasoning: "off" },
    llm: { ...original.llm, enabled: true },
    profilesFolder: path.join(__dirname, ".autoloop-auth-unused"), stateFile: path.join(__dirname, ".autoloop-state-unused.json"),
  };
  const child = fork(path.join(__dirname, "sidecar.cjs"), [], { cwd: __dirname, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const progress = [];
  let finished = false;
  const timeout = setTimeout(() => finish({ ok: false, error: "autonomous loop timeout" }), 75_000);
  function finish(result) {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    soulServer.close();
    if (child.connected) child.send({ type: "stop" });
    setTimeout(() => { if (!child.killed) child.kill(); }, 1000).unref();
    process.stdout.write(`${JSON.stringify({ ...result, soulCalls, progress: progress.slice(-10) })}\n`);
    if (!result.ok) process.exitCode = 1;
  }
  child.on("message", (message) => {
    if (message?.type === "progress" && message.message) progress.push(String(message.message));
    if (message?.type === "soul_context_request" && message.requestId) {
      child.send({ type: "soul_context_response", requestId: message.requestId, context: {
        version: 1, source: "gamebot_readonly_snapshot", entryPersona: "昔涟会先观察再做低风险行动。",
        exitPersona: "简短、诚实地报告结果。", conversation: [], memories: [], gameConversation: [], worldbook: [],
      } });
    }
    if (message?.type === "llm_task_report") {
      const report = message.report || {};
      finish({ ok: report.status === "completed" && report.steps?.some((step) => ["状态", "status"].includes(step.command)), report });
    }
  });
  child.on("exit", (code) => { if (!finished) finish({ ok: false, error: `sidecar exited ${code}` }); });
  child.send({ type: "start", settings });
});
