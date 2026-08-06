import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, dialog, protocol, net, globalShortcut } from "electron";
import * as path from "path";
import * as fs from "fs";
import { logger, LogTag } from "./logger";
import { renderBanner } from "../shared/banner";
import { createHash, randomUUID } from "crypto";
import { pathToFileURL } from "url";
import { IPC } from "../shared/ipc-channels";
import { type UiTheme } from "../shared/ui-theme";
import { type UiFont } from "../shared/ui-font";
import { type ChatAppearanceSettings } from "../shared/chat-appearance";
import { isDev } from "./env";
import {
  loadGeneralSettings,
  saveGeneralSettings,
  onGeneralSettingsChanged,
} from "./settings/settings-facade";
import {
  getCurrentAppIconPath,
  setGetCurrentAppIconPath,
  reactChatSession,
  reactChatWindow,
  sidebarWindow,
  tasksWindow,
  settingsWindow,
  stickerManagerWindow,
  callWindow,
} from "./windows/window-state";
import { broadcastToAllWindows } from "./windows/broadcast";
import { type ReasoningPreference } from "../shared/reasoning";
import { getUiFontResponseHeaders, isSafeUiFontRequest } from "./ui-font-protocol";
import {
  type DefaultChatMode,
  type MobileMessageSegmentationMode,
  type ProactiveChatMode,
  type ProactiveDeliveryTarget,
  type SegmentedOutputMode,
} from "../shared/preferences";
import { STATUS_KEYWORDS } from "./status-keywords";
import {
  addL2MemoryVector,
  addMemory,
  buildMemoryContext,
  deleteUserMemoryVectors,
  getEntriesBySource,
  initRAG,
  isUserMemoryVectorStoreReady,
  switchEmbeddingModel,
} from "./rag";
import { getEmbeddingProvider, getSceneEmbeddingProvider } from "./rag/embedding";
import { configureDocumentIndexQueue } from "./rag/document-index-queue";
import { runDocumentIndexJob } from "./rag/document-index-worker";
import { CyreneAgent } from "./orchestrator/cyrene-agent";
import { createLlmClient, type LlmClient } from "./services/llm/llm-client";
import { createTtsSynthesisService, type TtsSynthesisService } from "./services/tts/tts-synthesis-service";
import { createEmbeddingIndexService, type EmbeddingIndexService } from "./services/embedding/embedding-index-service";
import { registerSettingsIpc } from "./settings/settings-ipc";
import {
  applyGeneralSettings,
  handleGeneralSettingsChanged,
  syncVolcanoSearchMcp,
} from "./settings/general-settings-lifecycle";
import { registerMemoryUserToolIpc } from "./memory/memory-user-ipc";

import { getAdapterForConfig } from "./orchestrator/vendors";
import {
  classifyStructuredOutputEndpoint,
  resolveStructuredOutputProfile,
} from "./orchestrator/structured-output/profiles";
import { normalizeFinishReason } from "./orchestrator/structured-output/finish-reason";

import { getCapability } from "./orchestrator/vendors/capabilities";
import { resolveVendorRuntimeSettings, setVendorRuntimeSettingsGetter } from "./orchestrator/vendors/runtime-settings";

import { toolRegistry } from "./orchestrator/tool-registry";
import { setLive2dWindowSender } from "./orchestrator/built-in-tools";
import { registerAllTools } from "./orchestrator/tool-registration";
import { initMcpManager, pruneMcpServersByIds } from "./orchestrator/mcp-manager";
import { syncPlaywrightMcp, PLAYWRIGHT_MCP_ID, REMOVED_BUILTIN_MCP_IDS } from "./sync-mcp-builtin";
import { initPermissionFromDisk, registerPermissionIpc, getCurrentLevel } from "./permission";
import { registerChoiceIpc, setChoiceCardSender } from "./user-choice";
import {
  initializeScreenshotService,
  type ScreenshotService,
} from "./screenshot/screenshot-lifecycle";
import { createWindowManager, type WindowManager } from "./windows/window-manager";
import { registerWindowSystemIpc } from "./windows/window-system-ipc";
import { enqueueLLMTask } from "./llm-queue";

