import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, dialog, globalShortcut } from "electron";
import * as path from "path";

import { logger, LogTag } from "./logger";
import { renderBanner } from "../shared/banner";
import { createHash, randomUUID } from "crypto";
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
import { LspManager } from "./lsp/manager";
import { initSandbox } from "./orchestrator/sandbox/sandbox-exec";
import { initPlanPaths, initPlanStateBroadcaster, enterPlanDiscussing, exitPlanMode, getPlanState } from "./orchestrator/plan-mode";
import { initMcpManager, pruneMcpServersByIds } from "./orchestrator/mcp-manager";
import { syncPlaywrightMcp, PLAYWRIGHT_MCP_ID, REMOVED_BUILTIN_MCP_IDS } from "./sync-mcp-builtin";
import { bootstrapPermission } from "./permission/bootstrap";
import { registerChoiceIpc, setChoiceCardSender } from "./user-choice";
import {
  initializeScreenshotService,
  type ScreenshotService,
} from "./screenshot/screenshot-lifecycle";
import { createWindowManager, type WindowManager } from "./windows/window-manager";
import { registerWindowSystemIpc } from "./windows/window-system-ipc";
import { createTray } from "./tray";
import { enqueueLLMTask } from "./llm-queue";

import { createSocialContextService, type SocialContextService } from "./services/social-context/social-context-service";

import {
  registerPrivilegedSchemes,
  registerProtocolHandlers,
} from "./protocols/bootstrap";
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
import {
  setWeatherConfig,
  setSearchConfig,
  setUserTimezoneConfig,
} from "./orchestrator/built-in-tools";
import { resolveMusicPaths } from "./music/paths";
import { bootstrapGameBot } from "./game-bot/bootstrap";
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
import { createGitService } from "./code-git/git-service";
import type { GitService } from "./code-git/git-service";
import { resolveGitExecutable } from "./code-git/git-executable";
import { registerCodeGitIpc } from "./code-git/code-git-ipc";
import { installSingleInstanceGuard } from "./single-instance";


configureDocumentIndexQueue(runDocumentIndexJob);

const isPrimaryCyreneProcess = installSingleInstanceGuard(app, () => {
  windowManager?.showMainWindow();
});

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
let lspManager: LspManager | null = null;
let codeGitService: GitService | null = null;
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
    syncVolcanoSearchMcp,
    syncPlaywrightMcp,
  });


  registerMemoryUserToolIpc({
    get windowManager() { return windowManager; },
    embeddingIndexService,
  });



// 注册本地用户资源协议（表情包图片与用户导入的字体）
// 必须在 app.ready 之前调用
registerPrivilegedSchemes();

if (loadGeneralSettings().disableGpuElectron) {
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("enable-unsafe-swiftshader");
}

