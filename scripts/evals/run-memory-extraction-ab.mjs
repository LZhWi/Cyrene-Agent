import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const [outputDir, mode, runName] = process.argv.slice(2);
if (!outputDir || !["--preflight", "--run", "--run-production"].includes(mode)
  || (mode !== "--preflight" && !/^[a-z0-9-]{3,80}$/.test(runName ?? ""))) {
  throw new Error("用法: node run-memory-extraction-ab.mjs <评测目录> --preflight | --run <小写运行名> | --run-production <小写运行名>");
}
const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const localRoot = path.resolve(projectRoot, "..", "..", "Cyrene-Agent");
const userData = path.resolve(projectRoot, "..", "AppData", "Roaming", "live2d-cyrene-n");
const read = (name) => JSON.parse(fs.readFileSync(path.join(outputDir, name), "utf8"));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const fileHash = (file) => sha(fs.readFileSync(file));
const corpus = read("corpus.json"), local = read("local-prompts.json"), n = read("n-prompts.json"), rubric = read("rubric.json");
const sessionPath = path.join(userData, "cyrene-chats", "sessions", `${corpus.sourceSessionId}.json`);
if (fs.existsSync(sessionPath) && fileHash(sessionPath) !== corpus.sourceSha256) {
  console.warn("原始会话已变化；本轮仍只使用冻结的语料和提示词");
}
if (fileHash(path.join(localRoot, "src", "main", "memory", "memory-judge.ts")) !== local.sourceSha256
  || fileHash(path.join(projectRoot, "local-plugins", "plugins", "companion-memory", "src", "memory-extraction.ts")) !== n.sourceSha256) {
  console.warn("提取源码已变化；本轮仍只使用冻结的提示词，不代表当前生产版本");
}
if (corpus.cases.length !== 3 || local.prompts.length !== 6 || n.prompts.length !== 6
  || rubric.cases.length !== 3 || rubric.writtenBeforeModelCalls !== true) throw new Error("评测矩阵或预登记量表不完整");
const cells = [];
for (const item of corpus.cases) {
  if (item.turns.length !== 12 || new Set(item.turns.map((turn) => turn.userMessageId)).size !== 12) throw new Error("语料轮次重复或不足");
  for (const size of [8, 12]) for (const variant of ["local", "n"]) {
    const matched = (variant === "local" ? local : n).prompts.filter((prompt) => prompt.caseId === item.id && prompt.size === size);
    if (matched.length !== 1 || !["system,user", ...(variant === "n" ? ["user"] : [])].includes(matched[0].messages.map((message) => message.role).join(","))) {
      throw new Error(`提示词角色或数量无效: ${item.id}/${variant}/${size}`);
    }
    const joined = matched[0].messages.map((message) => message.content).join("\n");
    for (const turn of item.turns.slice(-size)) if (!joined.includes(turn.user) || !joined.includes(turn.assistant)) {
      throw new Error(`提示词漏掉原始消息: ${item.id}/${variant}/${size}`);
    }
    if (variant === "n" && (!joined.includes(`T1～T${size}`)
      || !/T1（(?:只读上下文|第 1 轮，只读上下文)）：/.test(joined)
      || !/T3（(?:可写|第 3 轮，可写)）：/.test(joined))) throw new Error(`-N 来源约束无效: ${item.id}/${size}`);
    if (variant === "local" && !joined.includes("T1～T8")) throw new Error(`本地来源范围意外改变: ${item.id}/${size}`);
    cells.push({ caseId: item.id, size, variant, production: (variant === "local" && size === 8) || (variant === "n" && size === 12),
      messages: matched[0].messages, promptSha256: sha(JSON.stringify(matched[0].messages)) });
  }
}
if (cells.length !== 12) throw new Error("必须恰好有 12 个实验单元");
if (cells.filter((cell) => cell.variant === "n").some((cell) => {
  const instructions = cell.messages.map((message) => message.content).join("\n").split("\n最近对话：\n")[0];
  return !["one_off", "situational", "stable", "low", "medium", "high"].every((value) => instructions.includes(value));
})) throw new Error("-N 冻结提示词未列出解析器要求的 importance/stability 枚举；拒绝追加模型调用");
const config = JSON.parse(fs.readFileSync(path.join(userData, "model-settings.json"), "utf8"));
const profile = config.modelProfiles?.find((item) => item.id === config.defaultModelProfileId);
if (!profile?.apiKey || !profile?.model || !profile?.baseUrl || !profile?.provider) throw new Error("默认主模型档案不可用");
const cfg = { provider: profile.provider, baseUrl: profile.baseUrl, model: profile.model,
  apiKey: profile.apiKey, explicitTransport: profile.explicitTransport, reasoning: { mode: "on" } };
const require = createRequire(import.meta.url);
const { getAdapterForConfig } = require(path.join(projectRoot, "dist", "main", "main", "orchestrator", "vendors", "index.js"));
const adapter = getAdapterForConfig(cfg);
const makeRequest = (cell) => adapter.buildRequest({ model: cfg.model, messages: cell.messages,
  maxTokens: 32768, stream: false }, cfg);