import { createSocialContextService, type SocialContextService } from "./services/social-context/social-context-service";

import { getStickersDir } from "./sticker-storage";
import { parseLocalStickerFileFromUrl, resolveLocalStickerPath } from "./sticker-protocol";
import { normalizeWindowVisibilitySettings } from "./window-visibility-settings";
import type { StickerConfigItem } from "../shared/sticker-types";

import { memoryStore } from "./memory/memory-store"
import { backupMemoryRagFiles, reconcileMemoryRag } from "./memory/memory-rag-reconciliation";
import { registerChatsIpc } from "./chats/chats-ipc";
import { registerChatUiIpc } from "./chats/chat-ui-ipc";
import * as chatsStore from "./chats/chats-store";
import { flush as flushTokenUsage } from "./token-usage-store";
import { TtsSessionService } from "./tts/tts-session-service";
import { registerTtsIpc } from "./tts/tts-ipc";
import {
  type UserProfile,
  getGeneralSettingsPath,
  getRagStorePath,
  getSettingsPath,
  getUserProfilePath,
  loadUserProfile,
} from "./settings-store";
import {
  type ModelSettings,
  type PublicModelConfig,
  getPublicModelConfig,
  loadModelSettings,
  saveModelSettings,
} from "./settings/model-settings";
import type { GeneralSettings } from "./settings/general-settings";
import { bootstrapConfigGetters } from "./startup/bootstrap-config";
import { type RuntimeState } from "./runtime-state";
import { getAppIconPath } from "./app-icon";
import type { StartTtsRequest } from "../shared/tts-session";
import { registerAgUiIpc, type AguiRunInput } from "./agui-bridge";
import { codeRunWorker } from "./orchestrator/code/code-run-worker";
import {
  setWeatherConfig,
  setSearchConfig,
  loadTodos,
  onTodosChange,
  getCurrentTodos,
  setDelegateSettings,
  setUserTimezoneConfig,
} from "./orchestrator/built-in-tools";
import { TODO_MODES } from "./orchestrator/todo-store";
import { resolveMusicPaths } from "./music/paths";
import { bootstrapMusicService } from "./music/bootstrap";
import { installShutdownLatch } from "./music/shutdown-latch";
import {
  buildConversationTimeContext,
  normalizeChatMessagesWithTime,
  type ChatContextMessage,
} from "./chat-time-context";
import { getDateLocale, updateLocaleContext } from "./locale-context";
import { setAsrConfig } from "./asr/volcano-asr-engine";
import { registerCallIpc, setCallSettings } from "./call/call-manager";
import { initSkills, skillRegistry } from "./skills";
import {
  isMusicCompanionAvailable,
  loadMusicCompanionHost,
} from "./skills/music-companion-host";
import { initGameBot } from "./game-bot";

import { createWindowLifecycleTracker } from "./electron-window-lifecycle";
import { createSchedulerSubsystem, type SchedulerSubsystem } from "./scheduler/bootstrap";
import { createChannelsSubsystem, type ChannelsSubsystem } from "./channels/bootstrap";
import { createAgentRuntime, type AgentRuntime } from "./orchestrator/agent-runtime";
import { createRuntimeStateService } from "./orchestrator/runtime-state-service";
import {
  loadStickerSettings,
  saveStickerSettings,
} from "./orchestrator/sticker-settings";
import { createProactiveLifecycle } from "./proactive/proactive-lifecycle";
import { createCitaService } from "./services/cita/cita-service";
import { contextRefRegistry } from "./orchestrator/tool-context";


configureDocumentIndexQueue(runDocumentIndexJob);

async function reconcileUserMemoryIndex(): Promise<void> {
  if (!isUserMemoryVectorStoreReady()) {
    console.warn("[Memory/RAG] reconciliation skipped: vector store is not writable");
    return;
  }
  const report = await reconcileMemoryRag({
    getMemories: () => memoryStore.getAllL2(),
    getVectors: () => getEntriesBySource("user_memory"),
    backup: async () => backupMemoryRagFiles(app.getPath("userData")),
    addVector: addL2MemoryVector,
    markSynced: (l2Id, ragId) => memoryStore.markL2SyncStatus(l2Id, "synced", ragId),
    markSyncFailed: (l2Id, error) => memoryStore.markL2SyncStatus(l2Id, "sync_failed", undefined, error),
    deleteVectors: (ids) => deleteUserMemoryVectors(ids),
    warn: (message, error) => console.warn(`[Memory/RAG] ${message}:`, error),
  });
  logger.info(LogTag.RAG, "reconciliation:", report);
}

