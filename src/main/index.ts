import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, dialog, protocol, net, globalShortcut } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { logger, LogTag } from "./logger";
import { renderBanner } from "../shared/banner";
import { createHash, randomUUID } from "crypto";
import { pathToFileURL } from "url";
import { IPC } from "../shared/ipc-channels";
import { type UiTheme } from "../shared/ui-theme";
import { DEFAULT_UI_FONT, isSupportedFontFileName, type UiFont } from "../shared/ui-font";
import { type UiIcon } from "../shared/ui-icon";
import { normalizeChatAppearance, type ChatAppearanceSettings } from "../shared/chat-appearance";
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
import { normalizeReasoningPreference, type ReasoningPreference } from "../shared/reasoning";
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
  deleteImportedDoc,
  deleteUserMemoryVectors,
  getEntriesBySource,
  initRAG,
  isUserMemoryVectorStoreReady,
  switchEmbeddingModel,
} from "./rag";
import { getEmbeddingProvider, getSceneEmbeddingProvider } from "./rag/embedding";
import { describePendingAttachment } from "./rag/file-ingest";
import { cancelDocumentIndexJob, configureDocumentIndexQueue, enqueueDocumentIndexJob } from "./rag/document-index-queue";
import { retrieveQueuedDocumentChunks, runDocumentIndexJob } from "./rag/document-index-worker";
import { processDocumentIndexRequest } from "./rag/document-index-ipc";
import {
  IMAGE_CAPTION_PROMPT,
  buildImageCaptionPrompt,
  validateCaptionImagePath,
} from "./chat/image-caption";
import { decideImageSendStrategy } from "./chat/image-send-strategy";
import { CyreneAgent } from "./orchestrator/cyrene-agent";
import { validateSearchApiKey } from "./orchestrator/search-backend-filter";
import { createLlmClient, type LlmClient } from "./services/llm/llm-client";
import { createTtsSynthesisService, type TtsSynthesisService } from "./services/tts/tts-synthesis-service";
import { createEmbeddingIndexService, type EmbeddingIndexService } from "./services/embedding/embedding-index-service";

import { getAdapterForConfig } from "./orchestrator/vendors";
import type { StructuredOutputRequest, VendorConfig } from "./orchestrator/vendors";
import {
  classifyStructuredOutputEndpoint,
  resolveStructuredOutputProfile,
} from "./orchestrator/structured-output/profiles";
import { normalizeFinishReason } from "./orchestrator/structured-output/finish-reason";
import { testVendorConnection } from "./orchestrator/vendors/test-connection";

import { getCapability, getCapabilityOrOpenAI } from "./orchestrator/vendors/capabilities";
import { resolveVendorRuntimeSettings, setVendorRuntimeSettingsGetter } from "./orchestrator/vendors/runtime-settings";

import { toolRegistry } from "./orchestrator/tool-registry";
import { setLive2dWindowSender } from "./orchestrator/built-in-tools";
import { registerAllTools, syncBuiltInToolToggles } from "./orchestrator/tool-registration";
import { initMcpManager, addMcpServer, removeMcpServer, listMcpServers, pruneMcpServersByIds } from "./orchestrator/mcp-manager";
import { syncPlaywrightMcp, PLAYWRIGHT_MCP_ID, REMOVED_BUILTIN_MCP_IDS } from "./sync-mcp-builtin";
import { initPermissionFromDisk, registerPermissionIpc, getCurrentLevel } from "./permission";
import { registerChoiceIpc, setChoiceCardSender } from "./user-choice";
import {
  initializeScreenshotService,
  type ScreenshotService,
} from "./screenshot/screenshot-lifecycle";
import { createWindowManager, type WindowManager } from "./windows/window-manager";
import { enqueueLLMTask } from "./llm-queue";

import { createSocialContextService, type SocialContextService } from "./services/social-context/social-context-service";
import { getEmbeddingStatus, downloadEmbeddingModel, deleteEmbeddingModel } from "./embedding-manager";
import { loadUserStickerManifest, addUserSticker, deleteUserSticker, isStickerIdTaken, getStickersDir } from "./sticker-storage";
import { parseLocalStickerFileFromUrl, resolveLocalStickerPath } from "./sticker-protocol";
import { normalizeWindowVisibilitySettings } from "./window-visibility-settings";
import type { StickerConfigItem } from "../shared/sticker-types";
import { initReranker, getRerankerInstallStatus } from "./rag/reranker";
import { memoryStore } from "./memory/memory-store"
import { backupMemoryRagFiles, reconcileMemoryRag } from "./memory/memory-rag-reconciliation";
import type { L0Profile, L1Profile } from "./memory/memory-types";
import { registerChatsIpc } from "./chats/chats-ipc";
import * as chatsStore from "./chats/chats-store";
import { getUsage, flush as flushTokenUsage } from "./token-usage-store";
import { TtsSessionService } from "./tts/tts-session-service";
import { registerTtsIpc } from "./tts/tts-ipc";
import {
  type UserProfile,
  getAvatarPath,
  getGeneralSettingsPath,
  getRagStorePath,
  getSettingsPath,
  getUserProfilePath,
  loadUserProfile,
  saveUserProfile,
} from "./settings-store";
import {
  type ModelSettings,
  type PublicModelConfig,
  getPublicModelConfig,
  loadModelSettings,
  loadVisionConfig,
  normalizeModelSettings,
  saveModelSettings,
} from "./settings/model-settings";
import type { GeneralSettings } from "./settings/general-settings";
import { bootstrapConfigGetters } from "./startup/bootstrap-config";
import { loadMemoryPanelData } from "./memory/panel";
import { type RuntimeState } from "./runtime-state";
import { getAppIconPath } from "./app-icon";
import { ensureCustomStylePrompt } from "./style-prompt";
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
import { initSkills, skillRegistry, setSkillEnabled, listSkillsForUi } from "./skills";
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
  getStickerManagerConfig,
  loadStickerSettings,
  saveStickerSettings,
  setStickerEnabled,
} from "./orchestrator/sticker-settings";
import { createProactiveLifecycle } from "./proactive/proactive-lifecycle";
import { createCitaService } from "./services/cita/cita-service";
import { contextRefRegistry } from "./orchestrator/tool-context";
import { getTimeoutSettings, saveTimeoutSettings } from "./timeout-manager";
import { TimeoutSettings } from "../shared/timeout-types";

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
let activeChatSessionId: string | null = null;