const requests = cells.map(makeRequest);
const host = new URL(requests[0].url).hostname;
if (host !== new URL(profile.baseUrl).hostname || requests.some((request) => request.url !== requests[0].url)) {
  throw new Error("模型请求目标与配置不一致");
}
const parameters = requests.map((request) => {
  const { messages, ...rest } = JSON.parse(request.body);
  return rest;
});
if (parameters.some((value) => JSON.stringify(value) !== JSON.stringify(parameters[0]))) {
  throw new Error("除提示词外模型请求参数不同");
}
const preflight = { version: 1, cells: cells.map(({ caseId, size, variant, production, promptSha256 }) =>
  ({ caseId, size, variant, production, promptSha256 })), sourceSha256: corpus.sourceSha256,
  rubricSha256: fileHash(path.join(outputDir, "rubric.json")),
  requestParameters: parameters[0], requestHost: host,
  note: "本地 12 与 -N 8 为非生产压力测试；生产条件分别为本地 8 与 -N 12。所有请求参数相同，仅提示词不同。",
};
const preflightPath = path.join(outputDir, "preflight.json");
if (!fs.existsSync(preflightPath)) fs.writeFileSync(preflightPath, JSON.stringify(preflight, null, 2) + "\n", { flag: "wx" });
else {
  const frozen = JSON.parse(fs.readFileSync(preflightPath, "utf8"));
  if (JSON.stringify(frozen.cells) !== JSON.stringify(preflight.cells)
    || frozen.sourceSha256 !== preflight.sourceSha256 || frozen.rubricSha256 !== preflight.rubricSha256) {
    throw new Error("冻结的语料、提示词或量表已变化；拒绝调用模型");
  }
}
console.log(JSON.stringify({ status: "preflight-ok", cells: cells.length, model: profile.model,
  provider: profile.provider, host, productionCells: cells.filter((cell) => cell.production).length }));
if (mode === "--preflight") process.exit(0);

const runDir = path.join(outputDir, "runs", runName);
fs.mkdirSync(runDir, { recursive: true });
const fullOrder = ["conditional-plan/local/8", "conditional-plan/n/8", "conditional-plan/local/12", "conditional-plan/n/12",
  "project-commitment/n/12", "project-commitment/local/12", "project-commitment/n/8", "project-commitment/local/8",
  "dated-travel/local/12", "dated-travel/n/12", "dated-travel/local/8", "dated-travel/n/8"];
const order = mode === "--run-production"
  ? ["conditional-plan/local/8", "conditional-plan/n/12", "project-commitment/n/12",
    "project-commitment/local/8", "dated-travel/local/8", "dated-travel/n/12"]
  : fullOrder;
const manifestPath = path.join(runDir, "manifest.json");
const manifest = { version: 1, createdAt: new Date().toISOString(), runName, model: profile.model,
  provider: profile.provider, profileId: profile.id, host, transport: profile.explicitTransport,
  reasoning: "on", maxTokens: 32768, timeoutMs: 300000, requestParameters: parameters[0],
  promptVersionSha256: fileHash(preflightPath), order,
  note: "单次调用，无自动重试；生成随机性不可消除，保留逐次原始输出和使用量。" };
if (!fs.existsSync(manifestPath)) fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
else {
  const previous = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (previous.model !== manifest.model || previous.provider !== manifest.provider || previous.profileId !== manifest.profileId
    || previous.host !== manifest.host || previous.promptVersionSha256 !== manifest.promptVersionSha256
    || JSON.stringify(previous.order) !== JSON.stringify(manifest.order)
    || (previous.requestParameters && JSON.stringify(previous.requestParameters) !== JSON.stringify(manifest.requestParameters))) {
    throw new Error("运行目录已有不同模型、请求参数或提示词版本");
  }
}
for (const [index, key] of order.entries()) {
  const [caseId, variant, rawSize] = key.split("/");
  const size = Number(rawSize), cell = cells.find((value) => value.caseId === caseId && value.variant === variant && value.size === size);
  if (!cell) throw new Error(`未找到实验单元 ${key}`);
  const file = path.join(runDir, `${caseId}-${variant}-${size}.json`);
  if (fs.existsSync(file)) { console.log(JSON.stringify({ index: index + 1, key, status: "already-recorded" })); continue; }
  console.log(JSON.stringify({ index: index + 1, key, status: "calling" }));
  const startedAt = new Date().toISOString(), started = Date.now();
  try {
    const request = makeRequest(cell);
    const response = await fetch(request.url, { method: "POST", headers: request.headers,
      body: request.body, signal: AbortSignal.timeout(300000) });
    const data = await response.json();
    const parsed = response.ok ? adapter.parseResponse(data) : undefined;
    const record = { caseId, size, variant, production: cell.production, model: profile.model,
      promptSha256: cell.promptSha256, startedAt, finishedAt: new Date().toISOString(), latencyMs: Date.now() - started,
      httpStatus: response.status, text: parsed?.text ?? "", usage: parsed?.usage ?? null,
      response: data };
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ index: index + 1, key, status: response.ok ? "saved" : "http-error",
      latencyMs: record.latencyMs, outputChars: record.text.length, usage: record.usage }));
    if (!response.ok || !record.text.trim()) throw new Error(`请求 ${key} 未产生有效正文；已记录并停止，不自动重试`);
  } catch (error) {
    console.error(JSON.stringify({ index: index + 1, key, status: "stopped", error: String(error) }));
    process.exitCode = 1;
    break;
  }
}
