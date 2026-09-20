// 仅在 -N 内验证原生 Chat 的提示词组装和一次真实模型回复；不启动 Electron。
// 原版模型配置只读，不复制用户历史或记忆，不输出请求体和密钥。
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const projectRoot = path.resolve(__dirname, "..", "..");
const originalRoot = path.resolve(projectRoot, "..", "..", "Cyrene-Agent");
if (!projectRoot.endsWith(`${path.sep}Cyrene-Agent-N${path.sep}.upstream-latest`)
  || !fs.statSync(originalRoot).isDirectory()) throw new Error("项目隔离边界不符");
process.env.ELECTRON_OVERRIDE_DIST_PATH = path.resolve(projectRoot, "..");
const { buildAgentRunOptions } = require(path.join(projectRoot, "dist/main/main/orchestrator/build-options.js"));
const { buildModePrompt } = require(path.join(projectRoot, "dist/main/main/orchestrator/mode-prompt-profile.js"));
const { buildHarnessPromptLayers } = require(path.join(projectRoot, "dist/main/main/orchestrator/harness/adapter/prompt-builder.js"));
const { composePromptLayers } = require(path.join(projectRoot, "dist/main/main/orchestrator/prompt-layers.js"));
const { getAdapterForConfig } = require(path.join(projectRoot, "dist/main/main/orchestrator/vendors/index.js"));
const { snapshotTree } = require("./isolation-boundary.mjs");

const originalConfig = path.join(process.env.APPDATA || "", "live2d-cyrene", "model-settings.json");
if (!path.isAbsolute(originalConfig) || !fs.existsSync(originalConfig)) throw new Error("找不到原版模型配置");
const config = JSON.parse(fs.readFileSync(originalConfig, "utf8"));
const profile = config.perProvider?.[config.provider] ?? config;
if (config.provider !== "Kimi（月之暗面）" || profile.model !== "kimi-k2.6" || !profile.apiKey) {
  throw new Error("原版主模型不是已授权的 Kimi K2.6");
}
const endpoint = new URL(profile.baseUrl);
if (endpoint.protocol !== "https:" || endpoint.hostname !== "api.moonshot.cn") {
  throw new Error("模型入口不是官方 Kimi HTTPS 地址");
}
const cfg = {
  provider: config.provider, baseUrl: profile.baseUrl, model: profile.model,
  apiKey: profile.apiKey, explicitTransport: profile.explicitTransport ?? config.explicitTransport,
  reasoning: profile.reasoning ?? config.reasoning,
};
const promptFiles = ["chat_system.md", "chat_identity.md", "soul.md", "canon_quotes.md"];
const loadPrompt = (name) => {
  if (!promptFiles.includes(name)) throw new Error("意外的提示词文件");
  return fs.readFileSync(path.join(projectRoot, "prompts", name), "utf8").trim();
};
const syntheticMemory = "[插件记忆]\n用户刚刚明确说：今天想给窗台上的薄荷浇水。只用这条事实回答，不扩展到真实历史。";
const question = "我刚才说今天想做什么？请用一句自然的中文回答。";
const deps = {
  loadModelSettings: () => cfg,
  loadGeneralSettings: () => ({ currentStyleId: "default", nativeChatMemoryEnabled: false,
    chatToolsEnabled: false, customStyle: { diversity: { driver: "model-default" }, repetition: "model-default" },
    chatSocialContextEnabled: false }),
  loadUserProfile: () => ({}), buildEnvironmentContext: () => "",
  buildSkillCatalog: () => "", buildAutoInjectedSkillContext: () => "",
  skillRegistry: { getEnabled: () => [], getEnabledForMode: () => [], getBody: () => null },
  resolveSlashActivation: () => "", buildToneInjection: async () => "",
  sceneEmbeddingIndex: null, getSceneEmbeddingProvider: () => null,
  buildAlwaysOnContext: async () => "", buildRelationshipContext: async () => "",
  buildModePrompt: (mode) => buildModePrompt(mode, loadPrompt),
  buildToolSystemPrompt: () => "", buildSoulSystemBasePrompt: () => "",
  readStylePrompt: () => "", resolveSoulSampling: () => ({}),
  toolRegistry: { getEnabled: () => [], getEnabledToolsForMode: () => [] },
  normalizeChatMessages: (raw) => raw, chatRequestTimeoutMs: 45_000,
  buildPluginPromptContext: async () => syntheticMemory,
};
const protectedRoots = {
  roaming: path.join(process.env.APPDATA, "live2d-cyrene"),
  local: path.join(process.env.LOCALAPPDATA, "live2d-cyrene"),
  userData: path.join(originalRoot, "UserData"),
  backup: path.join(originalRoot, "UserData_backup"),
};
const digest = () => Object.fromEntries(Object.entries(protectedRoots)
  .map(([key, root]) => [key, snapshotTree(root)]));

