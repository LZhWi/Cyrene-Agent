const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const childProcess = require("node:child_process");
const electron = require("electron");

const { app, BrowserWindow, globalShortcut } = electron;

process.on("unhandledRejection", (reason) => {
  if (reason instanceof Error && reason.message === "E_ISOLATED_SMOKE_CHILD_PROCESS_BLOCKED") {
    console.log("[isolated-smoke] 已拦截截图辅助进程");
    return;
  }
  console.error("[isolated-smoke] 未处理的 Promise 拒绝", reason);
  process.exitCode = 125;
});
const localRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(localRoot, "..");
const directProject = path.basename(projectRoot) === "Cyrene-Agent-N";
const latestWorktree = path.basename(projectRoot) === ".upstream-latest"
  && path.basename(path.dirname(projectRoot)) === "Cyrene-Agent-N";
const visible = process.env.CYRENE_ISOLATED_VISIBLE === "1";
const nativeTurn = process.env.CYRENE_ISOLATED_NATIVE_TURN === "1";
const nativeUiTurn = process.env.CYRENE_ISOLATED_NATIVE_UI_TURN === "1";
const boundedModelUiTurn = process.env.CYRENE_ISOLATED_BOUNDED_MODEL_UI === "1";
const liveModel = process.env.CYRENE_ISOLATED_LIVE_MODEL === "1";
const realSnapshot = process.env.CYRENE_ISOLATED_REAL_SNAPSHOT === "1";
const realImportAudit = process.env.CYRENE_ISOLATED_REAL_IMPORT_AUDIT === "1";
const companionAcceptance = process.env.CYRENE_ISOLATED_COMPANION_ACCEPTANCE === "1";
const visibleProbe = process.env.CYRENE_ISOLATED_VISIBLE_PROBE === "1";
const runName = visible ? "visible-electron-host" : "full-electron-host";
const runRoot = process.env.CYRENE_ISOLATED_RUN_ROOT;
const userDataRoot = path.join(runRoot, "user-data");
const modelTest = { fixtureCalls: 0, liveCalls: 0, unexpectedModelCalls: 0,
  toolPhaseCalls: 0, soulPhaseCalls: 0, visionFixtureCalls: 0,
  memoryToolRequested: false, memoryToolResultObserved: false,
  screenToolRequested: false, screenToolResultObserved: false,
  secondRequestHadPluginMemory: false, secondReplySaved: false, secondTurnCaptured: false,
  screenReplySaved: false, screenTurnCaptured: false,
  realSnapshotMemoryInjected: false, realSnapshotInjectedCount: 0,
  realSnapshotProviderChars: 0, outputTokenCap: null, streamAudit: null, usage: null };
const firstModelQuestion = "今天想给窗台上的薄荷浇水，请记住。";
const secondModelQuestion = "我刚才说要给窗台上的薄荷做什么？请一句话回答。";
const screenModelQuestion = "请观察当前屏幕，并用一句话说明你看到了什么。";
const fixtureReply = "我记住了，你今天想给窗台上的薄荷浇水。";
const screenVisionFixture = "当前屏幕观察请求已由隔离测试接管，图像没有外发。";
const screenReplyFixture = "我看到的是隔离测试窗口。";
let boundedModelPassed = false;
let firstTurnCaptured = false;
let snapshotProbe = null;
let streamAuditTask = null;

async function auditModelStream(response) {
  const raw = await response.clone().text();
  const summary = { finishReason: null, visibleChars: 0, reasoningChars: 0,
    promptTokens: null, completionTokens: null };
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    let chunk;
    try { chunk = JSON.parse(line.slice(6)); } catch { continue; }
    const choice = chunk?.choices?.[0];
    if (typeof choice?.delta?.content === "string") summary.visibleChars += choice.delta.content.length;
    for (const field of ["reasoning_content", "thinking", "reasoning"]) {
      if (typeof choice?.delta?.[field] === "string") summary.reasoningChars += choice.delta[field].length;
    }
    if (typeof choice?.finish_reason === "string") summary.finishReason = choice.finish_reason;
    if (Number.isSafeInteger(chunk?.usage?.prompt_tokens)) summary.promptTokens = chunk.usage.prompt_tokens;
    if (Number.isSafeInteger(chunk?.usage?.completion_tokens)) summary.completionTokens = chunk.usage.completion_tokens;
  }
  modelTest.streamAudit = summary;
}

function fixtureStream(text) {
  const chunk = (delta, finishReason, usage) => JSON.stringify({
    id: "isolated-fixture", object: "chat.completion.chunk", created: 1, model: "kimi-k2.6",
    choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}),
  });
  const payload = `data: ${chunk({ role: "assistant", content: text }, null)}\n\n`
    + `data: ${chunk({}, "stop", { prompt_tokens: 0, completion_tokens: 0 })}\n\n`
    + "data: [DONE]\n\n";
  return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function fixtureToolCallStream(name, args, id) {
  const chunk = (delta, finishReason, usage) => JSON.stringify({
    id: "isolated-fixture", object: "chat.completion.chunk", created: 1, model: "kimi-k2.6",
    choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}),
  });
  const payload = `data: ${chunk({ role: "assistant", tool_calls: [{
    index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) },
  }] }, null)}\n\n`
    + `data: ${chunk({}, "tool_calls", { prompt_tokens: 0, completion_tokens: 0 })}\n\n`
    + "data: [DONE]\n\n";
  return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function fixtureVisionResponse(text) {
  return new Response(JSON.stringify({
    id: "isolated-vision", object: "chat.completion", created: 1, model: "kimi-k2.6",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function assertExactRunRoot() {
  const expectedParent = path.join(localRoot, ".test-runtime", runName);
  if ((!directProject && !latestWorktree)
    || path.resolve(path.dirname(runRoot)).toLowerCase() !== path.resolve(expectedParent).toLowerCase()
    || !/^run-\d+-[0-9a-f-]{36}$/.test(path.basename(runRoot))) {
    throw new Error(`完整宿主测试目录越界: ${runRoot}`);
  }
  for (const dir of [projectRoot, ...(latestWorktree ? [path.dirname(projectRoot)] : []), localRoot, path.join(localRoot, ".test-runtime"), expectedParent, runRoot]) {
    const entry = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!entry?.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`完整宿主测试目录不是普通目录: ${dir}`);
    }
  }
}

function ensureRunSubdirectory(relative) {
  let current = runRoot;
  for (const name of relative.split(/[\\/]+/)) {
    if (!name || name === "." || name === "..") throw new Error(`非法隔离子目录: ${relative}`);
    current = path.join(current, name);
    const entry = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!entry) fs.mkdirSync(current);
    const created = fs.lstatSync(current);
    if (!created.isDirectory() || created.isSymbolicLink()) throw new Error(`隔离子目录不是普通目录: ${current}`);
  }
  return current;
}

function prepareFilesystem() {
  assertExactRunRoot();

  const paths = {
    appData: path.join(runRoot, "app-data"),
    localAppData: path.join(runRoot, "local-app-data"),
    userData: userDataRoot,
    sessionData: path.join(runRoot, "session-data"),
    temp: path.join(runRoot, "temp"),
    home: path.join(runRoot, "home"),
    desktop: path.join(runRoot, "external", "desktop"),
    documents: path.join(runRoot, "external", "documents"),
    downloads: path.join(runRoot, "external", "downloads"),
    music: path.join(runRoot, "external", "music"),
    pictures: path.join(runRoot, "external", "pictures"),
    videos: path.join(runRoot, "external", "videos"),
    recent: path.join(runRoot, "external", "recent"),
    logs: path.join(runRoot, "logs"),
    crashDumps: path.join(runRoot, "crash-dumps"),
  };
  for (const target of Object.values(paths)) ensureRunSubdirectory(path.relative(runRoot, target));
  for (const [name, target] of Object.entries(paths)) {
    if (name !== "localAppData") app.setPath(name, target);
  }
  app.setAppLogsPath(paths.logs);

  // 主程序内有少数依赖直接调用 os.homedir() 查找模型缓存；测试进程内改为隔离 home。
  os.homedir = () => paths.home;
  os.tmpdir = () => paths.temp;
  process.env.HF_HOME = path.join(paths.home, ".cache", "huggingface");
  process.env.HUGGINGFACE_HUB_CACHE = path.join(process.env.HF_HOME, "hub");
  process.env.TRANSFORMERS_CACHE = path.join(process.env.HF_HOME, "transformers");
  process.env.XDG_CACHE_HOME = path.join(paths.home, ".cache");

  const environmentPaths = {
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    USERPROFILE: paths.home,
    HOME: paths.home,
    TEMP: paths.temp,
    TMP: paths.temp,
    TMPDIR: paths.temp,
  };
  for (const [name, expected] of Object.entries(environmentPaths)) {
    if (process.env[name]?.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`隔离环境变量不匹配: ${name}`);
    }
  }
  for (const [name, target] of Object.entries(paths)) {
    if (name === "localAppData") continue;
    if (app.getPath(name).toLowerCase() !== target.toLowerCase()) {
      throw new Error(`Electron 隔离路径未生效: ${name}`);
    }
  }

  app.setName(visible ? "Cyrene Isolated Preview" : "Cyrene Isolated Full Host Smoke");
  app.setAppUserModelId(visible ? "com.cyrene.isolated-preview" : "com.cyrene.isolated-full-host-smoke");
  // Electron 以本脚本作为入口时会把 scripts/ 视作 appPath；主程序的渲染页、
  // prompts 与资源都以仓库根定位，因此仅在测试进程内恢复真实项目根。
  app.getAppPath = () => projectRoot;
  if (!visible) {
    app.commandLine.appendSwitch("disable-gpu");
    app.disableHardwareAcceleration();
  }
  app.commandLine.appendSwitch("disable-background-networking");

  return paths;
}

