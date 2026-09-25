import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const containerRoot = path.basename(projectRoot) === ".upstream-latest" ? path.dirname(projectRoot) : projectRoot;
const settingsPath = path.join(containerRoot, "AppData", "Roaming", "live2d-cyrene-n", "model-settings.json");
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
const profile = settings.modelProfiles?.find((item) => item.id === settings.defaultModelProfileId);
if (!profile) throw new Error("找不到当前默认模型档案");
const baseUrl = new URL(profile.baseUrl);
if (!new Set(["127.0.0.1", "localhost", "::1"]).has(baseUrl.hostname)) {
  throw new Error("本验收只允许调用本机模型端点");
}
if (profile.explicitTransport !== "openai") throw new Error("当前模型档案不是 OpenAI-compatible 传输");
const endpoint = new URL(`${baseUrl.pathname.replace(/\/$/, "")}/chat/completions`, baseUrl);
const modelsEndpoint = new URL(`${baseUrl.pathname.replace(/\/$/, "")}/models`, baseUrl);
const headers = {
  "content-type": "application/json",
  ...(profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}),
};

async function request(url, init) {
  const startedAt = Date.now();
  const response = await fetch(url, { ...init, headers: { ...headers, ...init?.headers }, signal: AbortSignal.timeout(180_000) });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${url.pathname} 返回 HTTP ${response.status}: ${raw.slice(0, 500)}`);
  return { body: JSON.parse(raw), durationMs: Date.now() - startedAt };
}

async function completion(messages, extra = {}) {
  return request(endpoint, {
    method: "POST",
    body: JSON.stringify({ model: profile.model, stream: false, messages, max_tokens: 256, ...extra }),
  });
}

const models = await request(modelsEndpoint, { method: "GET" });
const listedModels = Array.isArray(models.body?.data) ? models.body.data.map((item) => item?.id).filter(Boolean) : [];
if (!listedModels.includes(profile.model)) throw new Error(`模型列表中没有当前模型 ${profile.model}`);

const plain = await completion([
  { role: "system", content: "这是本地隔离验收。只回复 LOCAL_OK。" },
  { role: "user", content: "开始验收。" },
]);
const plainChoice = plain.body?.choices?.[0];
if (typeof plainChoice?.message?.content !== "string" || !plainChoice.message.content.trim()) {
  throw new Error("普通回复没有返回文本");
}

const tool = await completion([
  { role: "system", content: "必须调用提供的工具，不要直接回答。" },
  { role: "user", content: "请用工具读取验收值 alpha。" },
], {
  tools: [{
    type: "function",
    function: {
      name: "echo_probe",
      description: "读取隔离验收值",
      parameters: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
        additionalProperties: false,
      },
    },
  }],
  tool_choice: "required",
});
const toolCalls = tool.body?.choices?.[0]?.message?.tool_calls;
if (!Array.isArray(toolCalls) || toolCalls[0]?.function?.name !== "echo_probe") {
  throw new Error("模型未按 OpenAI-compatible 格式返回工具调用");
}
const toolArguments = JSON.parse(toolCalls[0].function.arguments || "{}");
if (toolArguments.key !== "alpha") throw new Error("工具调用参数不正确");

console.log(JSON.stringify({
  ok: true,
  endpoint: { protocol: baseUrl.protocol, host: baseUrl.hostname, port: baseUrl.port, path: baseUrl.pathname },
  model: profile.model,
  models: { durationMs: models.durationMs, listed: listedModels.length },
  plain: { durationMs: plain.durationMs, finishReason: plainChoice.finish_reason, usage: plain.body.usage ?? null },
  tool: { durationMs: tool.durationMs, finishReason: tool.body?.choices?.[0]?.finish_reason, callName: toolCalls[0].function.name },
  vision: { liveCallSkipped: true, reason: "未配置独立视觉模型；由离线通路测试覆盖" },
}, null, 2));
