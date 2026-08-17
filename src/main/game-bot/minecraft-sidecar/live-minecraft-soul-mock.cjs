"use strict";

const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const settingsPath = process.argv[2];
if (!settingsPath) throw new Error("usage: node live-minecraft-soul-mock.cjs <game-bot-settings.json>");
let calls = 0;
let leakedRawContextToExecutor = false;

const server = http.createServer((request, response) => {
  let raw = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { raw += chunk; });
  request.on("end", () => {
    calls += 1;
    const body = JSON.parse(raw || "{}");
    const serialized = JSON.stringify(body);
    const isTaskBrief = serialized.includes("userRequest") && serialized.includes("readOnlyContext");
    const isActionStart = serialized.includes("plannedAction");
    const isFinalReply = serialized.includes("executionReport");
    const content = isTaskBrief
      ? '{"request":"报告当前生命、饥饿和任务状态","allowedActions":["status"],"requiredActions":["status"],"contextHints":[{"kind":"conversation","text":"正在进行 Minecraft 陪玩联调"}]}'
      : isActionStart ? "我先看看现在的状态。"
        : isFinalReply ? "状态很好，我已经确认过啦，我们可以继续出发。" : "unexpected request";
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const child = spawn(process.execPath, [path.join(__dirname, "live-minecraft-smoke.cjs"), settingsPath, "off", "soul"], {
    cwd: __dirname,
    env: { ...process.env, MC_SOUL_MOCK_URL: baseUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("close", (code) => {
    server.close();
    let minecraft;
    try { minecraft = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)); }
    catch { minecraft = { ok: false, error: "invalid child output" }; }
    const result = {
      ok: code === 0 && minecraft.ok === true && minecraft.soul === true && calls === 3 && !leakedRawContextToExecutor,
      soulCalls: calls,
      minecraft,
      stderr: stderr ? "child stderr present" : undefined,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  });
});