const DEFAULT_CHAT_REQUEST_TIMEOUT_MS = 300000; // FC 总预算：20 轮 × 推理模型 ~10-15s 需 300s 余量

const runtimeStateService = createRuntimeStateService();
runtimeStateService.onChange(() => broadcastRuntimeStateChanged());
const llmClient = createLlmClient();
const ttsSynthesisService = createTtsSynthesisService();
const embeddingIndexService = createEmbeddingIndexService();
const socialContextService = createSocialContextService({ llmClient, enqueueLLMTask });

const proactiveLifecycle = createProactiveLifecycle({ loadGeneralSettings });

const ttsSessionService = new TtsSessionService((request, signal, emit) =>
  ttsSynthesisService.synthesizeSession(request, signal, emit),
);

function applyGeneralSettings(settings: GeneralSettings): void {
  windowManager?.setMainWindowAlwaysOnTop(settings.petAlwaysOnTop);
  if (settings.petVisible) windowManager?.showMainWindow();
  else windowManager?.hideMainWindow();
  app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
  windowManager?.applyMainWindowZoom(settings.petZoom);
}

function handleGeneralSettingsChanged(before: GeneralSettings, after: GeneralSettings): void {
  applyGeneralSettings(after);
  syncBuiltInToolToggles(after);
  // 同步语言设置到 Locale Context
  if (before.language !== after.language || before.asrLanguage !== after.asrLanguage) {
    updateLocaleContext({
      uiLocale: after.language,
      dateLocale: after.language,
      asrLanguage: after.asrLanguage,
    });
  }
  if (before.uiTheme !== after.uiTheme) {
    broadcastUiThemeChanged(after.uiTheme);
  }
  if (before.uiThemeRadius !== after.uiThemeRadius) {
    broadcastUiThemeRadiusChanged(after.uiThemeRadius);
  }
  if (before.windowCornerRadius !== after.windowCornerRadius) {
    broadcastWindowCornerRadiusChanged(after.windowCornerRadius);
  }
  if (JSON.stringify(before.uiFont) !== JSON.stringify(after.uiFont)) {
    broadcastUiFontChanged(after.uiFont);
  }
  const prevAppearance = normalizeChatAppearance(before);
  const nextAppearance = normalizeChatAppearance(after);
  if (
    prevAppearance.chatLineHeight !== nextAppearance.chatLineHeight
    || prevAppearance.assistantBubbleEnabled !== nextAppearance.assistantBubbleEnabled
  ) {
    broadcastToAllWindows(IPC.CHAT_TYPOGRAPHY_CHANGED, nextAppearance);
  }
  if (before.uiIcon !== after.uiIcon) {
    applyUiIcon(after.uiIcon);
  }
  if (before.screenshotHotkey !== after.screenshotHotkey) {
    const result = screenshotService?.replaceHotkey(after.screenshotHotkey);
    if (result && !result.ok) {
      console.warn("[Cyrene] 截图热键注册失败，可能被其他应用占用:", after.screenshotHotkey);
    }
  }
  if (
    before.proactiveChatMode !== after.proactiveChatMode
    || before.proactiveDeliveryTarget !== after.proactiveDeliveryTarget
  ) {
    proactiveLifecycle.getProactiveChatService()?.invalidate();
  }
  setGetCurrentAppIconPath(() => getAppIconPath(after.uiIcon));
  void syncVolcanoSearchMcp(after);
}

/** MiniMax 搜索 MCP Server 的固定 ID。 */
const MINIMAX_SEARCH_MCP_ID = "minimax-web-search";

/**
 * 同步搜索 MCP Server：选 MiniMax+有key→注册连接，否则→移除断开。
 * 在 TTS_SAVE_SETTINGS 检测到搜索配置变化时调用。
 */