function installProcessGuards() {
  // 启动期设置同步不得改变现有 Cyrene 的 Windows 登录项。
  app.setLoginItemSettings = () => undefined;
  // 不注册真实全局热键，避免抢占现有 Cyrene 的快捷键。
  globalShortcut.register = () => true;
  globalShortcut.unregister = () => undefined;
  globalShortcut.unregisterAll = () => undefined;
  // 截图预热、MCP 和渠道辅助程序都不得产生外部进程。
  childProcess.spawn = () => {
    throw new Error("E_ISOLATED_SMOKE_CHILD_PROCESS_BLOCKED");
    // 下一事件循环再报告失败，让调用方先拿到并 await readyPromise，避免制造未处理拒绝。
  };
  childProcess.exec = () => { throw new Error("E_ISOLATED_SMOKE_CHILD_PROCESS_BLOCKED"); };
  childProcess.execFile = () => { throw new Error("E_ISOLATED_SMOKE_CHILD_PROCESS_BLOCKED"); };
  childProcess.fork = () => { throw new Error("E_ISOLATED_SMOKE_CHILD_PROCESS_BLOCKED"); };
  // 合成启动不访问模型或外网；阻断主进程常见网络入口，而非只拦 fetch。
  const blockNetwork = () => { throw new Error("E_ISOLATED_SMOKE_NETWORK_BLOCKED"); };
  const delegateFetch = globalThis.fetch;
  if (boundedModelUiTurn) {
    let modelSocketAllowed = false;
    let modelSocketCount = 0;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const endpoint = new URL(request.url);
      if (endpoint.protocol !== "https:" || endpoint.hostname !== "api.moonshot.cn"
        || endpoint.pathname !== "/v1/chat/completions" || request.method !== "POST") {
        return blockNetwork();
      }
      let body;
      try { body = JSON.parse(await request.text()); } catch { return blockNetwork(); }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const visibleMessages = JSON.stringify(messages);
      const expectedKey = JSON.parse(fs.readFileSync(path.join(userDataRoot, "model-settings.json"), "utf8")).apiKey;
      const isVisionRequest = body.stream === false && visibleMessages.includes('"type":"image_url"');
      if (body.model !== "kimi-k2.6" || visibleMessages.length > (isVisionRequest ? 8_000_000 : 30_000)
        || !request.headers.get("authorization")?.endsWith(expectedKey)
        || modelTest.fixtureCalls + modelTest.liveCalls >= 10) {
        modelTest.unexpectedModelCalls++;
        return blockNetwork();
      }
      if (isVisionRequest) {
        if (!modelTest.screenToolRequested || modelTest.visionFixtureCalls !== 0) {
          modelTest.unexpectedModelCalls++;
          return blockNetwork();
        }
        modelTest.fixtureCalls++;
        modelTest.visionFixtureCalls++;
        return fixtureVisionResponse(screenVisionFixture);
      }
      if (body.stream !== true) {
        modelTest.unexpectedModelCalls++;
        return blockNetwork();
      }

      const toolResults = messages.filter((message) => message?.role === "tool");
      const toolResultText = JSON.stringify(toolResults);
      const toolResultContent = toolResults.map((message) => typeof message.content === "string" ? message.content : "").join("\n\n");
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      const secondQuery = snapshotProbe?.query ?? secondModelQuestion;

      if (hasTools) {
        const toolPhaseIndex = modelTest.toolPhaseCalls;
        modelTest.toolPhaseCalls++;
        const advertisedTools = JSON.stringify(body.tools);
        if (toolPhaseIndex === 0) {
          modelTest.fixtureCalls++;
          return fixtureStream("无需调用工具。");
        }
        if (toolPhaseIndex === 1) {
            if (!advertisedTools.includes("companion-chat_memory_search")) {
              modelTest.unexpectedModelCalls++;
              return blockNetwork();
            }
            modelTest.fixtureCalls++;
            modelTest.memoryToolRequested = true;
            return fixtureToolCallStream("companion-chat_memory_search", { query: secondQuery }, "isolated-memory-call");
        }
        if (toolPhaseIndex === 2) {
          modelTest.memoryToolResultObserved = Boolean(snapshotProbe?.content
            ? toolResultText.includes(snapshotProbe.content)
            : toolResultText.includes(firstModelQuestion));
          if (!modelTest.memoryToolResultObserved) return blockNetwork();
          if (realSnapshot) {
            modelTest.realSnapshotMemoryInjected = Boolean(snapshotProbe?.content
              && toolResultContent.includes(snapshotProbe.content));
            modelTest.realSnapshotInjectedCount = (toolResultContent.match(/\[记忆 [^\]]+\]/g) ?? []).length;
            modelTest.realSnapshotProviderChars = toolResultContent.length;
            if (!modelTest.realSnapshotMemoryInjected || modelTest.realSnapshotInjectedCount < 1
              || modelTest.realSnapshotInjectedCount > 8 || toolResultContent.length > 6_000) return blockNetwork();
          }
          modelTest.fixtureCalls++;
          return fixtureStream("记忆资料已取得，交给 Soul 回复。");
        }
        if (toolPhaseIndex === 3) {
            if (!advertisedTools.includes("companion-chat_screen_observation")) {
              modelTest.unexpectedModelCalls++;
              return blockNetwork();
            }
            modelTest.fixtureCalls++;
            modelTest.screenToolRequested = true;
            return fixtureToolCallStream("companion-chat_screen_observation", {
              focus: "当前屏幕主要显示什么？",
            }, "isolated-screen-call");
        }
        if (toolPhaseIndex === 4) {
          modelTest.screenToolResultObserved = toolResultText.includes(screenVisionFixture);
          if (!modelTest.screenToolResultObserved) return blockNetwork();
          modelTest.fixtureCalls++;
          return fixtureStream("屏幕摘要已取得，交给 Soul 回复。");
        }
        modelTest.unexpectedModelCalls++;
        return blockNetwork();
      }

      if (Array.isArray(body.tools) || body.tools != null) {
        modelTest.unexpectedModelCalls++;
        return blockNetwork();
      }
      const soulPhaseIndex = modelTest.soulPhaseCalls;
      modelTest.soulPhaseCalls++;
      if (soulPhaseIndex === 0) {
        modelTest.fixtureCalls++;
        return fixtureStream(fixtureReply);
      }
      if (soulPhaseIndex === 2) {
        if (!modelTest.screenToolResultObserved) return blockNetwork();
        modelTest.fixtureCalls++;
        return fixtureStream(screenReplyFixture);
      }
      if (soulPhaseIndex !== 1 || !firstTurnCaptured || !visibleMessages.includes(firstModelQuestion)
        || !modelTest.memoryToolResultObserved || modelTest.liveCalls !== 0) {
        modelTest.unexpectedModelCalls++;
        return blockNetwork();
      }
      modelTest.secondRequestHadPluginMemory = realSnapshot
        ? Boolean(snapshotProbe?.content && visibleMessages.includes(snapshotProbe.content))
        : visibleMessages.includes(firstModelQuestion);
      if (!modelTest.secondRequestHadPluginMemory) return blockNetwork();
      if (!liveModel) {
        modelTest.fixtureCalls++;
        return fixtureStream(realSnapshot ? "我找到了相关记忆。" : "你刚才说，要给窗台上的薄荷浇水呀。");
      }
      body.max_tokens = realSnapshot ? 4_096 : 512;
      modelTest.outputTokenCap = body.max_tokens;
      modelTest.liveCalls++;
      modelSocketAllowed = true;
      try {
        const response = await delegateFetch(request.url, {
          method: "POST", headers: request.headers, body: JSON.stringify(body), signal: request.signal,
        });
        if (!response.ok) throw new Error(`Kimi HTTP ${response.status}`);
        streamAuditTask = auditModelStream(response).catch(() => {
          modelTest.streamAudit = { error: true };
        });
        return response;
      } finally { modelSocketAllowed = false; }
    };
    const tls = require("node:tls");
    const originalTlsConnect = tls.connect;
    tls.connect = (...args) => {
      const options = args[0];
      if (liveModel && modelSocketAllowed && modelSocketCount === 0
        && options && typeof options === "object" && options.host === "api.moonshot.cn"
        && options.servername === "api.moonshot.cn" && Number(options.port) === 443) {
        modelSocketCount++;
        return originalTlsConnect(...args);
      }
      return blockNetwork();
    };
    // Chromium 页面资源只允许本地文件；模型 HTTPS 仅由上面的主进程受控 fetch 发起。
    app.on("ready", () => electron.session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] }, (_details, callback) => callback({ cancel: true })));
  } else {
    globalThis.fetch = async () => blockNetwork();
  }
  globalThis.WebSocket = class { constructor() { blockNetwork(); } };
  for (const moduleName of ["node:http", "node:https"]) {
    const module = require(moduleName);
    module.request = blockNetwork;
    module.get = blockNetwork;
  }
  const net = require("node:net");
  net.connect = blockNetwork;
  net.createConnection = blockNetwork;
  if (!boundedModelUiTurn) require("node:tls").connect = blockNetwork;
  electron.net.request = blockNetwork;
  electron.net.fetch = async () => blockNetwork();

  // 保留真实 BrowserWindow 创建和页面加载，只阻止窗口显示及抢焦点。
  if (!visible) {
    for (const method of ["show", "showInactive", "focus"]) {
      BrowserWindow.prototype[method] = function isolatedWindowNoop() {};
    }
  }
}

