// 纯合成数据；--prepare 不读取模型配置，--run 最多一次请求，--replay 不联网。
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { build } from "esbuild";

const mode = process.argv[2];
if (!["--prepare", "--run", "--replay"].includes(mode)) throw new Error("用法: node scripts/evaluate-life-model.mjs --prepare | --run | --replay");
const root = path.resolve(import.meta.dirname, ".."), project = path.resolve(root, "..");
const output = path.join(root, ".test-runtime", "life-model-batch");
for (const directory of [path.join(root, ".test-runtime"), output]) {
  fs.mkdirSync(directory, { recursive: true });
  if (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory).toLowerCase() !== directory.toLowerCase()) throw new Error("评测目录不能经过链接");
}
const sha = (value) => createHash("sha256").update(value).digest("hex");
function writeOutput(name, value, exclusive = false) {
  const file = path.join(output, name);
  if (path.dirname(file) !== output) throw new Error("输出文件越界");
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(file).toLowerCase() !== file.toLowerCase()) throw new Error("输出文件不能经过链接");
  }
  fs.writeFileSync(file, JSON.stringify(value, null, 2), exclusive ? { flag: "wx" } : undefined);
}
const bundle = await build({ stdin: { contents: 'export * from "./plugins/companion-chat/src/life-planning"; export * from "./plugins/companion-chat/src/proactive-prompt";',
  resolveDir: root, loader: "ts" }, bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent" });
const source = bundle.outputFiles[0].text, module = { exports: {} };
new Function("module", "exports", source)(module, module.exports);
const { buildLifePlanningMessages, parseLifePlan, buildProactiveMessages, parseProactiveDecision } = module.exports;
const time = (hour, minute = 0) => new Date(2026, 8, 26, hour, minute).getTime();
const daily = { kind: "daily", date: "2026-09-26", revision: 10,
  windows: [{ id: "morning", startAt: time(9, 30), endAt: time(12) }, { id: "afternoon", startAt: time(12), endAt: time(18) }, { id: "evening", startAt: time(18), endAt: time(23) }],
  activities: ["读书", "学习", "听歌", "散步", "做园艺", "休息片刻"],
  self: { energy: 80, focus: 75, restNeed: 20, activity: "读书", habits: { "读书": 120, "听歌": 60 } } };
const tired = { ...daily, kind: "refine", revision: 11, windows: [{ id: "near", startAt: time(14, 30), endAt: time(15) }],
  self: { ...daily.self, energy: 18, focus: 15, restNeed: 85 } };
const goal = { ...daily, revision: 12, goals: [{ id: "goal-synthetic", title: "继续阅读自己的故事书", activity: "读书" }] };
const cases = [
  ...[["daily", daily], ["tired-refine", tired], ["goal-daily", goal]].map(([id, input]) => ({ id, input, messages: buildLifePlanningMessages(input) })),
  { id: "event-share", messages: buildProactiveMessages({ basePersona: "你是一位自然、温和的虚构角色。",
    ordinaryHistory: [], proactiveHistory: [], sceneId: "life_share", localNow: new Date(time(16)), idleSec: 30, unansweredCount: 0,
    lifeContext: "[你的生活]\n[本次生活分享来源]\n事件 synthetic-event-1：今天下午在自己的世界读书。这是运行期间完成的模拟活动；没有书名或具体情节证据。最多分享这一条，也可以保持安静。不得声称操作真实设备，不得虚构用户事实。" }) },
];
const messages = [{ role: "system", content: "这是一次合成案例批量评测。分别执行每个案例 messages 中的任务，互不混用数据。只返回一个JSON对象：{\"cases\":[{\"id\":\"原case id\",\"output\":该案例要求的JSON对象}]}。恰好返回全部案例，不解释，不使用Markdown。" },
  { role: "user", content: JSON.stringify(cases.map(({ id, messages }) => ({ id, messages }))) }];
const prepared = { version: 1, sourceSha256: sha(source), promptSha256: sha(JSON.stringify(messages)), cases, messages };
const preparedPath = path.join(output, "prepared.json"), resultPath = path.join(output, "result.json");
if (mode === "--prepare") {
  if (fs.existsSync(path.join(output, "attempt.json"))) throw new Error("已有一次调用记录，不能重新准备后重复调用");
  writeOutput("prepared.json", prepared);
  console.log(JSON.stringify({ prepared: true, syntheticCases: cases.length, promptSha256: prepared.promptSha256, output }));
  process.exit(0);
}
const frozen = JSON.parse(fs.readFileSync(preparedPath, "utf8"));
if (mode === "--run" && (frozen.promptSha256 !== prepared.promptSha256 || frozen.sourceSha256 !== prepared.sourceSha256)) throw new Error("正式提示词或解析器已变化，请在调用前重新prepare；已调用则保留原结果，禁止自动追加调用");
if (mode === "--run") {
  const configPath = path.resolve(project, "..", "AppData", "Roaming", "live2d-cyrene-n", "model-settings.json");
  if (fs.lstatSync(configPath).isSymbolicLink() || fs.realpathSync(configPath).toLowerCase() !== configPath.toLowerCase()) throw new Error("模型配置路径经过链接");
  const bytes = fs.readFileSync(configPath), configHash = sha(bytes);
  const config = JSON.parse(bytes.toString("utf8"));
  const profile = config.modelProfiles?.find((item) => item.id === config.defaultModelProfileId);
  if (![profile?.provider, profile?.baseUrl, profile?.model, profile?.apiKey].every((item) => typeof item === "string" && item.trim())) throw new Error("默认主模型配置不完整");
  const cfg = { provider: profile.provider, baseUrl: profile.baseUrl, model: profile.model, apiKey: profile.apiKey,
    explicitTransport: profile.explicitTransport, reasoning: profile.reasoning ?? config.reasoning };
  const require = createRequire(import.meta.url);
  const { getAdapterForConfig } = require(path.join(project, "dist/main/main/orchestrator/vendors/index.js"));
  const adapter = getAdapterForConfig(cfg);
  const request = adapter.buildRequest({ model: cfg.model, messages, stream: false, maxTokens: 8192 }, cfg);
  const url = new URL(request.url), configured = new URL(cfg.baseUrl);
  if (url.origin !== configured.origin || url.username || url.password || (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("请求目标与已配置主模型不一致");
  const started = Date.now();
  // Exclusive marker survives timeout/failure, so rerunning cannot spend another request.
  writeOutput("attempt.json", { at: new Date(started).toISOString(), promptSha256: prepared.promptSha256,
    model: cfg.model, provider: cfg.provider, configSha256: configHash, maxTokens: 8192, maxRequests: 1 }, true);
  console.log(JSON.stringify({ status: "calling-once", model: cfg.model, cases: cases.length }));
  try {
    const response = await fetch(request.url, { method: "POST", redirect: "error", headers: request.headers, body: request.body, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = adapter.parseResponse(await response.json());
    writeOutput("result.json", { text: parsed.text, usage: parsed.usage, finishReason: parsed.finishReason,
      latencyMs: Date.now() - started, configUnchanged: sha(fs.readFileSync(configPath)) === configHash }, true);
  } catch {
    writeOutput("failure.json", { status: "failed-no-retry", latencyMs: Date.now() - started,
      configUnchanged: sha(fs.readFileSync(configPath)) === configHash });
    throw new Error("单次模型验证失败，已停止且不会自动重试；不回显响应正文或凭据");
  }
}
const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
let parsed;
try { parsed = JSON.parse(result.text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1")); }
catch { throw new Error("批量输出不是完整JSON；保留结果，不追加调用"); }
const testedCases = mode === "--replay" ? frozen.cases : cases;
if (!Array.isArray(parsed.cases) || parsed.cases.length !== testedCases.length || new Set(parsed.cases.map((item) => item.id)).size !== testedCases.length) throw new Error("案例数量或ID不匹配");
const checks = testedCases.map((item) => {
  const answer = parsed.cases.find((answer) => answer.id === item.id)?.output;
  try {
    const decision = item.input ? parseLifePlan(JSON.stringify(answer), item.input) : parseProactiveDecision(JSON.stringify(answer));
    const behaviorPassed = item.id === "tired-refine" ? decision.windows[0].activities[0] === "休息片刻"
      : item.id === "goal-daily" ? decision.windows.some((window) => window.activities.includes("读书")) : true;
    return { id: item.id, passed: decision.kind !== "invalid" && behaviorPassed && result.finishReason === "stop",
      behaviorPassed, manualTextReviewRequired: item.id === "event-share" && decision.kind === "send", output: decision };
  } catch { return { id: item.id, passed: false }; }
});
const report = { oneRequest: true, syntheticOnly: true, configUnchanged: result.configUnchanged,
  usage: result.usage, latencyMs: result.latencyMs, checks, frozenSourceSha256: frozen.sourceSha256, parserSourceSha256: prepared.sourceSha256,
  limitation: "批量协议及固定行为检查；主动文案仍须人工复核，不等同于各请求单独运行或生产部署验收。" };
writeOutput("report.json", report);
console.log(JSON.stringify(report));
if (checks.some((item) => !item.passed) || !result.configUnchanged) process.exitCode = 1;