async function main() {
  const { options } = await buildAgentRunOptions({
    sessionId: "isolated-kimi-check", mode: "chat", executionMode: "chat",
    nativeChatMemoryEnabledSnapshot: false,
    messages: [{ role: "user", content: question }],
  }, deps);
  const layers = buildHarnessPromptLayers(options);
  const composed = composePromptLayers(layers, options.messages);
  const adapter = getAdapterForConfig(cfg);
  const request = adapter.applyCacheHints({
    model: cfg.model, messages: composed.messages, promptLayers: composed.metadata,
    stream: false, maxTokens: 256,
  }, cfg);
  const http = adapter.buildRequest(request, cfg);
  const body = JSON.parse(http.body);
  if (options.tools.length || body.tools || body.stream !== false || body.max_tokens !== 256
    || body.messages.length > 4 || body.messages.at(-1)?.content?.indexOf(syntheticMemory) < 0
    || new URL(http.url).hostname !== "api.moonshot.cn") throw new Error("有意外工具、请求或上下文");
  const report = {
    baseline: "eb6c311a908c4da701869fff341972bac914b4aa",
    model: cfg.model, calls: 0, maxOutputTokens: 256,
    inputChars: http.body.length, promptDigest: createHash("sha256").update(http.body).digest("hex"),
    pluginMemoryInRuntime: options.soulRuntimeContext.includes(syntheticMemory),
    pluginMemoryInStablePrefix: layers.stablePrefix.includes(syntheticMemory),
    nativeMemoryTools: options.tools.length, protectedRootsUnchanged: null,
  };
  if (process.argv.includes("--dry-run")) {
    console.log(JSON.stringify({ ...report, dryRun: true }));
    return;
  }
  if (process.env.CYRENE_REAL_MODEL_TEST !== "1") throw new Error("真实请求需要显式测试开关");
  const before = digest();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    report.calls = 1;
    const result = await fetch(http.url, {
      method: "POST", headers: http.headers, body: http.body, signal: controller.signal,
    });
    report.httpStatus = result.status;
    if (!result.ok) throw new Error(`Kimi HTTP ${result.status}`);
    const parsed = adapter.parseResponse(await result.json());
    report.usage = parsed.usage ?? null;
    report.replyChars = parsed.text.length;
    report.replyMentionsMint = parsed.text.includes("薄荷");
    report.replyMentionsWater = parsed.text.includes("浇水");
    report.replyHasToolProtocol = /<tool_call|\[tool_call\]|<invoke/.test(parsed.text);
    report.finishReason = parsed.finishReason;
    console.log(`[bounded-kimi-chat-check] 回复：${parsed.text.slice(0, 160)}`);
  } finally {
    clearTimeout(timer);
    const after = digest();
    report.changedRoots = Object.keys(before).filter((key) => before[key] !== after[key]);
    report.protectedRootsUnchanged = report.changedRoots.length === 0;
    fs.writeFileSync(path.join(projectRoot, "local-plugins", "BOUNDED-KIMI-CHAT-CHECK.json"),
      JSON.stringify(report, null, 2));
    console.log(`[bounded-kimi-chat-check] ${JSON.stringify(report)}`);
    if (!report.protectedRootsUnchanged) throw new Error("正式用户数据校验不一致");
  }
}

main().catch((error) => {
  console.error(`[bounded-kimi-chat-check] ${error?.message ?? String(error)}`);
  process.exitCode = 1;
});