async function syncVolcanoSearchMcp(settings: GeneralSettings): Promise<{ mcpSyncResult: string }> {
  // ── MiniMax（PyPI包，不依赖GitHub，推荐）──
  const minimaxEnable = settings.searchEngine === "minimax";
  const minimaxExists = listMcpServers().some(s => s.id === MINIMAX_SEARCH_MCP_ID);

  // Key 校验（不泄漏原始 Key）
  if (minimaxEnable) {
    const keyValidation = validateSearchApiKey(settings.searchMinimaxKey, "MiniMax API Key");
    console.log(`[Cyrene] MiniMax Key 校验: length=${keyValidation.diagnostics.length} trimmed=${keyValidation.diagnostics.trimmed} nonAscii=${keyValidation.diagnostics.hasNonAscii} controlChars=${keyValidation.diagnostics.hasControlChars}`);
    if (!keyValidation.valid) {
      console.error(`[Cyrene] MiniMax Key 校验失败: ${keyValidation.error}`);
      // Key 不合法时，如果 MCP 存在则清理
      if (minimaxExists) {
        try { await removeMcpServer(MINIMAX_SEARCH_MCP_ID); } catch (err) { console.error("[Cyrene] MiniMax 搜索 MCP 移除异常:", err); }
      }
      return { mcpSyncResult: `key_invalid: ${keyValidation.error}` };
    }
  }

  if (minimaxEnable && !minimaxExists) {
    console.log("[Cyrene] 注册 MiniMax 搜索 MCP Server...");
    try {
      const result = await addMcpServer({
        id: MINIMAX_SEARCH_MCP_ID,
        name: "MiniMax搜索",
        transport: "stdio",
        command: "uvx",
        args: ["minimax-coding-plan-mcp", "-y"],
        env: {
          MINIMAX_API_KEY: settings.searchMinimaxKey.trim(),
          MINIMAX_API_HOST: "https://api.minimaxi.com",
        },
      });
      if (result.ok) {
        console.log("[Cyrene] MiniMax 搜索 MCP 注册成功，工具:", result.toolIds?.join(", "));
        return { mcpSyncResult: `registered: ${result.toolIds?.join(", ") ?? "none"}` };
      } else {
        console.error("[Cyrene] MiniMax 搜索 MCP 注册失败:", result.error);
        return { mcpSyncResult: `register_failed: ${result.error}` };
      }
    } catch (err) {
      console.error("[Cyrene] MiniMax 搜索 MCP 注册异常:", err);
      return { mcpSyncResult: `register_exception: ${err}` };
    }
  } else if (!minimaxEnable && minimaxExists) {
    console.log("[Cyrene] 移除 MiniMax 搜索 MCP Server...");
    try { await removeMcpServer(MINIMAX_SEARCH_MCP_ID); return { mcpSyncResult: "removed" }; } catch (err) { console.error("[Cyrene] MiniMax 搜索 MCP 移除异常:", err); return { mcpSyncResult: `remove_exception: ${err}` }; }
  } else if (minimaxEnable && minimaxExists) {
    console.log("[Cyrene] MiniMax 搜索 key 变化，重新注册 MCP Server...");
    try {
      await removeMcpServer(MINIMAX_SEARCH_MCP_ID);
      await addMcpServer({
        id: MINIMAX_SEARCH_MCP_ID, name: "MiniMax搜索", transport: "stdio",
        command: "uvx",
        args: ["minimax-coding-plan-mcp", "-y"],
        env: { MINIMAX_API_KEY: settings.searchMinimaxKey.trim(), MINIMAX_API_HOST: "https://api.minimaxi.com" },
      });
      return { mcpSyncResult: "reregistered" };
    } catch (err) { console.error("[Cyrene] MiniMax 搜索 MCP 重新注册异常:", err); return { mcpSyncResult: `reregister_exception: ${err}` }; }
  }
  return { mcpSyncResult: "no_change" };
}

const citaService = createCitaService({ llmClient });