function writeSyntheticUserData() {
  const pluginRoot = path.join(userDataRoot, "plugins");
  fs.mkdirSync(pluginRoot, { recursive: true });
  for (const pluginId of ["companion-chat", "companion-memory"]) {
    const source = path.join(localRoot, "artifacts", pluginId);
    if (!fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`缺少插件构建产物: ${pluginId}`);
    }
    fs.cpSync(source, path.join(pluginRoot, pluginId), { recursive: true });
  }

  const appSettings = {
    plugins: { "companion-chat": true, "companion-memory": true },
    chatBackend: "companion",
    chatToolsEnabled: false,
    toolModeOverrides: {
      moments_view: { chat: false }, moments_post: { chat: false }, moments_interact: { chat: false },
    },
    launchAtLogin: false,
    petVisible: false,
    sidebarVisible: visible,
    tasksVisible: false,
    proactiveChatMode: "off",
    momentsEnabled: false,
    chatMomentsContextEnabled: false,
    cyreneMomentsPostingEnabled: false,
    cyreneMomentsReactionsEnabled: false,
    momentsCharacterReactionsEnabled: false,
    playwrightMcpEnabled: false,
    searchEngine: "off",
    chatSocialContextEnabled: false,
    ttsEngine: "off",
    asrEngine: "off",
  };
  fs.writeFileSync(path.join(userDataRoot, "app-settings.json"), JSON.stringify(appSettings, null, 2));
  fs.writeFileSync(path.join(userDataRoot, "mcp-servers.json"), "[]\n");
  fs.writeFileSync(path.join(userDataRoot, "scheduled-tasks.json"), "[]\n");
  fs.writeFileSync(path.join(userDataRoot, "channels-settings.json"), JSON.stringify({
    wechat: { enabled: false },
    feishu: { enabled: false },
    qq: { enabled: false },
    qqbot: { enabled: false },
    inboundPort: 0,
  }, null, 2));
  fs.writeFileSync(path.join(userDataRoot, "memory.json"), JSON.stringify({
    schemaVersion: 2,
    l0: {},
    l1: {},
    l2: [],
    evidence: [],
    reflectionLogs: [],
    conflictLogs: [],
    l2DmaeStates: [],
    version: 1,
  }, null, 2));
  if (nativeTurn) {
    // 仅供合成轮次通过宿主模型配置检查；实际模型入口由下方固定回复替代，网络仍被硬阻断。
    const modelSettings = boundedModelUiTurn
      ? liveModel
        ? JSON.parse(fs.readFileSync(path.join(runRoot, "isolated-model-source.json"), "utf8"))
        : { provider: "Kimi（月之暗面）", baseUrl: "https://api.moonshot.cn/v1",
          model: "kimi-k2.6", apiKey: "synthetic-only", explicitTransport: "openai" }
      : { provider: "ChatGPT（OpenAI）", baseUrl: "http://127.0.0.1:9/v1",
          model: "synthetic-no-network", apiKey: "synthetic-only", explicitTransport: "openai" };
    fs.writeFileSync(path.join(userDataRoot, "model-settings.json"), JSON.stringify({
      ...modelSettings,
      stickerEnabled: false, rerankerMode: "off", embeddingModel: "none",
      // 两阶段受控测试用固定视觉回包验证屏幕观察工具；截图数据不会离开隔离进程。
      multimodal: boundedModelUiTurn,
    }, null, 2));
    const memoryData = ensureRunSubdirectory("user-data/plugin-data/companion-memory");
    fs.writeFileSync(path.join(memoryData, "native-integration-settings.json"), JSON.stringify({
      captureEnabled: true, autoExtractEnabled: false,
      promptInjectionEnabled: true, momentsInjectionEnabled: false,
    }, null, 2));
    const chatData = ensureRunSubdirectory("user-data/plugin-data/companion-chat");
    fs.writeFileSync(path.join(chatData, "memory-link.json"), JSON.stringify({ enabled: true }, null, 2));
  }
}