if (isPrimaryCyreneProcess) app.whenReady().then(async () => {
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

  // 注册本地用户资源协议处理器
  registerProtocolHandlers();

  // ── TTS IPC ──
  registerTtsIpc({ ttsSessionService });


  // 聊天会话存储 IPC（chats-store.initialize 会建好 cyrene-chats 目录并加载 index）
  registerChatsIpc();
  codeGitService = createGitService({
    getSession: chatsStore.getSession,
    resolveExecutable: () => resolveGitExecutable({
      systemCommand: "git",
      bundledPath: app.isPackaged
        ? path.join(process.resourcesPath, "mingit", "cmd", "git.exe")
        : path.join(app.getAppPath(), "resources", "mingit", "cmd", "git.exe"),
    }),
  });
  registerCodeGitIpc({ service: codeGitService });
  proactiveLifecycle.initializeProactiveChatService();
  proactiveLifecycle.initializeProactiveTrigger();

  // SRT 沙箱初始化（检测安装状态，不弹 UAC）：必须在 registerAllTools 前，
  // 让 run_shell 的 workspace_mutation 分支能用上沙箱。失败不阻塞启动（fallback 到直接 spawn）。
  await initSandbox().catch((e) =>
    logger.error(LogTag.Runtime, "[Sandbox] initSandbox failed at startup:", e),
  );

  // 计划模式路径根注入：write_plan / plan.md 读写都基于 userData/plans/<conversationId>/。
  initPlanPaths(app.getPath("userData"));
  // 计划模式状态广播：所有状态切换都广播到所有窗口，让 PlanModeToggle 等组件
  // 能感知任何入口触发的状态变化（模型 enter_plan_mode / 用户开关 / 审批 / 执行完成）。
  initPlanStateBroadcaster((conversationId, state) => {
    const payload = { conversationId, state };
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.PLAN_STATE_CHANGED, payload);
    }
  });
  // 计划模式开关 IPC：renderer 调 setPlanMode({ conversationId, target, workspaceRoot? })
  //   - target="on"  → 进入 PLAN_DISCUSSING（已激活时 no-op；带 workspaceRoot 时计划文件落工作区 .cyrene/）
  //   - target="off" → 退出回 NORMAL（EXECUTING 中拒绝退出）
  ipcMain.handle(IPC.PLAN_SET_MODE, (_event, payload: { conversationId?: string; target?: "on" | "off"; workspaceRoot?: string }) => {
    const conversationId = payload?.conversationId;
    const target = payload?.target;
    if (!conversationId) return { ok: false, reason: "缺少 conversationId" };
    if (target !== "on" && target !== "off") return { ok: false, reason: "target 必须是 on/off" };
    const current = getPlanState(conversationId);
    if (target === "on") {
      if (current !== "NORMAL") return { ok: true, state: current }; // 已激活：no-op
      const t = enterPlanDiscussing(conversationId, payload.workspaceRoot);
      if (!t.ok) return { ok: false, reason: t.reason, state: current };
      return { ok: true, state: getPlanState(conversationId) };
    }
    // target === "off"
    if (current === "EXECUTING") {
      return { ok: false, reason: "计划执行中，不可手动退出", state: current };
    }
    if (current === "NORMAL") return { ok: true, state: current };
    exitPlanMode(conversationId);
    return { ok: true, state: getPlanState(conversationId) };
  });
  // 计划模式状态查询 IPC：renderer 挂载时调一次拿初始状态
  ipcMain.handle(IPC.PLAN_GET_STATE, (_event, payload: { conversationId?: string }) => {
    const conversationId = payload?.conversationId;
    if (!conversationId) return { state: "NORMAL" as const };
    return { state: getPlanState(conversationId) };
  });

  // 工具注册：集中到一个显式入口，取代 index.ts 中的副作用 import
  lspManager = new LspManager({
    getServerOverrides: () => loadGeneralSettings().lspServerOverrides,
  });
  registerAllTools({ codeGitService, lspManager });

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

  // Cloud Music wiring (MusicService + IPC + 9 Agent tools + shutdown latch)
  const musicPaths = resolveMusicPaths();
  const musicBootstrap = bootstrapMusicService(musicPaths, {
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

  // 启动游戏代肝子系统
  bootstrapGameBot();

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
    (result, latestUserText, conversationId) => agentRuntime.onRunFinished(result, latestUserText, undefined, conversationId),
    () => reactChatWindow,
    proactiveLifecycle.proactiveConversationLifecycle,
  );

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
  tray = createTray({
    toggleMainWindow: () => manager.toggleMainWindow(),
    createReactChatWindow: () => manager.createReactChatWindow(),
    createSidebarWindow: () => manager.createSidebarWindow(),
    createSettingsWindow: () => manager.createSettingsWindow(),
  });
  // 权限模块初始化：必须在 createWindow 之后但任意工具调用之前
  bootstrapPermission();
  registerCallIpc();
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
    logger.info(LogTag.RAG, "RAG initialized OK");

    // 初始化 reranker：根据设置决定是否启用（默认 standard）
    // initReranker 内部会检测模型是否安装，未安装时自动降级为 none
    try {
      const { initReranker } = await import("./rag/reranker");
      await initReranker(modelSettings.rerankerMode);
      logger.info(LogTag.Reranker, "initialized with mode:", modelSettings.rerankerMode);
    } catch (err) {
      logger.warn(LogTag.Reranker, "startup init failed:", err);
    }
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
  flushTokenUsage();
  void channelsSubsystem?.shutdown();
  void screenshotService?.shutdown();
  void lspManager?.disposeAll();
  void codeGitService?.dispose();
});

app.on("activate", () => {
  windowManager?.createMainWindow();
});







