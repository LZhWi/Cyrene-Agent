"use strict";

const http = require("node:http");
const path = require("node:path");
const { fork } = require("node:child_process");
const { readMinecraftSettings } = require("./live-provider-smoke.cjs");
const { allowedActions } = require("./autonomy.cjs");
const { chooseAutonomousTask } = require("./soul-orchestrator.cjs");

const settingsPath = process.argv[2];
if (!settingsPath) throw new Error("usage: node live-autonomy-mock.cjs <game-bot-settings.json>");
const scenario = ["follow", "eat", "wood", "opinion"].includes(process.argv[3]) ? process.argv[3] : "status";
let calls = 0;
const server = http.createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk) => { raw += chunk; });
  request.on("end", () => {
    calls += 1;
    const isPlanner = raw.includes("结构化任务规划器");
    const isActionStart = raw.includes("动作结果尚未确认");
    const content = raw.includes("exactWorldState")
      ? JSON.stringify(scenario === "follow"
        ? { idle: false, request: "持续跟随用户", allowedActions: ["follow"], requiredActions: ["follow"] }
        : scenario === "eat"
          ? { idle: false, request: "吃点东西", allowedActions: ["eat"], requiredActions: ["eat"] }
          : scenario === "wood"
            ? { idle: false, request: "观察周围后采集 1 个木头", allowedActions: ["observe", "collect"], requiredActions: ["collect"] }
          : scenario === "opinion"
            ? { idle: false, request: "观察并评价眼前地点是否适合作为家", allowedActions: ["observe"], requiredActions: ["observe"] }
            : { idle: false, request: "查看当前状态", allowedActions: ["status"], requiredActions: ["status"] })
      : isPlanner
        ? JSON.stringify({ steps: scenario === "wood"
          ? [{ command: "观察 周围树木位置" }, { command: "采集 1 个木头" }]
          : [{ command: scenario === "opinion" ? "绑定箱子" : scenario === "follow" ? "跟随" : scenario === "eat" ? "吃东西" : "状态" }] })
        : isActionStart
          ? (scenario === "follow" ? "好呀，我跟着你走。" : scenario === "wood" ? "我先看看附近的树，很快回来。" : scenario === "opinion" ? "我先仔细看看这个地方。" : "我先看看现在的状态。")
          : scenario === "wood"
            ? (raw.includes("没有找到木头") ? "附近暂时没找到木头，我们换个地方再试吧。" : "木头采集好了。")
            : scenario === "opinion" ? "这里有山有水，视野也很开阔，我觉得很适合当我们的家。" : "状态确认好了，目前一切正常。";
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

server.listen(0, "127.0.0.1", async () => {
  const original = readMinecraftSettings(settingsPath);
  const soul = { ...original.soul, enabled: true, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "mock", model: "mock-soul", reasoning: "off" };
  const autonomyMode = scenario === "wood" ? "survival" : "companion";
  const brief = await chooseAutonomousTask(soul, {
    mode: autonomyMode, allowedActions: allowedActions(autonomyMode),
    world: { health: 20, food: 20, dimension: "overworld", activeTask: null },
    vision: { sceneSummary: "林间空地，当前安全", hazards: [], confidence: 0.8 },
  }, { entryPersona: "昔涟会做低风险的陪伴行动。" }, original.llm.maxSteps);
  const settings = {
    ...original, username: "CyreneAuto", owner: scenario === "follow" ? "CyreneAuto" : "AutoOwner", auth: "offline", reconnect: false,
    autonomy: { mode: "passive", visionEnabled: ["wood", "opinion"].includes(scenario) }, soul,
    llm: { ...original.llm, enabled: true, baseUrl: soul.baseUrl, apiKey: "mock", model: "mock-executor", reasoning: "off" },
    profilesFolder: path.join(__dirname, ".auto-auth-unused"), stateFile: path.join(__dirname, ".auto-state-unused.json"),
  };
  const child = fork(path.join(__dirname, "sidecar.cjs"), [], { cwd: __dirname, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const progress = [];
  let sent = false;
  const timer = setTimeout(() => finish({ ok: false, error: "autonomy smoke timeout" }), 90_000);
  function finish(result) {
    clearTimeout(timer);
    server.close();
    if (child.connected) child.send({ type: "stop" });
    process.stdout.write(`${JSON.stringify({ ...result, calls, brief, progress: progress.slice(-8) })}\n`);
    if (!result.ok) process.exitCode = 1;
  }
  child.on("message", (message) => {
    if (message?.type === "progress" && message.message) {
      progress.push(String(message.message));
      if (/Minecraft 已登录/.test(String(message.message)) && !sent) {
        sent = true;
        child.send({ type: "llm_task_brief", taskBrief: brief });
      }
    }
    if (message?.type === "vision_request" && message.requestId) {
      child.send({
        type: "vision_response", requestId: message.requestId,
        observation: { sceneSummary: "附近是森林，左右坡地都有多棵可接近的橡树。", hazards: [], confidence: 0.95 },
      });
    }
    if (message?.type === "llm_task_report") {
      const report = message.report;
      const expectedCommand = scenario === "follow" ? "跟随" : scenario === "eat" ? "吃东西" : scenario === "wood" ? "采集 1 个木头" : scenario === "opinion" ? null : "状态";
      const expectedReplies = scenario === "eat" ? 0 : scenario === "follow" ? 1 : 2;
      const modelReplies = progress.filter((item) => item.startsWith("Minecraft 模型回复："));
      const acceptedStatus = scenario === "wood" ? ["completed", "failed"].includes(report?.status)
        : scenario === "follow" ? report?.status === "active" : report?.status === "completed";
      finish({
        ok: acceptedStatus
          && report.steps?.some((step) => expectedCommand ? step.command === expectedCommand : step.command.startsWith("观察 "))
          && (scenario !== "wood" || report.steps?.some((step) => step.command === "观察 周围树木位置"))
          && (scenario !== "wood" || report.status !== "failed" || modelReplies.at(-1)?.includes("没找到木头"))
          && modelReplies.length === expectedReplies,
        scenario, modelReplies, report,
      });
    }
  });
  child.send({ type: "start", settings });
});