const isolatedPaths = prepareFilesystem();
installProcessGuards();
writeSyntheticUserData();

const observedContexts = [];
const observedStablePrompts = [];
if (nativeTurn && !boundedModelUiTurn) {
  const { Observable } = require("rxjs");
  const agentModule = require(path.join(projectRoot, "dist", "main", "main", "orchestrator", "cyrene-agent.js"));
  agentModule.CyreneAgent = class SyntheticCyreneAgent {
    constructor(input) { this.threadId = input.threadId; }
    runWithEvents(options) {
      observedContexts.push(options.soulRuntimeContext ?? "");
      observedStablePrompts.push(options.soulSystemBaseContent ?? "");
      const reply = "合成回复：记住了";
      const messageId = `synthetic-assistant-${observedContexts.length}`;
      return new Observable((subscriber) => {
        setTimeout(() => {
          if (subscriber.closed) return;
          this.lastResult = { reply, toolResults: [] };
          subscriber.next({ type: "RUN_STARTED", threadId: this.threadId, runId: options.runId });
          subscriber.next({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
          subscriber.next({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: reply });
          subscriber.next({ type: "TEXT_MESSAGE_END", messageId });
          subscriber.next({ type: "RUN_FINISHED", threadId: this.threadId, runId: options.runId,
            result: { status: "success", externalEffectsMayContinue: false } });
          subscriber.complete();
        }, 100);
      });
    }
  };
}

let nativeTurnPassed = false;
let promptProviderOrderPassed = false;
let nativeRelationshipBypassed = false;
let companionLifeStatusVisible = false;
let snapshotPreview = null;
let importAudit = null;
let companionAcceptancePassed = false;
let companionAcceptanceResult = null;

async function runCompanionAcceptance() {
  const chatWindow = BrowserWindow.getAllWindows().find((win) =>
    win.webContents.getURL().replace(/\\/g, "/").includes("/renderer/react/index.html"));
  if (!chatWindow) throw new Error("陪伴能力验收未找到原生 Chat 页面");
  await chatWindow.webContents.executeJavaScript('window.plugins.open("companion-chat")');
  const pluginWindow = BrowserWindow.getAllWindows().find((win) => win.getTitle() === "独立陪伴聊天");
  if (!pluginWindow) throw new Error("陪伴能力验收未找到插件窗口");
  const initial = await pluginWindow.webContents.executeJavaScript('window.companion.invoke("state")');
  if (initial?.ok !== true || initial.data?.proactive?.enabled !== false
    || initial.data?.proactive?.feedbackLearningEnabled !== false) {
    throw new Error("回应反馈学习没有保持默认关闭");
  }
  const enabled = await pluginWindow.webContents.executeJavaScript(
    'window.companion.invoke("save-proactive-settings", { enabled: false, feedbackLearningEnabled: true })',
  );
  if (enabled?.ok !== true || enabled.data?.enabled !== false
    || enabled.data?.feedbackLearningEnabled !== true) {
    throw new Error("回应反馈学习无法经用户设置显式开启");
  }
  const chatsStore = require(path.join(projectRoot, "dist", "main", "main", "chats", "chats-store.js"));
  const feedbackSession = chatsStore.getOrCreateSessionByPurpose("proactive-chat", { title: "昔涟的主动消息" });
  const feedbackMessageId = `isolated-ignore-${Date.now()}`;
  const feedbackMessage = chatsStore.appendMessage(feedbackSession.id, {
    id: feedbackMessageId,
    role: "model",
    content: "隔离验收主动消息",
    at: Date.now(),
    pluginDelivery: { pluginId: "companion-chat", ignoreFeedback: "pending" },
  });
  if (feedbackMessage?.messages.at(-1)?.pluginDelivery?.ignoreFeedback !== "pending") {
    throw new Error("主动消息忽略反馈待处理标记没有落盘");
  }
  const ignored = await chatWindow.webContents.executeJavaScript(
    `window.chatStore.ignorePluginMessage(${JSON.stringify(feedbackSession.id)}, ${JSON.stringify(feedbackMessageId)})`,
  );
  const ignoredSession = chatsStore.getSession(feedbackSession.id);
  const repeated = await chatWindow.webContents.executeJavaScript(
    `window.chatStore.ignorePluginMessage(${JSON.stringify(feedbackSession.id)}, ${JSON.stringify(feedbackMessageId)})`,
  );
  if (ignored?.ok !== true || ignoredSession?.messages.at(-1)?.pluginDelivery?.ignoreFeedback !== "ignored"
    || repeated?.ok !== false) {
    throw new Error("主动消息忽略反馈没有保持一次性 preload／IPC／落盘语义");
  }
  const disabled = await pluginWindow.webContents.executeJavaScript(
    'window.companion.invoke("save-proactive-settings", { enabled: false, feedbackLearningEnabled: false })',
  );
  const finalState = await pluginWindow.webContents.executeJavaScript('window.companion.invoke("state")');
  if (disabled?.ok !== true || finalState?.data?.proactive?.feedbackLearningEnabled !== false) {
    throw new Error("回应反馈学习无法再次关闭");
  }
  await chatWindow.webContents.executeJavaScript('window.plugins.open("companion-memory")');
  const memoryWindow = BrowserWindow.getAllWindows().find((win) => win.getTitle() === "独立记忆档案");
  if (!memoryWindow) throw new Error("陪伴能力验收未找到记忆插件窗口");
  const initialMemory = await memoryWindow.webContents.executeJavaScript('window.companion.invoke("state")');
  if (initialMemory?.ok !== true || initialMemory.data?.autoDream?.enabled !== false
    || initialMemory.data?.autoDream?.applyEnabled !== false
    || initialMemory.data?.autoCompression?.enabled !== false
    || initialMemory.data?.autoCompression?.applyEnabled !== false) {
    throw new Error("梦境自动保存没有保持默认关闭");
  }
  const compressionUi = await memoryWindow.webContents.executeJavaScript(`(() => {
    const mode = document.getElementById("auto-compression-mode");
    const recent = document.getElementById("recent-compression-groups");
    return { mode: mode?.value, recent: recent?.textContent?.trim() };
  })()`);
  if (compressionUi?.mode !== "manual" || compressionUi?.recent !== "暂无压缩记录") {
    throw new Error("压缩模式或最近压缩组界面未按默认状态加载");
  }
  const compressionEnabled = await memoryWindow.webContents.executeJavaScript('window.companion.invoke("auto-compression", true)');
  const compressionApplyEnabled = await memoryWindow.webContents.executeJavaScript('window.companion.invoke("auto-compression-apply", true)');
  const dreamEnabled = await memoryWindow.webContents.executeJavaScript('window.companion.invoke("auto-dream", true)');
  const dreamApplyEnabled = await memoryWindow.webContents.executeJavaScript('window.companion.invoke("auto-dream-apply", true)');
  const coordinated = await memoryWindow.webContents.executeJavaScript('window.companion.invoke("state")');
  const dreamDisabled = await memoryWindow.webContents.executeJavaScript('window.companion.invoke("auto-dream", false)');
  const resumed = await memoryWindow.webContents.executeJavaScript('window.companion.invoke("state")');
  const compressionDisabled = await memoryWindow.webContents.executeJavaScript('window.companion.invoke("auto-compression", false)');
  if (compressionEnabled?.ok !== true || compressionApplyEnabled?.ok !== true || compressionApplyEnabled.data?.applyEnabled !== true
    || coordinated?.ok !== true || coordinated.data?.autoCompression?.suppressed !== true
    || resumed?.ok !== true || resumed.data?.autoCompression?.suppressed !== false
    || compressionDisabled?.ok !== true || compressionDisabled.data?.enabled !== false || compressionDisabled.data?.applyEnabled !== false) {
    throw new Error("压缩自动应用授权、梦境周期互斥或关闭联动无效");
  }
  if (dreamEnabled?.ok !== true || dreamApplyEnabled?.ok !== true || dreamApplyEnabled.data?.applyEnabled !== true
    || dreamDisabled?.ok !== true || dreamDisabled.data?.enabled !== false || dreamDisabled.data?.applyEnabled !== false) {
    throw new Error("梦境自动保存双重授权或关闭联动无效");
  }
  companionAcceptancePassed = true;
  companionAcceptanceResult = {
    pluginLoaded: true,
    weatherCapabilityResolved: true,
    feedbackDefaultOff: true,
    feedbackExplicitOptIn: true,
    feedbackCanDisable: true,
    feedbackIpcFirstAccepted: true,
    feedbackPersistedIgnored: true,
    feedbackIpcRepeatRejected: true,
    dreamAutoApplyDefaultOff: true,
    dreamAutoApplyExplicitOptIn: true,
    dreamAutoApplyClearedWithScheduler: true,
    compressionModeDefaultManual: true,
    recentCompressionGroupsVisible: true,
    compressionAutoApplyExplicitOptIn: true,
    compressionAutoApplyClearedWithScheduler: true,
    dreamCycleSuppressesIndependentCompression: true,
    independentCompressionResumesAfterDreamCycle: true,
  };
  console.log(`[isolated-smoke] 陪伴主动消息与天气能力验收通过: ${JSON.stringify(companionAcceptanceResult)}`);
}

async function runBoundedModelTurn() {
  const chatWindow = BrowserWindow.getAllWindows().find((win) =>
    win.webContents.getURL().replace(/\\/g, "/").includes("/renderer/react/index.html"));
  if (!chatWindow) throw new Error("受控模型测试未找到原生 Chat 页面");
  const send = (text, previousAssistantId = "") => chatWindow.webContents.executeJavaScript(`(async () => {
    const text = ${JSON.stringify(text)};
    const previousAssistantId = ${JSON.stringify(previousAssistantId)};
    const editor = document.querySelector("textarea") || document.querySelector('[contenteditable="true"]');
    if (!editor) throw new Error("原生 Chat 输入框不存在");
    if (editor instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(editor, text);
    } else editor.textContent = text;
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    for (let i = 0; i < ${liveModel && realSnapshot ? 1800 : 650}; i++) {
      const sessions = await window.chatStore.list({ mode: "chat" });
      for (const item of sessions) {
        const session = await window.chatStore.get(item.id);
        if (!session) continue;
        const userIndex = session.messages.findIndex((message) => message.role === "user" && message.content === text);
        if (userIndex < 0) continue;
        const assistant = session.messages.slice(userIndex + 1).find((message) => message.role === "model"
          && message.id !== previousAssistantId && message.content?.trim());
        if (assistant) return { sessionId: session.id, userId: session.messages[userIndex].id,
          assistantId: assistant.id, reply: assistant.content };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("原生 Chat 页面等待模型回复超时");
  })()`);
  const first = await send(firstModelQuestion);
  if (first.reply !== fixtureReply) throw new Error("首轮固定流式回复与落盘结果不一致");
  const memoryPath = path.join(userDataRoot, "plugin-data", "companion-memory", "memory-state.json");
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(memoryPath)) {
      const state = JSON.parse(fs.readFileSync(memoryPath, "utf8"));
      firstTurnCaptured = state.turns?.some((turn) => turn.sessionId === first.sessionId
        && turn.inputMessageId === first.userId && turn.finalMessageId === first.assistantId);
      if (firstTurnCaptured) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!firstTurnCaptured) throw new Error("首轮真实 ChatLoop 落盘后插件未摄取");
  const second = await send(snapshotProbe?.query ?? secondModelQuestion, first.assistantId);
  modelTest.secondReplySaved = second.sessionId === first.sessionId
    && (realSnapshot ? liveModel ? second.reply.trim().length >= 4 && second.reply.length <= 1_500
      : second.reply === "我找到了相关记忆。"
      : second.reply.includes("薄荷") && second.reply.includes("浇水"))
    && !/<tool_call|\[tool_call\]|<invoke/.test(second.reply);
  if (!modelTest.secondReplySaved) throw new Error("第二轮回复未正确保存或未命中合成事实");
  for (let i = 0; i < 100; i++) {
    const state = JSON.parse(fs.readFileSync(memoryPath, "utf8"));
    modelTest.secondTurnCaptured = state.turns?.some((turn) => turn.sessionId === second.sessionId
      && turn.inputMessageId === second.userId && turn.finalMessageId === second.assistantId);
    if (modelTest.secondTurnCaptured) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const screen = await send(screenModelQuestion, second.assistantId);
  modelTest.screenReplySaved = screen.sessionId === first.sessionId
    && screen.reply === screenReplyFixture
    && !/<tool_call|\[tool_call\]|<invoke/.test(screen.reply);
  if (!modelTest.screenReplySaved) throw new Error("屏幕观察后的 Soul 回复未正确保存");
  for (let i = 0; i < 100; i++) {
    const state = JSON.parse(fs.readFileSync(memoryPath, "utf8"));
    modelTest.screenTurnCaptured = state.turns?.some((turn) => turn.sessionId === screen.sessionId
      && turn.inputMessageId === screen.userId && turn.finalMessageId === screen.assistantId);
    if (modelTest.screenTurnCaptured) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const usage = require(path.join(projectRoot, "dist", "main", "main", "token-usage-store.js"))
    .getUsageReport(1).models.find((item) => item.model === "kimi-k2.6");
  modelTest.usage = usage ? { input: usage.input, output: usage.output,
    requests: usage.requests, attemptedRequests: usage.attemptedRequests } : null;
  boundedModelPassed = modelTest.fixtureCalls === (liveModel ? 8 : 9)
    && modelTest.liveCalls === (liveModel ? 1 : 0) && modelTest.unexpectedModelCalls === 0
    && modelTest.toolPhaseCalls === 5 && modelTest.soulPhaseCalls === 3
    && modelTest.visionFixtureCalls === 1
    && modelTest.memoryToolRequested && modelTest.memoryToolResultObserved
    && modelTest.screenToolRequested && modelTest.screenToolResultObserved
    && modelTest.secondRequestHadPluginMemory && modelTest.secondReplySaved
    && modelTest.secondTurnCaptured && modelTest.screenReplySaved && modelTest.screenTurnCaptured
    && (!realSnapshot || modelTest.realSnapshotMemoryInjected);
  nativeTurnPassed = boundedModelPassed;
  if (!boundedModelPassed) throw new Error("模型／落盘／插件摄取计数未全部达标");
  console.log(`[isolated-smoke] 原生 Chat 完整页面模型轮次通过；fixture=${modelTest.fixtureCalls}, live=${modelTest.liveCalls}`);
}
async function runSnapshotImportAudit(pluginWindow, sourcePath, preview) {
  const before = await pluginWindow.webContents.executeJavaScript('window.companion.invoke("state")');
  if (before?.ok !== true || before.data?.entries?.length !== 0 || before.data?.evidence?.length !== 0
    || before.data?.legacyImport) throw new Error("隔离插件目标记忆库不是空库");
  const imported = await pluginWindow.webContents.executeJavaScript(`window.companion.invoke("import-legacy", ${JSON.stringify({
    sourcePath, sourceHash: preview.sourceHash, revision: before.data.revision,
    sourceAttested: true, preserveRuntime: true,
  })})`);
  if (imported?.ok !== true) throw new Error("一次性快照导入失败");
  const after = await pluginWindow.webContents.executeJavaScript('window.companion.invoke("state")');
  if (after?.ok !== true) throw new Error("无法读取隔离插件导入结果");
  const raw = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const data = after.data;
  const check = (condition, label) => { if (!condition) throw new Error(`快照导入对账失败：${label}`); };
  check(data.legacyImport?.sourceHash === preview.sourceHash && data.legacyImport?.sourceAttested === true
    && data.legacyImport?.runtimePreserved === true, "来源与导入声明");
  check(data.entries?.length === raw.l2.length && data.evidence?.length === raw.evidence.length, "条目与证据数量");
  check(data.lifecycle?.tracked === raw.l2.length
    && data.dmae?.tracked === Object.keys(raw.l2DmaeStates ?? {}).length, "运行状态加载数量");
  const entries = new Map(data.entries.map((item) => [item.id, item]));
  for (const source of raw.l2) {
    const item = entries.get(source.id);
    check(Boolean(item) && item.content === source.content.trim() && item.status === source.status
      && item.quote === (source.sourceQuote ?? "") && item.triggerText === source.triggerText
      && item.pinned === (source.isPinned === true)
      && item.provenance === "legacy-user-attested"
      && item.supersededBy === source.supersededBy && item.mergedInto === source.mergedInto,
    "L2 核心字段");
    if (source.isSummary !== true) {
      check(item.sourceAt === (source.sourceAt ?? source.createdAt)
        && item.sourceEndAt === source.sourceEndAt, "叶子来源时间");
    }
    const recall = data.legacyRuntime?.lifecycle?.recalls?.[source.id];
    check(recall?.lastHitAt === source.lastAccessedAt && recall?.hitCount === source.accessCount
      && recall?.weight === source.weight, "访问次数、时间与权重");
  }
  const evidence = new Map(data.evidence.map((item) => [item.id, item]));
  for (const source of raw.evidence) {
    const item = evidence.get(source.id);
    check(Boolean(item) && item.memoryId === source.memoryId && item.quoteSnippet === source.quoteSnippet
      && item.createdAt === source.createdAt && item.sourceStatus === source.sourceStatus
      && item.provenance === "legacy-user-attested", "证据核心字段");
  }
  check(data.legacyRuntime?.dmae?.round === (raw.l2DmaeRound ?? 0), "DMAE 全局轮次");
  for (const [id, source] of Object.entries(raw.l2DmaeStates ?? {})) {
    const item = data.legacyRuntime?.dmae?.states?.[id];
    check(Boolean(item) && ["activation", "userSilence", "modelSilence", "lastInjectedRound", "round"]
      .every((field) => item[field] === source[field]), "DMAE 初值");
  }
  const vectorPath = path.join(path.dirname(sourcePath), "rag-data", "memory-store.json");
  check(fs.lstatSync(vectorPath, { throwIfNoEntry: false })?.isFile(), "向量源文件存在");
  const vectorPreview = await pluginWindow.webContents.executeJavaScript(
    `window.companion.invoke("preview-legacy-vectors", { sourcePath: ${JSON.stringify(vectorPath)} })`,
  );
  check(vectorPreview?.ok === true && vectorPreview.data?.canImport === true, "向量只读预检");
  const vectorImport = await pluginWindow.webContents.executeJavaScript(
    `window.companion.invoke("import-legacy-vectors", ${JSON.stringify({ sourcePath: vectorPath, sourceHash: vectorPreview.data.sourceHash })})`,
  );
  check(vectorImport?.ok === true && vectorImport.data?.legacyEntries === vectorPreview.data.usable,
    "向量临时导入");
  const storedVectors = JSON.parse(fs.readFileSync(path.join(userDataRoot, "plugin-data", "companion-memory", "vector-index.json"), "utf8"));
  const sourceVectors = JSON.parse(fs.readFileSync(vectorPath, "utf8"));
  const importedVectors = new Map(storedVectors.entries.map((item) => [item.l2Id, item]));
  const expectedVectors = sourceVectors.filter((item) => item?.source === "user_memory" && entries.has(item?.metadata?.l2Id));
  check(importedVectors.size === expectedVectors.length && storedVectors.dimensions === vectorPreview.data.dimensions[0],
    "向量条目与维度");
  for (const source of expectedVectors) {
    const item = importedVectors.get(source.metadata.l2Id);
    check(item?.origin === "legacy" && Array.isArray(item.embedding)
      && item.embedding.length === source.embedding.length
      && item.embedding.every((value, index) => value === source.embedding[index]), "向量数值");
  }
  check(data.embedding?.enabled === false && data.queryExpansion === false && data.reranker?.enabled === false,
    "检索模型开关保持关闭");
  let probe;
  for (const source of raw.l2) {
    if (source.status !== "active" || source.isSummary === true || !source.triggerText?.trim()
      || source.triggerText.length > 120 || source.content.length > 300) continue;
    const result = await pluginWindow.webContents.executeJavaScript(
      `window.companion.invoke("search", ${JSON.stringify(source.triggerText)})`,
    );
    if (result?.ok === true && typeof result.data === "string" && result.data.includes(source.content.trim())) {
      probe = { query: source.triggerText, content: source.content.trim() };
      break;
    }
  }
  check(Boolean(probe), "只读词面检索命中");
  if (boundedModelUiTurn) snapshotProbe = probe;
  else {
    await runNativeTurn(probe.query, true);
    check(nativeTurnPassed, "合成原生聊天注入");
  }
  importAudit = { passed: true, entries: entries.size, evidence: evidence.size,
    lifecycleRecords: Object.keys(data.legacyRuntime.lifecycle.recalls).length,
    dmaeStates: Object.keys(data.legacyRuntime.dmae.states).length,
    summarySourceTimesDerived: raw.l2.filter((item) => item.isSummary === true).length,
    vectorEntries: importedVectors.size, vectorDimensions: storedVectors.dimensions,
    lexicalRetrievalPassed: true, nativePromptInjectionPassed: !boundedModelUiTurn };
  console.log(`[isolated-smoke] 一次性插件导入对账通过: ${JSON.stringify(importAudit)}`);
}
async function runSnapshotPreview() {
  const sourceRoot = process.env.CYRENE_ISOLATED_SOURCE_SNAPSHOT;
  if (path.resolve(sourceRoot ?? "").toLowerCase() !== path.join(runRoot, "source-snapshot").toLowerCase()
    || !fs.lstatSync(sourceRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("只读快照路径不在本次隔离目录内");
  }
  const chatWindow = BrowserWindow.getAllWindows().find((win) =>
    win.webContents.getURL().replace(/\\/g, "/").includes("/renderer/react/index.html"));
  if (!chatWindow) throw new Error("未找到隔离原生聊天页面");
  await chatWindow.webContents.executeJavaScript('window.plugins.open("companion-memory")');
  const pluginWindow = BrowserWindow.getAllWindows().find((win) => win.getTitle() === "独立记忆档案");
  if (!pluginWindow) throw new Error("未找到独立记忆插件窗口");
  const sourcePath = path.join(sourceRoot, "memory.json");
  const preview = await pluginWindow.webContents.executeJavaScript(
    `window.companion.invoke("preview-legacy-import", { sourcePath: ${JSON.stringify(sourcePath)} })`,
  );
  if (preview?.ok !== true || !Number.isInteger(preview.data?.entries?.total)
    || preview.data.entries.total < 1 || !/^[a-f0-9]{64}$/.test(preview.data?.sourceHash ?? "")
    || preview.data.runtime?.valid !== true) {
    throw new Error("真实记忆快照只读预检失败");
  }
  snapshotPreview = {
    entries: preview.data.entries.total,
    evidence: preview.data.evidence?.total ?? 0,
    excludedDmaeStates: preview.data.excluded?.dmaeStates ?? 0,
    canImport: preview.data.canImport === true,
    lifecycleRecords: preview.data.runtime.lifecycleRecords,
    dmaeStates: preview.data.runtime.dmaeStates,
    runtimeValid: true,
  };
  if (visible) {
    await pluginWindow.webContents.executeJavaScript(`(() => {
      const source = document.getElementById("legacy-source");
      const output = document.getElementById("legacy-preview");
      const importButton = document.getElementById("legacy-import");
      if (!source || !output || !importButton) throw new Error("独立记忆插件预检界面未就绪");
      source.value = ${JSON.stringify(sourcePath)};
      output.textContent = ${JSON.stringify("只读快照预检通过：L2 " + snapshotPreview.entries + " 条；证据 " + snapshotPreview.evidence + " 条；DMAE " + snapshotPreview.excludedDmaeStates + " 条未导入。原生记忆与模型调用保持关闭。")};
      importButton.disabled = true;
    })()`);
  }
  console.log(`[isolated-smoke] 真实快照只读预检通过: ${JSON.stringify(snapshotPreview)}`);
  if (realImportAudit) await runSnapshotImportAudit(pluginWindow, sourcePath, preview.data);
  if (boundedModelUiTurn) {
    try {
      await runBoundedModelTurn();
      importAudit.nativePromptInjectionPassed = modelTest.realSnapshotMemoryInjected;
    } finally {
      if (streamAuditTask) await streamAuditTask;
    }
  }
}
async function runNativeTurn(secondQuery = "第二轮合成提问：还记得白厄和什么茶吗？", requireImportedMemory = false) {
  const chatWindow = BrowserWindow.getAllWindows().find((win) =>
    win.webContents.getURL().replace(/\\/g, "/").includes("/renderer/react/index.html"));
  if (!chatWindow) throw new Error("未找到隔离原生聊天页面");
  for (let index = 0; index < 100; index += 1) {
    companionLifeStatusVisible = await chatWindow.webContents.executeJavaScript(`(() => {
      const node = document.querySelector(".cy-companion-life-status__text");
      const text = node?.textContent?.trim() ?? "";
      const status = text.startsWith("昔涟 · ") ? text.slice("昔涟 · ".length) : "";
      return status === "休息中" || status.startsWith("正");
    })()`);
    if (companionLifeStatusVisible) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!companionLifeStatusVisible) throw new Error("陪伴生活状态未显示在原生 Chat 顶栏");
  const nativeRelationshipPath = path.join(userDataRoot, "relationship-log.json");
  if (fs.existsSync(nativeRelationshipPath)) {
    throw new Error("隔离宿主在原生 Chat 验收前已创建关系日志");
  }
  const historyText = requireImportedMemory
    ? `${secondQuery} cyrene_synthetic_history_marker_${Date.now()}`
    : "合成原生聊天：我喜欢乌龙茶";
  const first = nativeUiTurn
    ? await chatWindow.webContents.executeJavaScript(`(async () => {
      const userText = ${JSON.stringify(historyText)};
      const editor = document.querySelector("textarea") || document.querySelector('[contenteditable="true"]');
      if (!editor) throw new Error("未找到原生 Chat 输入框");
      if (editor instanceof HTMLTextAreaElement) {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(editor, userText);
      } else {
        editor.textContent = userText;
      }
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, data: userText, inputType: "insertText" }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
      for (let i = 0; i < 100; i++) {
        const sessions = await window.chatStore.list({ mode: "chat" });
        if (sessions.length > 0) {
          const session = await window.chatStore.get(sessions[0].id);
          const user = session?.messages.find((message) => message.role === "user" && message.content === userText);
          const assistant = session?.messages.find((message) => message.role === "model" && message.content === "合成回复：记住了");
          if (user && assistant) return { sessionId: session.id, userId: user.id, assistantId: assistant.id, userText };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("原生 Chat 页面未完成合成发送；输入框=" + editor.outerHTML.slice(0, 300));
    })()`)
    : await chatWindow.webContents.executeJavaScript(`(async () => {
    const session = await window.chatStore.create({ mode: "chat" });
    const userId = "synthetic-user-1";
    const assistantId = "synthetic-assistant-1";
    const userText = ${JSON.stringify(historyText)};
    await window.chatStore.append(session.id, { id: userId, role: "user", content: userText, at: Date.now() });
    const events = [];
    const off = window.agui.onEvent((event) => events.push(event));
    const ack = await window.agui.run({ sessionId: session.id, userTurnId: userId,
      assistantTurnId: assistantId, messages: [{ role: "user", content: userText }] });
    for (let i = 0; i < 100 && !events.some((event) => event.runId === ack.runId && event.type === "RUN_FINISHED"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    off();
    if (!events.some((event) => event.runId === ack.runId && event.type === "RUN_FINISHED")) throw new Error("原生 Chat 未收到终态");
    await window.chatStore.append(session.id, { id: assistantId, role: "model", content: "合成回复：记住了", at: Date.now() });
    return { sessionId: session.id, runId: ack.runId, userId, assistantId, userText };
  })()`);
  const memoryPath = path.join(userDataRoot, "plugin-data", "companion-memory", "memory-state.json");
  const savedSession = require(path.join(projectRoot, "dist", "main", "main", "chats", "chats-store.js"))
    .getSession(first.sessionId);
  if (!savedSession?.messages.some((message) => message.id === first.assistantId && message.role === "model")) {
    throw new Error("合成回复未写入原生会话存储");
  }
  if (!nativeUiTurn) {
    if (fs.existsSync(memoryPath) && JSON.parse(fs.readFileSync(memoryPath, "utf8")).turns?.length > 0) {
      throw new Error("未确认落盘时插件提前摄取");
    }
    await chatWindow.webContents.executeJavaScript(`window.agui.reportRunPersisted({
      runId: ${JSON.stringify(first.runId)}, finalMessageId: ${JSON.stringify(first.assistantId)} })`);
  }
  let captured = false;
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(memoryPath)) {
      const state = JSON.parse(fs.readFileSync(memoryPath, "utf8"));
      captured = state.turns?.some((turn) => turn.sessionId === first.sessionId
        && turn.inputMessageId === first.userId && turn.finalMessageId === first.assistantId);
    }
    if (captured) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!captured) throw new Error("原生 Chat 落盘确认后插件未摄取轮次");
  const runAndWait = (userTurnId, assistantTurnId, messages) => chatWindow.webContents.executeJavaScript(`(async () => {
    const events = [];
    const off = window.agui.onEvent((event) => events.push(event));
    try {
      const ack = await window.agui.run({ sessionId: ${JSON.stringify(first.sessionId)},
        userTurnId: ${JSON.stringify(userTurnId)}, assistantTurnId: ${JSON.stringify(assistantTurnId)},
        messages: ${JSON.stringify(messages)} });
      for (let i = 0; i < 100 && !events.some((event) => event.runId === ack.runId && event.type === "RUN_FINISHED"); i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!events.some((event) => event.runId === ack.runId && event.type === "RUN_FINISHED")) throw new Error("合成轮次未收到完成事件");
      const userText = ${JSON.stringify(messages)}.at(-1)?.content ?? "";
      await window.chatStore.append(${JSON.stringify(first.sessionId)}, { id: ${JSON.stringify(userTurnId)}, role: "user", content: userText, at: Date.now() });
      await window.chatStore.append(${JSON.stringify(first.sessionId)}, { id: ${JSON.stringify(assistantTurnId)}, role: "model", content: "合成回复：记住了", at: Date.now() });
      return { runId: ack.runId, assistantId: ${JSON.stringify(assistantTurnId)} };
    } finally { off(); }
  })()`);
  const second = await runAndWait("synthetic-user-2", "synthetic-assistant-2", [
      { role: "user", content: first.userText },
      { role: "assistant", content: "合成回复：记住了" },
      { role: "user", content: secondQuery },
    ]);
  await chatWindow.webContents.executeJavaScript(`window.agui.reportRunPersisted({
    runId: ${JSON.stringify(second.runId)}, finalMessageId: ${JSON.stringify(second.assistantId)} })`);
  // 对同一个旧记忆查询，要求合成历史与旧记忆同时进入原生 Chat；唯一标记防止把旧记忆误当历史。
  // 精确条目已由上方只读检索核对；原生宿主只需确认接收到了插件记忆块。
  const importedMemoryInjected = !requireImportedMemory || observedContexts[1]?.includes("[记忆 ") === true;
  if (requireImportedMemory) {
    const third = await runAndWait("synthetic-user-3", "synthetic-assistant-3", [
        { role: "user", content: secondQuery },
        { role: "assistant", content: "合成回复：记住了" },
        { role: "user", content: first.userText },
      ]);
    await chatWindow.webContents.executeJavaScript(`window.agui.reportRunPersisted({
      runId: ${JSON.stringify(third.runId)}, finalMessageId: ${JSON.stringify(third.assistantId)} })`);
  }
  const historyContext = observedContexts[requireImportedMemory ? 2 : 1];
  const stablePrompt = observedStablePrompts[requireImportedMemory ? 2 : 1];
  const worldbookStatePath = path.join(userDataRoot, "plugin-data", "companion-chat", "worldbook-state.json");
  let worldbookState = null;
  for (let i = 0; i < 100; i++) {
    worldbookState = fs.existsSync(worldbookStatePath) ? JSON.parse(fs.readFileSync(worldbookStatePath, "utf8")) : null;
    if (worldbookState?.version === 2 && worldbookState.revision >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const historyHeaderInjected = historyContext?.includes("[独立记忆插件提供的参考资料") === true;
  const lifeContextInjected = historyContext?.includes("[你的生活]") === true;
  const worldbookInjected = historyContext?.includes("【白厄 / Phainon】") === true;
  const lifeProviderAt = historyContext?.indexOf("[插件上下文：plugin:companion-chat:life-context]") ?? -1;
  const memoryProviderAt = historyContext?.indexOf("[插件上下文：plugin:companion-memory:memory-context]") ?? -1;
  const worldbookProviderAt = historyContext?.indexOf("[插件上下文：plugin:companion-chat:worldbook]") ?? -1;
  promptProviderOrderPassed = lifeProviderAt >= 0
    && memoryProviderAt > lifeProviderAt
    && worldbookProviderAt > memoryProviderAt;
  // 本合成序列只有第二轮命中“白厄”；未命中的首轮不应伪造一次 WorldBook 提交。
  const worldbookCommitted = worldbookState?.version === 2 && worldbookState.revision >= 1;
  const priorTurnInjected = historyContext?.includes(first.userText) === true;
  const competingMemoryInjected = !requireImportedMemory || historyContext?.includes("[记忆 ") === true;
  const personaInjected = stablePrompt?.includes("# 昔涟 · Identity") === true
    && stablePrompt.includes("# 昔涟 · Soul")
    && stablePrompt.includes("# 昔涟 · 原作台词摘录");
  const twoPhasePersonaAdapted = stablePrompt?.includes("工具调用与任务调度规则见 `tools_system.md`") === true
    && stablePrompt.includes("Soul 阶段没有工具能力")
    && !stablePrompt.includes("playwright-browser_");
  nativeRelationshipBypassed = !fs.existsSync(nativeRelationshipPath);
  if (!historyHeaderInjected || !lifeContextInjected || !worldbookInjected || !worldbookCommitted || !priorTurnInjected || !importedMemoryInjected
    || !competingMemoryInjected || !personaInjected || !twoPhasePersonaAdapted
    || !promptProviderOrderPassed || !nativeRelationshipBypassed) {
    throw new Error(`下一轮原生 Chat 注入不完整：${JSON.stringify({ historyHeaderInjected, lifeContextInjected, worldbookInjected, promptProviderOrderPassed, worldbookCommitted, priorTurnInjected, importedMemoryInjected, competingMemoryInjected, personaInjected, twoPhasePersonaAdapted, nativeRelationshipBypassed })}`);
  }
  nativeTurnPassed = true;
  console.log(`[isolated-smoke] 原生 Chat 合成${nativeUiTurn ? "页面" : " IPC"}轮次：落盘确认、插件摄取和下一轮注入通过`);
}

let windowsRevealed = false;
let quitRequested = false;
const originalLog = console.log.bind(console);
console.log = (...args) => {
  originalLog(...args);
  if (args.map(String).join(" ").includes("core/windows-revealed")) {
    windowsRevealed = true;
    if (visibleProbe) setTimeout(() => { quitRequested = true; app.quit(); }, 8_000);
    if (realSnapshot) {
      setTimeout(() => {
        void runSnapshotPreview().catch((error) => { console.error("[isolated-smoke] 真实快照验收失败", error); })
          .finally(() => { if (!visible) { quitRequested = true; app.quit(); } });
      }, 500);
    } else if (!visible) {
      if (companionAcceptance) {
        setTimeout(() => {
          void runCompanionAcceptance()
            .catch((error) => { console.error("[isolated-smoke] 陪伴能力验收失败", error); })
            .finally(() => { quitRequested = true; app.quit(); });
        }, 500);
      } else
      if (nativeTurn) {
        setTimeout(() => {
          void (boundedModelUiTurn ? runBoundedModelTurn() : runNativeTurn())
            .catch((error) => { console.error("[isolated-smoke] 原生轮次失败", error); })
            .finally(() => { quitRequested = true; app.quit(); });
        }, 500);
      } else {
        setTimeout(() => {
          if (!quitRequested) {
            quitRequested = true;
            app.quit();
          }
        }, 8_000);
      }
    }
  }
};

const gracefulWatchdog = setTimeout(() => {
  if (!quitRequested) {
    quitRequested = true;
    app.quit();
  }
}, visible ? 600_000 : boundedModelUiTurn && liveModel && realSnapshot ? 220_000
  : boundedModelUiTurn ? 120_000 : 45_000);
const hardWatchdog = setTimeout(() => app.exit(124), visible ? 660_000
  : boundedModelUiTurn && liveModel && realSnapshot ? 235_000
    : boundedModelUiTurn ? 135_000 : 60_000);

app.on("will-quit", () => {
  clearTimeout(gracefulWatchdog);
  clearTimeout(hardWatchdog);
  const { loadGeneralSettings } = require(path.join(projectRoot, "dist", "main", "main", "settings", "settings-facade.js"));
  fs.writeFileSync(path.join(runRoot, "child-result.json"), JSON.stringify({
    ok: windowsRevealed,
    windowsRevealed,
    nativeChatMemoryDisabled: loadGeneralSettings().chatBackend === "companion",
    ...(nativeTurn ? { nativeTurnPassed, promptProviderOrderPassed, nativeRelationshipBypassed, companionLifeStatusVisible } : {}),
    ...(companionAcceptance ? { companionAcceptancePassed, companionAcceptance: companionAcceptanceResult } : {}),
    ...(boundedModelUiTurn ? { boundedModelPassed, modelTest } : {}),
    ...(realSnapshot ? { snapshotPreview } : {}),
    ...(realImportAudit ? { importAudit } : {}),
    isolatedPaths,
    userData: app.getPath("userData"),
  }, null, 2));
});

require(path.join(projectRoot, "dist", "main", "main", "index.js"));