let tray: Tray | null = null;
let schedulerSubsystem: SchedulerSubsystem | null = null;
let channelsSubsystem: ChannelsSubsystem | null = null;
let screenshotService: ScreenshotService | null = null;
let windowManager: WindowManager | null = null;
const live2dWindowLifecycle = createWindowLifecycleTracker<BrowserWindow>("live2d-main", {
  onClosed: () => { /* no-op：原 setLive2dWindow 已随 opener 子系统一起移除 */ },
});

// 聊天窗口当前活跃的会话 id（通过 IPC 由聊天窗口上报）；
// 设置面板"删除当前会话"差异化提示用。聊天窗口关闭时由 closed 事件置 null。

const DEFAULT_CHAT_REQUEST_TIMEOUT_MS = 300000; // FC 总预算：20 轮 × 推理模型 ~10-15s 需 300s 余量

const runtimeStateService = createRuntimeStateService();

function broadcastRuntimeStateChanged(): void {
  broadcastToAuxWindows(IPC.RUNTIME_STATE_CHANGED, runtimeStateService.getState());
}
runtimeStateService.onChange(() => broadcastRuntimeStateChanged());

const llmClient = createLlmClient();
const ttsSynthesisService = createTtsSynthesisService();
const embeddingIndexService = createEmbeddingIndexService();
const citaService = createCitaService({ llmClient });
const socialContextService = createSocialContextService({ llmClient, enqueueLLMTask });

const proactiveLifecycle = createProactiveLifecycle({ loadGeneralSettings });

const ttsSessionService = new TtsSessionService((request, signal, emit) =>
  ttsSynthesisService.synthesizeSession(request, signal, emit),
);


function broadcastToAuxWindows(channel: string, payload: unknown): void {
  for (const win of [reactChatWindow, sidebarWindow, tasksWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function createWindow(manager: WindowManager): void {
  manager.createMainWindow();

  manager.onMainWindowReady((win) => {
    live2dWindowLifecycle.attach(win);
  });
  manager.onMainWindowClosed(() => {
    live2dWindowLifecycle.clear();
  });

  applyGeneralSettings(loadGeneralSettings(), {
    get windowManager() { return manager; },
    get tray() { return tray; },
    get screenshotService() { return screenshotService; },
    get proactiveLifecycle() { return proactiveLifecycle; },
    broadcastToAuxWindows,
  });

  bootstrapConfigGetters({
    loadGeneralSettings,
    getSceneEmbeddingIndex: () => embeddingIndexService.getSceneEmbeddingIndex(),
  });
}


function createTray(deps: {
  toggleMainWindow: () => void;
  createSidebarWindow: () => void;
  createSettingsWindow: () => void;
}): void {
  const icon = nativeImage.createFromPath(getCurrentAppIconPath());
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "打开状态面板",
      click: () => { deps.createSidebarWindow(); },
    },
    {
      label: "设置",
      click: () => { deps.createSettingsWindow(); },
    },
    {
      label: "显示/隐藏桌宠",
      click: () => { deps.toggleMainWindow(); },
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => { app.quit(); },
    },
  ]);

  tray.setToolTip("Cyrene");
  tray.setContextMenu(contextMenu);
}

registerWindowSystemIpc({
  get windowManager() { return windowManager; },
});

registerChatUiIpc({
  live2dWindowLifecycle,
  get windowManager() { return windowManager; },
});

  registerSettingsIpc({
    get windowManager() { return windowManager; },
    getGeneralSettings: loadGeneralSettings,
    saveGeneralSettings,
    getModelSettings: loadModelSettings,
    saveModelSettings,
    runtimeStateService,
    proactiveLifecycle,
    reconcileUserMemoryIndex,
    embeddingIndexService,
  });


  registerMemoryUserToolIpc({
    get windowManager() { return windowManager; },
    embeddingIndexService,
  });