function broadcastToAuxWindows(channel: string, payload: unknown): void {
  for (const win of [reactChatWindow, sidebarWindow, tasksWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function broadcastUiThemeChanged(theme: GeneralSettings["uiTheme"]): void {
  windowManager?.broadcast(IPC.UI_THEME_CHANGED, theme);
}

function broadcastUiThemeRadiusChanged(theme: GeneralSettings["uiThemeRadius"]): void {
  windowManager?.broadcast(IPC.UI_THEME_RADIUS_CHANGED, theme);
}

function broadcastWindowCornerRadiusChanged(radius: GeneralSettings["windowCornerRadius"]): void {
  windowManager?.broadcast(IPC.UI_WINDOW_CORNER_RADIUS_CHANGED, radius);
}

function broadcastUiFontChanged(font: GeneralSettings["uiFont"]): void {
  windowManager?.broadcast(IPC.UI_FONT_CHANGED, font);
}

function broadcastModelConfigChanged(settings = loadModelSettings()): void {
  broadcastToAuxWindows(IPC.MODEL_CONFIG_CHANGED, getPublicModelConfig(settings));
}

function broadcastRuntimeStateChanged(): void {
  broadcastToAuxWindows(IPC.RUNTIME_STATE_CHANGED, runtimeStateService.getState());
}

function createWindow(manager: WindowManager): void {
  manager.createMainWindow();

  manager.onMainWindowReady((win) => {
    live2dWindowLifecycle.attach(win);
  });
  manager.onMainWindowClosed(() => {
    live2dWindowLifecycle.clear();
  });

  applyGeneralSettings(loadGeneralSettings());

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

function applyUiIcon(iconSetting: UiIcon): void {
  const icon = nativeImage.createFromPath(getAppIconPath(iconSetting));
  if (icon.isEmpty()) {
    console.warn("[Cyrene] failed to load selected app icon:", iconSetting);
    return;
  }
  tray?.setImage(icon);
  windowManager?.setIconForAllWindows(icon);
}

ipcMain.handle(IPC.WINDOW_SET_INTERACTIVE, (_event, interactive: boolean) => {
  windowManager?.setMainWindowInteractive(interactive);
});

ipcMain.on(IPC.WINDOW_MOVE, (_event, dx: number, dy: number) => {
  windowManager?.moveMainWindowRelative(dx, dy);
});

ipcMain.on(IPC.WINDOW_MOVE_TO, (_event, x: number, y: number) => {
  windowManager?.moveMainWindowTo(x, y);
});

ipcMain.on(IPC.WINDOW_SET_DRAGGING, (_event, isDragging: boolean) => {
  windowManager?.setMainWindowDragging(isDragging);
});

ipcMain.handle(IPC.WINDOW_CAPTURE_FRAME, async () => windowManager?.captureMainWindowFrame() ?? null);
ipcMain.handle(IPC.WINDOW_GET_CURSOR_POSITION, () => windowManager?.getCursorScreenPosition() ?? { x: 0, y: 0 });

ipcMain.handle(IPC.LIVE2D_GET_MAIN_DIAGNOSTICS, () => ({
  window: live2dWindowLifecycle.getDiagnostics(),
}));

ipcMain.on(IPC.WINDOW_MINIMIZE, () => {
  windowManager?.minimizeMainWindow();
});

ipcMain.on(IPC.WINDOW_CLOSE, () => {
  windowManager?.hideMainWindow();
});

ipcMain.on(IPC.APP_QUIT, () => {
  app.quit();
});

ipcMain.on(IPC.CHAT_MINIMIZE, (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});

ipcMain.on(IPC.CHAT_CLOSE, (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.on(IPC.CHAT_TOGGLE_MAXIMIZE, (event) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!senderWindow) return;
  if (senderWindow.isMaximized()) {
    senderWindow.unmaximize();
  } else {
    senderWindow.maximize();
  }
});

ipcMain.handle(IPC.CHAT_IS_MAXIMIZED, (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
});

// 推理下拉原子读：{ providerKey, providerId, model, preference }
// providerKey = settings.provider（displayName），用来防竞态；chat:setReasoning 需携带同 providerKey。
ipcMain.handle(IPC.CHAT_GET_REASONING_STATE, () => {
  const settings = loadModelSettings();
  const cap = getCapabilityOrOpenAI(settings.provider);
  return {
    providerKey: settings.provider,
    providerId: cap.id,
    model: settings.model,
    preference: settings.perProvider?.[settings.provider]?.reasoning,
    thinkingOverride: settings.thinkingOverride,
  };
});

// 推理下拉写：原子。payload 形如 { providerKey, preference }，providerKey 防竞态。
ipcMain.handle(IPC.CHAT_SET_REASONING, (_event, payload: unknown) => {
  if (!payload || typeof payload !== "object") return;
  const p = payload as { providerKey?: unknown; preference?: unknown };
  if (typeof p.providerKey !== "string" || typeof p.preference !== "object" || !p.preference) return;
  const current = loadModelSettings();
  if (current.provider !== p.providerKey) {
    // 竞态：用户拿到 state 后、点选项前，provider 已切换。丢弃旧 providerKey 的写。
    return;
  }
  const normalized = normalizeReasoningPreference(p.preference);
  if (!normalized) return;
  saveModelSettings({ reasoning: normalized });
});
ipcMain.handle(IPC.CHAT_INGEST_FILES, async (_event, paths: unknown) => {
  const list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") : [];
  if (list.length === 0) return [];
  try {
    return list.map((filePath) => describePendingAttachment(filePath));
  } catch (err: any) {
    console.error("[Cyrene] ingestFiles ERROR:", err?.message || err);
    return [];
  }
});

ipcMain.handle(IPC.CHAT_PROCESS_DOCUMENTS, async (event, payload: unknown) => {
  const filePaths = payload && typeof payload === "object" && Array.isArray((payload as { filePaths?: unknown }).filePaths)
    ? (payload as { filePaths: unknown[] }).filePaths.filter((p): p is string => typeof p === "string")
    : [];
  if (filePaths.length === 0) return [];
  const query = typeof (payload as { query?: unknown }).query === "string"
    ? (payload as { query: string }).query
    : "";
  return processDocumentIndexRequest({
    filePaths,
    query,
    sender: event.sender,
    enqueue: enqueueDocumentIndexJob,
    retrieve: retrieveQueuedDocumentChunks,
  });
});

ipcMain.handle(IPC.CHAT_CANCEL_DOCUMENT_INDEX, (_event, payload: unknown) => {
  const jobId = payload && typeof payload === "object" ? (payload as { jobId?: unknown }).jobId : undefined;
  return typeof jobId === "string" && cancelDocumentIndexJob(jobId);
});

ipcMain.handle(IPC.CHAT_CAPTION_IMAGE, async (_event, payload: unknown) => {
  const filePath = payload && typeof payload === "object"
    ? (payload as { filePath?: unknown }).filePath
    : undefined;
  const hasAnnotations = payload && typeof payload === "object"
    ? (payload as { hasAnnotations?: unknown }).hasAnnotations === true
    : false;
  const validated = validateCaptionImagePath(filePath);
  if (!validated.ok) return { ok: false, error: validated.error };

  const visionCfg = loadVisionConfig();
  if (!visionCfg) {
    return { ok: false, error: "未配置视觉模型，无法分析图片" };
  }

  try {
    const { captionImage } = await import("./orchestrator/vision-captioner");
    const caption = await captionImage(
      { base64: validated.buffer.toString("base64"), mime: validated.mime },
      buildImageCaptionPrompt(hasAnnotations),
      visionCfg,
    );
    if (caption.startsWith("[错误")) {
      return { ok: false, error: caption };
    }
    return { ok: true, caption };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle(IPC.CHAT_GET_IMAGE_PREVIEW, (_event, payload: unknown) => {
  const filePath = payload && typeof payload === "object"
    ? (payload as { filePath?: unknown }).filePath
    : undefined;
  const validated = validateCaptionImagePath(filePath);
  if (!validated.ok) return { ok: false, error: validated.error };
  return {
    ok: true,
    dataUrl: `data:${validated.mime};base64,${validated.buffer.toString("base64")}`,
  };
});

ipcMain.handle(IPC.CHAT_GET_IMAGE_SEND_STRATEGY, () => {
  const settings = loadModelSettings();
  return decideImageSendStrategy({
    multimodal: settings.multimodal,
    vision: loadVisionConfig(),
  });
});
ipcMain.on(IPC.SIDEBAR_MINIMIZE, () => {
  sidebarWindow?.minimize();
});

ipcMain.on(IPC.SIDEBAR_CLOSE, () => {
  sidebarWindow?.close();
});

// 状态栏窗口置顶 toggle：返回切换后的新状态（true=已置顶）
ipcMain.handle(IPC.SIDEBAR_TOGGLE_ALWAYS_ON_TOP, () => {
  if (!sidebarWindow) return false;
  const next = !sidebarWindow.isAlwaysOnTop();
  sidebarWindow.setAlwaysOnTop(next, next ? "screen-saver" : "normal");
  return next;
});

ipcMain.on(IPC.SIDEBAR_OPEN_TASKS, () => {
  windowManager?.createTasksWindow();
});

ipcMain.on(IPC.SIDEBAR_OPEN_SETTINGS, (_event, section?: string) => {
  windowManager?.createSettingsWindow(section);
});

ipcMain.on(IPC.SIDEBAR_OPEN_CALL, () => {
  windowManager?.createCallWindow();
});

ipcMain.on(IPC.TASKS_MINIMIZE, () => {
  tasksWindow?.minimize();
});

ipcMain.on(IPC.TASKS_CLOSE, () => {
  tasksWindow?.close();
});
ipcMain.on(IPC.SETTINGS_MINIMIZE, () => {
  settingsWindow?.minimize();
});

ipcMain.on(IPC.SETTINGS_CLOSE, () => {
  settingsWindow?.close();
});

ipcMain.handle(IPC.SETTINGS_GET_CONFIG, () => {
  return loadModelSettings();
});

ipcMain.handle(IPC.SETTINGS_GET_GENERAL, () => {
  return loadGeneralSettings();
});

ipcMain.handle(IPC.SETTINGS_GET_TIMEOUT_SETTINGS, () => {
  return getTimeoutSettings();
});

ipcMain.handle(IPC.SETTINGS_SAVE_TIMEOUT_SETTINGS, (_event, settings: Partial<TimeoutSettings>) => {
  return saveTimeoutSettings(settings);
});

ipcMain.handle(IPC.UI_THEME_GET, () => {
  return loadGeneralSettings().uiTheme;
});

ipcMain.handle(IPC.UI_THEME_RADIUS_GET, () => {
  return loadGeneralSettings().uiThemeRadius;
});

ipcMain.handle(IPC.UI_WINDOW_CORNER_RADIUS_GET, () => {
  return loadGeneralSettings().windowCornerRadius;
});

ipcMain.handle(IPC.UI_FONT_GET, () => {
  return loadGeneralSettings().uiFont;
});

function getUiFontsDir(): string {
  return path.join(app.getPath("userData"), "ui-fonts");
}

function getCustomFontDisplayName(filePath: string): string {
  return path.basename(filePath, path.extname(filePath)).replace(/[-_]+/g, " ").trim().slice(0, 80) || "自定义字体";
}

ipcMain.handle(IPC.SETTINGS_PICK_UI_FONT, async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "字体文件", extensions: ["ttf", "otf"] }],
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
});

ipcMain.handle(IPC.SETTINGS_IMPORT_UI_FONT, (_event, sourcePath: unknown) => {
  if (typeof sourcePath !== "string" || !sourcePath) throw new Error("未选择字体文件");
  const extension = path.extname(sourcePath).toLowerCase();
  if (extension !== ".ttf" && extension !== ".otf") throw new Error("仅支持 .ttf 或 .otf 字体文件");
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > 50 * 1024 * 1024) throw new Error("字体文件无效或超过 50 MB");

  const fileName = `custom-${randomUUID()}${extension}`;
  if (!isSupportedFontFileName(fileName)) throw new Error("字体文件名无效");
  const fontsDir = getUiFontsDir();
  fs.mkdirSync(fontsDir, { recursive: true });
  const targetPath = path.join(fontsDir, fileName);
  fs.copyFileSync(sourcePath, targetPath);

  const before = loadGeneralSettings().uiFont;
  const saved = saveGeneralSettings({ uiFont: { kind: "custom", fileName, displayName: getCustomFontDisplayName(sourcePath) } });
  if (before.kind === "custom" && before.fileName !== fileName) {
    const oldPath = path.join(fontsDir, before.fileName);
    if (isSupportedFontFileName(before.fileName)) fs.rmSync(oldPath, { force: true });
  }
  return saved.uiFont;
});

ipcMain.handle(IPC.SETTINGS_RESET_UI_FONT, () => {
  const before = loadGeneralSettings().uiFont;
  const saved = saveGeneralSettings({ uiFont: DEFAULT_UI_FONT });
  if (before.kind === "custom" && isSupportedFontFileName(before.fileName)) {
    fs.rmSync(path.join(getUiFontsDir(), before.fileName), { force: true });
  }
  return saved.uiFont;
});

ipcMain.handle(IPC.SETTINGS_SAVE_GENERAL, (_event, settings: Partial<GeneralSettings>) => {
  const saved = saveGeneralSettings(settings);
  if ("proactiveChatMode" in settings || "proactiveDeliveryTarget" in settings) {
    proactiveLifecycle.getProactiveChatService()?.invalidate();
  }
  return saved;
});

ipcMain.handle(IPC.SETTINGS_OPEN_CUSTOM_STYLE_PROMPT, async () => {
  const filePath = ensureCustomStylePrompt();
  await shell.showItemInFolder(filePath);
  return { ok: true, filePath };
});

ipcMain.on(IPC.SETTINGS_OPEN_SIDEBAR, () => {
  windowManager?.createSidebarWindow();
});

ipcMain.on(IPC.SETTINGS_CLOSE_SIDEBAR, () => {
  sidebarWindow?.close();
});

ipcMain.on(IPC.SETTINGS_OPEN_TASKS, () => {
  windowManager?.createTasksWindow();
});

ipcMain.on(IPC.SETTINGS_CLOSE_TASKS, () => {
  tasksWindow?.close();
});

ipcMain.on(IPC.SETTINGS_SET_PET_ALWAYS_ON_TOP, (_event, value: boolean) => {
  const saved = saveGeneralSettings({ ...loadGeneralSettings(), petAlwaysOnTop: Boolean(value) });
  windowManager?.setMainWindowAlwaysOnTop(saved.petAlwaysOnTop);
});

ipcMain.on(IPC.SETTINGS_SET_PET_VISIBLE, (_event, value: boolean) => {
  saveGeneralSettings({ ...loadGeneralSettings(), petVisible: Boolean(value) });
});

ipcMain.on(IPC.SETTINGS_SET_PET_ZOOM, (_event, value: number) => {
  const saved = saveGeneralSettings({ ...loadGeneralSettings(), petZoom: Number(value) });
  windowManager?.applyMainWindowZoom(saved.petZoom);
});

ipcMain.handle(IPC.MODEL_CONFIG_GET, () => {
  return getPublicModelConfig();
});

ipcMain.handle(IPC.RUNTIME_STATE_GET, () => {
  return runtimeStateService.getState();
});

ipcMain.handle(IPC.SETTINGS_SAVE_CONFIG, (_event, settings: Partial<ModelSettings>) => {
  const saved = saveModelSettings(settings);
  broadcastModelConfigChanged(saved);
  return saved;
});

ipcMain.handle(IPC.SETTINGS_TEST_CONNECTION, async (_event, cfg: VendorConfig) => testVendorConnection(cfg));

/**
 * 测试视觉模型连通性。
 * 用一张 32x32 纯红 PNG（约 100 字节 base64）做测试图——纯色位图所有视觉模型都能识别，
 * 比 SVG 兼容性好（SVG 是矢量，部分模型不支持）。
 * 32x32 是折中：足够小保持 payload 轻，又满足千问等厂商对图片长宽 > 10 像素的限制。
 * 验连通性（HTTP 2xx + 有内容返回）而非对答案——模型可能只说"一张红色图片"也算成功。
 */
const VISION_TEST_IMAGE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJ0lEQVR42u3NsQkAAAjAsP7/tF7hIASyp6lTCQQCgUAgEAgEgi/BAjLD/C5w/SM9AAAAAElFTkSuQmCC";

ipcMain.handle(IPC.SETTINGS_TEST_VISION, async (_event, cfg: { baseUrl: string; apiKey: string; model: string }) => {
  const start = Date.now();
  console.log("[Cyrene] test vision: model=" + cfg.model + " url=" + cfg.baseUrl);
  try {
    const { captionImage } = await import("./orchestrator/vision-captioner");
    const result = await captionImage(
      { base64: VISION_TEST_IMAGE_BASE64, mime: "image/png" },
      "这张图是什么颜色？用一个词回答。",
      { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model },
    );
    const latency = Date.now() - start;
    // 验连通性：返回不含 [错误 即成功（视觉模型返回了内容）
    if (result.startsWith("[错误")) {
      return { ok: false, latency, error: result };
    }
    return { ok: true, latency, sample: result.slice(0, 80) };
  } catch (e) {
    return { ok: false, latency: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
  }
});


ipcMain.handle(IPC.EMBEDDING_SET_MODEL, async (_event, modelKey: string) => {
  console.log("[Cyrene] embedding model switch requested:", modelKey);
  try {
    const result = await switchEmbeddingModel(modelKey);
    if (result.ok) {
      await reconcileUserMemoryIndex();
      saveModelSettings({ embeddingModel: modelKey as "minilm" | "bgem3" });
      broadcastModelConfigChanged();
      embeddingIndexService.invalidateStickerEmbeddingIndex();
      embeddingIndexService.refreshStickerEmbeddingIndex("embedding-model-switch");
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Cyrene] embedding model switch failed:", message);
    return { ok: false, clearedEntries: 0, error: message };
  }
});
ipcMain.handle(IPC.RERANKER_SET_MODE, async (_event, mode: "light" | "standard" | "none") => {
  const current = loadModelSettings();
  saveModelSettings({ ...current, rerankerMode: mode });
  await initReranker(mode);
  console.log("[Cyrene] reranker mode switched to", mode);
  return true;
});

ipcMain.handle(IPC.RERANKER_GET_STATUS, () => {
  return getRerankerInstallStatus();
});

ipcMain.handle(IPC.MODEL_GET_INSTALL_STATUS, () => {
  const { getModelInstallStatus } = require("./rag/model-status");
  return getModelInstallStatus();
});

ipcMain.handle(IPC.OPEN_EXTERNAL, async (_event, url: string) => {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return { ok: false, error: "Invalid URL" };
  }
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.on(IPC.SETTINGS_PREVIEW_RUNTIME_SYNC, (_event, value: "off" | "local" | "llm") => {
  const current = loadModelSettings();
  const preview = normalizeModelSettings({
    ...current,
    runtimeSync: value === "llm" ? "llm" : value === "local" ? "local" : "off",
  });
  broadcastModelConfigChanged(preview);
});

ipcMain.handle(IPC.SETTINGS_OPEN_STICKER_MANAGER, async () => {
  console.log("[stickers] open sticker manager requested");
  return windowManager?.createStickerManagerWindow();
});

ipcMain.on(IPC.STICKERS_MINIMIZE, () => {
  stickerManagerWindow?.minimize();
});

ipcMain.on(IPC.STICKERS_CLOSE, () => {
  stickerManagerWindow?.close();
});

ipcMain.handle(IPC.STICKERS_GET_CONFIG, () => {
  return getStickerManagerConfig();
});

ipcMain.handle(IPC.STICKERS_SET_ENABLED, (_event, payload: unknown) => {
  const record = payload as { id?: unknown; enabled?: unknown };
  const id = typeof record?.id === "string" ? record.id : null;
  if (!id) return getStickerManagerConfig();
  setStickerEnabled(id, Boolean(record.enabled));
  return getStickerManagerConfig();
});

ipcMain.handle(IPC.STICKERS_PICK_FILE, async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle(IPC.STICKERS_ADD, async (_event, payload: unknown) => {
  const { sourcePath, id, description, phrases } = payload as {
    sourcePath: string;
    id: string;
    description: string;
    phrases: string[];
  };
  try {
    await addUserSticker(sourcePath, id, description, phrases);
    embeddingIndexService.invalidateStickerEmbeddingIndex();
    embeddingIndexService.refreshStickerEmbeddingIndex("user-sticker-add");
  } catch (err) {
    console.error("[stickers] add failed:", err);
    throw err;
  }
  return getStickerManagerConfig();
});

ipcMain.handle(IPC.STICKERS_DELETE, async (_event, id: string) => {
  try {
    await deleteUserSticker(id);
    embeddingIndexService.invalidateStickerEmbeddingIndex();
    embeddingIndexService.refreshStickerEmbeddingIndex("user-sticker-delete");
  } catch (err) {
    console.error("[stickers] delete failed:", err);
    throw err;
  }
  return getStickerManagerConfig();
});

ipcMain.handle(IPC.STICKERS_GET_ENABLED, () => {
  return getStickerManagerConfig().filter((s) => s.enabled);
});


ipcMain.handle(IPC.EMBEDDING_GET_STATUS, async () => {
  const cacheDir = path.join(os.homedir(), ".cache", "huggingface");
  const models = {
    minilm: { dir: "Xenova\\all-MiniLM-L6-v2", onnx: "onnx\\model_quantized.onnx", name: "MiniLM" },
    bgem3: { dir: "Xenova\\bge-m3", onnx: "onnx\\model_quantized.onnx", name: "BGE-M3" },
  };
  const result: Record<string, { installed: boolean; sizeBytes: number }> = {};
  for (const [key, m] of Object.entries(models)) {
    const onnxPath = path.join(cacheDir, m.dir, m.onnx);
    const installed = fs.existsSync(onnxPath);
    let sizeBytes = 0;
    if (installed) {
      try { sizeBytes = fs.statSync(onnxPath).size; } catch {}
    }
    result[key] = { installed, sizeBytes };
  }
  return result;
});


ipcMain.handle(IPC.EMBEDDING_DOWNLOAD, async (_event, payload: unknown) => {
  const p = payload as { model?: string; mirror?: string };
  const model = p.model || "minilm";
  const mirror = p.mirror || "official";
  try {
    const win = BrowserWindow.getFocusedWindow();
    await downloadEmbeddingModel(model, mirror, (info) => {
      win?.webContents.send(IPC.EMBEDDING_PROGRESS, info);
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
});

ipcMain.handle(IPC.USER_GET_AVATAR, () => {
  const avatarPath = getAvatarPath();
  if (!fs.existsSync(avatarPath)) return null;
  const buf = fs.readFileSync(avatarPath);
  const ext = path.extname(avatarPath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  return "data:" + mime + ";base64," + buf.toString("base64");
});

ipcMain.handle(IPC.MEMORY_PANEL_GET_DATA, () => loadMemoryPanelData());
ipcMain.handle(IPC.MEMORY_PANEL_DELETE_IMPORTED_DOC, (_event, payload: { importId: string; fileName?: string }) => {
  const deleted = deleteImportedDoc(payload.importId, payload.fileName);
  return { ok: true, deleted };
});
// L0/L1 editable fields whitelist
const L0_EDITABLE_KEYS = ["preferredName", "occupation", "longTermInterests", "language", "permanentNote"];
const L1_EDITABLE_KEYS = ["recentGoals", "recentPreferences", "currentProject"];

ipcMain.handle(IPC.MEMORY_PANEL_SAVE_L0, async (_event, raw: Record<string, unknown>) => {
  const patch: Partial<L0Profile> = {};
  for (const key of L0_EDITABLE_KEYS) {
    if (key in raw && typeof raw[key] === "string") {
      (patch as Record<string, unknown>)[key] = (raw[key] as string).trim();
    }
  }
  await memoryStore.updateL0(patch);
  return { ok: true };
});

ipcMain.handle(IPC.MEMORY_PANEL_SAVE_L1, async (_event, raw: Record<string, unknown>) => {
  const patch: Partial<L1Profile> = {};
  for (const key of L1_EDITABLE_KEYS) {
    if (key in raw && typeof raw[key] === "string") {
      (patch as Record<string, unknown>)[key] = (raw[key] as string).trim();
    }
  }
  await memoryStore.updateL1(patch);
  return { ok: true };
});
ipcMain.handle(IPC.USER_GET_PROFILE, () => loadUserProfile());
ipcMain.handle(IPC.USER_SAVE_PROFILE, (_event, profile: Partial<UserProfile>) => {
  const saved = saveUserProfile(profile);
  broadcastToAuxWindows(IPC.USER_PROFILE_CHANGED, saved);
  return saved;
});
ipcMain.handle(IPC.USER_UPLOAD_AVATAR, async () => {
  const { dialog } = await import("electron");
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const srcPath = result.filePaths[0];
  const avatarPath = getAvatarPath();
  fs.mkdirSync(path.dirname(avatarPath), { recursive: true });
  fs.copyFileSync(srcPath, avatarPath);
  const profile = saveUserProfile({ avatarPath });
  broadcastToAuxWindows(IPC.USER_AVATAR_CHANGED, null);
  return { avatarPath, profile };
});

ipcMain.handle(IPC.MCP_ADD_SERVER, async (_event, config: unknown) => {
  console.log('[MCP IPC] add-server:', JSON.stringify(config).slice(0, 200));
  const result = await addMcpServer(config as Parameters<typeof addMcpServer>[0]);
  console.log('[MCP IPC] add-server result:', JSON.stringify(result));
  return result;
});

ipcMain.handle(IPC.MCP_REMOVE_SERVER, async (_event, serverId: string) => {
  console.log('[MCP IPC] remove-server:', serverId);
  const result = await removeMcpServer(serverId);
  console.log('[MCP IPC] remove-server result:', JSON.stringify(result));
  return result;
});

ipcMain.handle(IPC.MCP_LIST_SERVERS, () => {
  const servers = listMcpServers();
  console.log('[MCP IPC] list-servers:', servers.length + ' servers');
  return servers;
});

ipcMain.handle(IPC.TOOL_SET_ENABLED, (_event, payload: unknown) => {
  const p = payload as { id?: string; enabled?: boolean };
  if (!p.id) return { ok: false, error: 'missing tool id' };
  toolRegistry.setEnabled(p.id, p.enabled !== false);
  console.log('[Tool] ' + p.id + ' enabled=' + (p.enabled !== false));
  return { ok: true };
});

ipcMain.handle(IPC.TOOL_GET_ENABLED, () => {
  const tools = toolRegistry.getAllTools();
  const result: Record<string, boolean> = {};
  for (const t of tools) {
    result[t.id] = t.enabled;
  }
  return result;
});

ipcMain.handle(IPC.SKILL_LIST, () => {
  return listSkillsForUi();
});

ipcMain.handle(IPC.SKILL_SET_ENABLED, (_event, payload: unknown) => {
  const p = payload as { id?: string; enabled?: boolean };
  if (!p.id) return { ok: false, error: "missing skill id" };
  setSkillEnabled(p.id, p.enabled !== false);
  console.log("[Skill] " + p.id + " enabled=" + (p.enabled !== false));
  return { ok: true };
});

ipcMain.handle(IPC.EMBEDDING_DELETE, async (_event, payload: unknown) => {
  const p = payload as { model?: string };
  const model = p.model || "minilm";
  try {
    deleteEmbeddingModel(model);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
});

ipcMain.on(IPC.SETTINGS_OPEN_CHROME_GPU, async () => {
  const win = new BrowserWindow({ width: 1024, height: 768 });
  win.loadURL("chrome://gpu");
  win.show();
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

  onGeneralSettingsChanged(handleGeneralSettingsChanged);

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
  // Token 用量查询 IPC
  ipcMain.handle(IPC.TOKEN_USAGE_GET, (_event, days: number) => {
    return getUsage(Math.max(1, Math.min(90, Number(days) || 7)));
  });

  ipcMain.on(IPC.LIVE2D_SPEECH_PREPARE, () => {
    windowManager?.sendToMainWindow(IPC.LIVE2D_SPEECH_PREPARE);
  });
  ipcMain.on(IPC.LIVE2D_MOUTH_START, (_event, payload: { durationMs?: number }) => {
    windowManager?.sendToMainWindow(IPC.LIVE2D_MOUTH_START, { durationMs: Number(payload?.durationMs ?? 0) });
  });
  ipcMain.on(IPC.LIVE2D_MOUTH_STOP, () => {
    windowManager?.sendToMainWindow(IPC.LIVE2D_MOUTH_STOP);
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
  ipcMain.handle(IPC.CHATS_OPEN_IN_REACT_WINDOW, (_event, sessionId: string) => {
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      return false;
    }
    windowManager?.createReactChatWindow(sessionId);
    return true;
  });
  // reactChatWindow → main：声明 ChatPage 已挂好 IPC 监听
  ipcMain.on(IPC.CHATS_REACT_READY, (event) => {
    const win = reactChatWindow;
    if (!win || win.isDestroyed()) return;
    if (event.sender !== win.webContents) return;
    const pending = reactChatSession.markReady();
    if (pending) {
      win.webContents.send(IPC.CHATS_REACT_SWITCH_SESSION, pending);
    }
  });
  // 聊天窗口启动/切换会话时上报当前活跃 sessionId；main 广播给所有窗口
  // 用途：设置面板"删除当前会话"时差异化提示文案
  ipcMain.handle(IPC.CHATS_SET_ACTIVE_SESSION, (_event, sessionId: string | null) => {
    activeChatSessionId = sessionId ?? null;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try { win.webContents.send(IPC.CHATS_ACTIVE_SESSION_CHANGED, activeChatSessionId); } catch { /* ignore */ }
    }
    return true;
  });
  ipcMain.handle(IPC.CHATS_GET_ACTIVE_SESSION, () => activeChatSessionId);
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