// 注册本地用户资源协议（表情包图片与用户导入的字体）
// 必须在 app.ready 之前调用
protocol.registerSchemesAsPrivileged([
  { scheme: "local-sticker", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: "local-font", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

if (loadGeneralSettings().disableGpuElectron) {
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("enable-unsafe-swiftshader");
}

app.whenReady().then(async () => {
  // Print the banner once at startup. It is plain text (no color, no log
  // prefix) so it stands apart from logger output as a brand artifact.
  process.stdout.write("\n" + renderBanner() + "\n\n");
  logger.info(LogTag.Runtime, "starting Cyrene Agent");

  onGeneralSettingsChanged((before, after) =>
    handleGeneralSettingsChanged(before, after, {
      get windowManager() { return windowManager; },
      get tray() { return tray; },
      get screenshotService() { return screenshotService; },
      get proactiveLifecycle() { return proactiveLifecycle; },
      broadcastToAuxWindows,
    }),
  );

  // 注入应用图标路径 getter（窗口工厂统一从这里读取，避免与 index.ts 循环依赖）
  setGetCurrentAppIconPath(() => getAppIconPath(loadGeneralSettings().uiIcon));

  // 注册 local-sticker:// 协议处理器：将请求映射到 userData/stickers/ 下的文件
  protocol.handle("local-sticker", (request) => {
    const file = parseLocalStickerFileFromUrl(request.url);
    if (!file) return new Response("Invalid sticker URL", { status: 404 });

    const filePath = resolveLocalStickerPath(getStickersDir(), file);
    if (!filePath) return new Response("Invalid sticker path", { status: 403 });

    return net.fetch(pathToFileURL(filePath).toString());
  });
  function getUiFontsDir(): string {
    return path.join(app.getPath("userData"), "ui-fonts");
  }

  protocol.handle("local-font", (request) => {
    let fileName: string;
    try {
      fileName = decodeURIComponent(new URL(request.url).hostname);
    } catch {
      return new Response("Invalid font URL", { status: 404 });
    }
    if (!isSafeUiFontRequest(fileName)) return new Response("Invalid font URL", { status: 404 });
    const filePath = path.join(getUiFontsDir(), fileName);
    if (path.dirname(filePath) !== getUiFontsDir() || !fs.existsSync(filePath)) return new Response("Font not found", { status: 404 });
    return net.fetch(pathToFileURL(filePath).toString()).then((response) => new Response(response.body, {
      headers: getUiFontResponseHeaders(fileName),
    }));
  });
  // ── TTS IPC ──
  // 保存/加载 TTS 配置（复用 general settings 存储）
  ipcMain.handle(IPC.TTS_SAVE_SETTINGS, async (_event, tts: Partial<GeneralSettings>) => {
    const before = loadGeneralSettings();
    const saved = saveGeneralSettings({ ...before, ...tts });

    // 搜索 MCP 自动注册/移除：选 MiniMax+有key→注册，否则→移除
    const searchConfigChanged = "searchMinimaxKey" in tts || "searchEngine" in tts;
    if (searchConfigChanged) {
      await syncVolcanoSearchMcp(saved);
    }

    // Playwright MCP：按 settings 字段自动连接/断开
    if ("playwrightMcpEnabled" in tts) {
      await syncPlaywrightMcp(saved);
    }

    // 主动聊天总开关变化时使现有评估失效（频率档位由 ProactiveChat 内部判定，无需重启）。
    if ("proactiveChatMode" in tts) {
      proactiveLifecycle.getProactiveChatService()?.invalidate();
    }

    // 返回不含密钥明文的副本（前端展示用）
    return saved;
  });
  ipcMain.handle(IPC.TTS_LOAD_SETTINGS, () => {
    return loadGeneralSettings();
  });
  registerTtsIpc({ ttsSessionService });


  // 聊天会话存储 IPC（chats-store.initialize 会建好 cyrene-chats 目录并加载 index）
  registerChatsIpc();
  proactiveLifecycle.initializeProactiveChatService();
  proactiveLifecycle.initializeProactiveTrigger();

  // 工具注册：集中到一个显式入口，取代 index.ts 中的副作用 import
  registerAllTools();

  // 内置 MCP 自动连接：Playwright (默认关闭,选项控制)
  const initialSettings = loadGeneralSettings();

  // 一次性清理已下架的内置 MCP（Firecrawl hosted 等）
  const removed = await pruneMcpServersByIds([...REMOVED_BUILTIN_MCP_IDS]);
  if (removed.length > 0) {
    console.log("[Cyrene] 已清理遗留的已下架内置 MCP:", removed.join(", "));
  }

  void syncPlaywrightMcp(initialSettings).catch((e) =>
    console.error("[Cyrene] playwright MCP sync failed:", e)
  );

  // 截图：原生 helper IPC、全局热键和后台预热。预热失败不会阻止应用启动。
  screenshotService = initializeScreenshotService({
    initialHotkey: initialSettings.screenshotHotkey ?? "Alt+Shift+S",
    getReactChatWindow: () => reactChatWindow,
    captureMainWindow: () => windowManager!.captureMainWindow(),
  });
  void screenshotService.prewarm();

  // Cloud Music MCP wiring (MusicService + IPC + 5 Agent tools + shutdown latch)
  const musicPaths = resolveMusicPaths();
  const musicBootstrap = bootstrapMusicService(musicPaths, {
    contextRefs: contextRefRegistry,
    ingestContextEvent: (event) => citaService.ingest(event),
    sendCard: (card) => {
      if (reactChatWindow && !reactChatWindow.isDestroyed()) {
        reactChatWindow.webContents.send(IPC.AGUI_EVENT, {
          type: "CUSTOM",
          name: "cyrene.music",
          value: card,
        });
        return true;
      }
      return false;
    },
  });
  installShutdownLatch(musicBootstrap);

  // Skill 系统：扫描双源 skills + 注册 meta-tool
  initSkills();
  try {
    loadMusicCompanionHost(
      path.join(app.getAppPath(), "dist", "skills", "cyrene-music-companion", "index.js"),
      () => ({
        skillEnabled: skillRegistry.getById("cyrene-music-companion")?.enabled === true,
        backendAvailable: ["ready", "degraded"].includes(musicBootstrap.service.getBackendState()),
        enabledTools: toolRegistry.getEnabledTools().map((tool) => tool.id),
      }),
    );
    skillRegistry.setAvailability("cyrene-music-companion", isMusicCompanionAvailable);
  } catch (err) {
    console.error("[MusicCompanion] 复合 Skill 加载失败:", err);
    skillRegistry.setAvailability("cyrene-music-companion", () => false);
  }

  // 游戏代肝：IPC + game_bot_start 工具
  initGameBot();

  // 任务清单（todo_write 工具的持久化 + 事件广播）：
  // - loadTodos 从磁盘恢复上次未完成的任务（跨重启延续）
  // - onTodosChange 按 mode 订阅变化，把 TodoState 作为 CUSTOM 事件转发给所有聊天窗口
  //   渲染端收到 cyrene.todos 后根据 mode 更新对应模式的进度面板
  loadTodos();
  for (const mode of TODO_MODES) {
    onTodosChange(mode, (state) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        try {
          win.webContents.send(IPC.AGUI_EVENT, {
            type: "CUSTOM",
            name: "cyrene.todos",
            value: state,
          });
        } catch (e) {
          console.warn("[Cyrene] todos 广播失败:", e);
        }
      }
    });
  }

  // AG-UI 事件流桥：渲染进程 invoke(AGUI_RUN) → CyreneAgent 跑 FC 循环 → 事件透传
  const agentRuntime = createAgentRuntime({
    runtimeStateService,
    llmClient,
    enqueueLLMTask,
    loadModelSettings,
    loadGeneralSettings,
    loadUserProfile,
    toolRegistry,
    skillRegistry,
    getSceneEmbeddingIndex: () => embeddingIndexService.getSceneEmbeddingIndex(),
    getStickerEmbeddingIndex: () => embeddingIndexService.getStickerEmbeddingIndex(),
    getEmbeddingProvider,
    getSceneEmbeddingProvider,
    broadcastRuntimeStateChanged,
    citaService,
    socialContextScheduler: socialContextService.scheduler,
    chatsStore,
    socialAtomStore: socialContextService.store,
  });

  schedulerSubsystem = createSchedulerSubsystem(agentRuntime, () => reactChatWindow);

  // 多渠道（微信/飞书/...）：组装 dispatcher 依赖并启动 channels 模块。
  channelsSubsystem = createChannelsSubsystem({
    agentRuntime,
    ttsSynthesisService,
    getReactChatWindow: () => reactChatWindow,
  });

  registerAgUiIpc(
    (input) => agentRuntime.buildOptions(input),
    // sticker 由 bridge 发送回本次 run 的发起窗口；默认兜底目标为 reactChatWindow。
    (result, latestUserText) => agentRuntime.onRunFinished(result, latestUserText),
    () => reactChatWindow,
    proactiveLifecycle.proactiveConversationLifecycle,
  );

  // 状态栏专用入口：打开/复用 reactChatWindow
  ipcMain.handle(IPC.TODOS_GET_CURRENT, () => getCurrentTodos());

  const generalSettings = loadGeneralSettings();
  // 初始化 Locale Context（从 GeneralSettings 的语言配置同步）
  updateLocaleContext({
    uiLocale: generalSettings.language,
    dateLocale: generalSettings.language,
    asrLanguage: generalSettings.asrLanguage,
  });

  const manager = createWindowManager({
    getCurrentAppIconPath,
    isDev,
    loadMainWindowSettingsSlice: loadGeneralSettings,
    persistMainWindowPosition: ({ x, y }) => saveGeneralSettings({ petWindowX: x, petWindowY: y }),
  });
  windowManager = manager;

  createWindow(manager);
  setLive2dWindowSender((channel, payload) => manager.sendToMainWindow(channel, payload));
  manager.createReactChatWindow();
  if (generalSettings.sidebarVisible) manager.createSidebarWindow();
  if (generalSettings.tasksVisible) manager.createTasksWindow();
  createTray({
    toggleMainWindow: () => manager.toggleMainWindow(),
    createSidebarWindow: () => manager.createSidebarWindow(),
    createSettingsWindow: () => manager.createSettingsWindow(),
  });
  // 权限模块初始化：必须在 createWindow 之后但任意工具调用之前
  initPermissionFromDisk();
  registerPermissionIpc();
  registerChoiceIpc();
  registerCallIpc();
  logger.info(LogTag.Cyrene, "当前 agent 权限档位:", getCurrentLevel());
  try {
    const modelSettings = loadModelSettings();
    await initRAG("auto", undefined, undefined, modelSettings.embeddingModel, modelSettings.embeddingDimensions);
    try {
      await reconcileUserMemoryIndex();
    } catch (err) {
      console.warn("[Memory/RAG] startup reconciliation failed:", err);
    }
    // 初始化 MCP Manager；scheduler 启动前等待一次，避免近即时任务早于 MCP 工具恢复。
    await initMcpManager();
    logger.info(LogTag.Cyrene, "RAG initialized OK");

    logger.info(LogTag.Reranker, "startup preload skipped; reranker initializes when changed in settings.");
  } catch (err) {
    console.error("[Cyrene] RAG init FAILED:", err);
  }

  embeddingIndexService.scheduleStartupRefreshes();

  schedulerSubsystem.engine.start();
});

app.on("window-all-closed", () => {});

// 应用退出前把 token 用量缓存落盘（防抖未触发的最后一次写）
app.on("before-quit", () => {
  windowManager?.dispose();
  schedulerSubsystem?.engine.stop();
  proactiveLifecycle.stopProactiveTrigger();
  codeRunWorker.cleanup();
  flushTokenUsage();
  void channelsSubsystem?.shutdown();
  void screenshotService?.shutdown();
});

app.on("activate", () => {
  windowManager?.createMainWindow();
});







