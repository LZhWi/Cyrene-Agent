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
import { indexConversationTurn } from "./orchestrator/history-tools";
import { createLlmClient, type LlmClient } from "./services/llm/llm-client";

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

import { toolRegistry, type ToolDefinition } from "./orchestrator/tool-registry";
import type { ToolRiskLevel } from "./permission";
import { loadChannelsSettings } from "./channels/settings-store";
import { channelManager } from "./channels/manager";
import { canStartProactiveChannelDelivery, sendProactiveChannelMessage } from "./channels/proactive-delivery";
// 触发 built-in-tools 的副作用注册（fetch_url / run_shell / install_mcp_server）
import { setLive2dWindowSender } from "./orchestrator/built-in-tools";
import "./orchestrator/built-in-tools";
// 触发 fs-tools 的副作用注册（read_file / list_dir / write_file / read_image）
import "./orchestrator/fs-tools";
// 触发 search-code-tools 的副作用注册（search_code）
import "./orchestrator/search-code-tools";
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

import {
  buildSocialExtractionPrompt,
  SOCIAL_EXTRACTION_SCHEMA,
} from "./social-context/extractor";
import { createSocialContextScheduler } from "./social-context/scheduler";
import { createSocialAtomStore } from "./social-context/store";
import { getEmbeddingStatus, downloadEmbeddingModel, deleteEmbeddingModel } from "./embedding-manager";
import { BUILT_IN_STICKER_DESCRIPTIONS } from "./sticker-descriptions";
import { buildCachedStickerEmbeddingIndex } from "./sticker-embedding-cache";
import type { StickerEmbeddingEntry } from "./sticker-embedder";
import { buildCachedSceneIndex } from "./scene-embedding-cache";
import type { SceneIndex } from "./scene-embedder";
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
import { uploadFile as ttsUploadFile, cloneVoice as ttsCloneVoice, synthesize as ttsSynthesize } from "./tts/minimax-engine";
import { synthesize as gptsovitsSynthesize } from "./tts/gptsovits-engine";
import { synthesize as customCloudSynthesize } from "./tts/custom-cloud-engine";
import { synthesize as mimoSynthesize } from "./tts/mimo-engine";
import { synthesize as mosslandSynthesize, cloneVoice as mosslandCloneVoice, listVoices as mosslandListVoices } from "./tts/mossland-engine";
import { synthesizeByEngine } from "./tts/tts-dispatcher";
import { TtsSessionService, type TtsSessionExecution } from "./tts/tts-session-service";
import { versionTtsCacheKey } from "./tts/tts-cache-key";
import {
  appendCustomCloudTtsLog,
  appendGptsovitsTtsLog,
  appendMinimaxTtsLog,
  appendMimoTtsLog,
  assertTtsCacheKey,
  buildCustomCloudCacheKey,
  buildGptsovitsCacheKey,
  buildMimoCacheKey,
  buildMosslandCacheKey,
  buildTtsCacheKey,
  getTtsCachePath,
  readTtsCacheByKey,
} from "./tts/tts-cache";
import { runTtsStreamingWithFallback } from "./tts/tts-streaming-fallback";
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
import { loadPromptFile } from "./prompts/prompt-loader";
import { bootstrapConfigGetters } from "./startup/bootstrap-config";
import { loadMemoryPanelData } from "./memory/panel";
import { type RuntimeState } from "./runtime-state";
import { getAppIconPath } from "./app-icon";
import { ensureCustomStylePrompt } from "./style-prompt";
import type { StartTtsRequest, TtsAudioFormat, TtsSessionEvent, TtsStartResult } from "../shared/tts-session";
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
import { registerRecallHistoryTool } from "./orchestrator/history-tools";
import { registerDocumentTools } from "./orchestrator/document-tools";
import { registerLifeTools, setTranslateConfig } from "./orchestrator/life-tools";
import { registerTravelTools, setTravelConfig } from "./orchestrator/travel-tools";
import { registerEmailTools, setEmailConfig } from "./orchestrator/email-tools";
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
import { initChannels, shutdownChannels, setChannelsConversationLifecycle } from "./channels/init";
import { buildChannelAttachmentInputs } from "./channels/agent-input";
import { setDispatcherBuildAndRunAgent, setDispatcherSynthesizeTts, setDispatcherBroadcastChat, setDispatcherLoadGeneralSettings, setDispatcherLoadRecentHistory } from "./channels/dispatcher";
import { createWindowLifecycleTracker } from "./electron-window-lifecycle";
import { getSchedulerStore } from "./scheduler/scheduler-store";
import { SchedulerEngine } from "./scheduler/scheduler-engine";
import { createSchedulerRunner } from "./scheduler/scheduler-runner";
import { registerSchedulerIpc } from "./scheduler/scheduler-ipc";
import type { ScheduledTask } from "./scheduler/types";
import { createAgentRuntime, type AgentRuntime } from "./orchestrator/agent-runtime";
import { createRuntimeStateService } from "./orchestrator/runtime-state-service";
import {
  getStickerManagerConfig,
  loadStickerSettings,
  saveStickerSettings,
  setStickerEnabled,
} from "./orchestrator/sticker-settings";
import { createProactiveLifecycle } from "./proactive/proactive-lifecycle";
import { normalizeCitaSettings } from "./cita/settings";
import { CitaService, ContextStore, RemoteSemanticEngine } from "./cita";
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
let schedulerEngine: SchedulerEngine | null = null;
let screenshotService: ScreenshotService | null = null;
let windowManager: WindowManager | null = null;
const live2dWindowLifecycle = createWindowLifecycleTracker<BrowserWindow>("live2d-main", {
  onClosed: () => { /* no-op：原 setLive2dWindow 已随 opener 子系统一起移除 */ },
});

// 聊天窗口当前活跃的会话 id（通过 IPC 由聊天窗口上报）；
// 设置面板"删除当前会话"差异化提示用。聊天窗口关闭时由 closed 事件置 null。
let activeChatSessionId: string | null = null;

const DEFAULT_CHAT_REQUEST_TIMEOUT_MS = 300000; // FC 总预算：20 轮 × 推理模型 ~10-15s 需 300s 余量

const STARTUP_EMBEDDING_REFRESH_DELAY_MS = 1500;

const runtimeStateService = createRuntimeStateService();
runtimeStateService.onChange(() => broadcastRuntimeStateChanged());
const llmClient = createLlmClient();
let stickerEmbeddingIndex: StickerEmbeddingEntry[] | null = null;
let stickerEmbeddingRefreshSeq = 0;
let sceneEmbeddingIndex: SceneIndex | null = null;
let sceneEmbeddingRefreshSeq = 0;

function refreshStickerEmbeddingIndexInBackground(reason: string): void {
  const seq = ++stickerEmbeddingRefreshSeq;
  void (async () => {
    try {
      const provider = getEmbeddingProvider();
      if (!provider) {
        if (seq === stickerEmbeddingRefreshSeq) stickerEmbeddingIndex = null;
        console.warn("[StickerEmbedding] Model not found. Sticker matching disabled.");
        return;
      }

      const index = await buildCachedStickerEmbeddingIndex(
        provider,
        BUILT_IN_STICKER_DESCRIPTIONS,
        loadUserStickerManifest(),
      );
      if (seq !== stickerEmbeddingRefreshSeq) return;
      stickerEmbeddingIndex = index;
      logger.info(LogTag.StickerEmbed, `index ready (${reason}): ${index.length} entries`);
    } catch (err) {
      if (seq === stickerEmbeddingRefreshSeq) stickerEmbeddingIndex = null;
      console.error("[StickerEmbedding] refresh failed:", err instanceof Error ? err.message : String(err));
    }
  })();
}

function refreshSceneEmbeddingIndexInBackground(reason: string): void {
  const seq = ++sceneEmbeddingRefreshSeq;
  void (async () => {
    try {
      const sceneProvider = getSceneEmbeddingProvider();
      if (!sceneProvider) {
        if (seq === sceneEmbeddingRefreshSeq) sceneEmbeddingIndex = null;
        console.warn("[SceneEmbedding] bge-m3 model not found. Scene embedding disabled.");
        return;
      }

      const index = await buildCachedSceneIndex(sceneProvider);
      if (seq !== sceneEmbeddingRefreshSeq) return;
      sceneEmbeddingIndex = index;
      logger.info(LogTag.SceneEmbed, "index ready:", Object.keys(index.scenes).length, "scenes", `(${reason})`);
    } catch (err) {
      if (seq === sceneEmbeddingRefreshSeq) sceneEmbeddingIndex = null;
      console.error("[SceneEmbedding] refresh failed:", err instanceof Error ? err.message : String(err));
    }
  })();
}

function scheduleStartupEmbeddingRefreshes(): void {
  setTimeout(() => {
    refreshStickerEmbeddingIndexInBackground("startup");
    refreshSceneEmbeddingIndexInBackground("startup");
  }, STARTUP_EMBEDDING_REFRESH_DELAY_MS);
}

const proactiveLifecycle = createProactiveLifecycle({ loadGeneralSettings });

async function synthesizeTtsSession(
  request: StartTtsRequest,
  signal: AbortSignal,
  emit: (event: TtsSessionEvent) => void,
): Promise<TtsStartResult | TtsSessionExecution> {
  const settings = loadGeneralSettings();
  if (request.automatic && !settings.ttsAutoRead) return { requestId: request.requestId, status: "skipped" };

  const historicalMessage = chatsStore.getSession(request.conversationId)?.messages
    .find((message) => message.id === request.messageId && message.role === "model");
  if (historicalMessage?.ttsCacheKey && historicalMessage.ttsCacheVersion === request.converterVersion) {
    const cached = readTtsCacheByKey(historicalMessage.ttsCacheKey);
    if (cached) {
      return {
        requestId: request.requestId,
        status: "ready",
        base64: cached.audio.toString("base64"),
        cacheKey: historicalMessage.ttsCacheKey,
        format: cached.format,
        cached: true,
      };
    }
  }

  if (settings.ttsEngine === "off") {
    if (request.automatic) return { requestId: request.requestId, status: "skipped" };
    throw new Error("请先在设置中启用 TTS 引擎");
  }
  if (signal.aborted) return { requestId: request.requestId, status: "cancelled" };

  let audio: Buffer;
  let format: TtsAudioFormat;
  let cacheKey: string;
  if (settings.ttsEngine === "minimax") {
    if (!settings.ttsMinimaxKey || !settings.ttsMinimaxVoiceId) throw new Error("MiniMax TTS 配置不完整");
    format = "mp3";
    const payload = {
      apiKey: settings.ttsMinimaxKey, voiceId: settings.ttsMinimaxVoiceId, text: request.speechText,
      speed: settings.ttsSpeed, volume: settings.ttsVolume, model: settings.ttsMinimaxModel, format,
      vocalEnhance: { enabled: settings.ttsMinimaxVocalEnhance },
    };
    cacheKey = buildTtsCacheKey(payload);
    if (settings.ttsStreaming) {
      cacheKey = versionTtsCacheKey(cacheKey, request.converterVersion);
      const cachePath = getTtsCachePath(cacheKey, format);
      const persist = (buffer: Buffer) => {
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, buffer);
        appendMinimaxTtsLog({
          requestId: request.requestId,
          ts: new Date().toISOString(),
          phase: "session.stream.cache.write",
          cacheKey,
          audioBytes: buffer.length,
        });
      };
      const completion = runTtsStreamingWithFallback({
        requestId: request.requestId,
        cacheKey,
        format,
        signal,
        stream: (onChunk) => ttsSynthesize({
          ...payload,
          signal,
          onChunk,
          debugLog: appendMinimaxTtsLog,
        }),
        fallback: () => ttsSynthesize({
          ...payload,
          signal,
          debugLog: appendMinimaxTtsLog,
        }),
        persist,
        emit,
      });
      return {
        result: { requestId: request.requestId, status: "streaming", cacheKey, format },
        completion,
      };
    }
    audio = await ttsSynthesize({ ...payload, signal, debugLog: appendMinimaxTtsLog });
  } else if (settings.ttsEngine === "gptsovits") {
    if (!settings.ttsGptsovitsBaseUrl || !settings.ttsGptsovitsRefAudioPath || !settings.ttsGptsovitsPromptText) {
      throw new Error("GPT-SoVITS TTS 配置不完整");
    }
    format = settings.ttsGptsovitsFormat;
    const payload = {
      baseUrl: settings.ttsGptsovitsBaseUrl, refAudioPath: settings.ttsGptsovitsRefAudioPath,
      promptText: settings.ttsGptsovitsPromptText, text: request.speechText, speed: settings.ttsSpeed, format,
      timeoutMs: settings.ttsGptsovitsTimeoutMs,
    };
    cacheKey = buildGptsovitsCacheKey(payload);
    audio = (await gptsovitsSynthesize({ ...payload, debugLog: appendGptsovitsTtsLog })).audio;
  } else if (settings.ttsEngine === "custom-cloud") {
    if (!settings.ttsCustomCloudEndpointUrl) throw new Error("自定义云端 TTS 配置不完整");
    format = settings.ttsCustomCloudFormat;
    const payload = {
      endpointUrl: settings.ttsCustomCloudEndpointUrl, apiKey: settings.ttsCustomCloudApiKey,
      voiceId: settings.ttsCustomCloudVoiceId, text: request.speechText, speed: settings.ttsSpeed,
      volume: settings.ttsVolume, format, timeoutMs: settings.ttsCustomCloudTimeoutMs,
    };
    cacheKey = buildCustomCloudCacheKey(payload);
    audio = (await customCloudSynthesize({ ...payload, debugLog: appendCustomCloudTtsLog })).audio;
  } else if (settings.ttsEngine === "mimo") {
    if (!settings.ttsMimoKey || !settings.ttsMimoVoiceAudioPath) throw new Error("MiMo TTS 配置不完整");
    format = "wav";
    const payload = {
      apiKey: settings.ttsMimoKey, voiceAudioPath: settings.ttsMimoVoiceAudioPath,
      text: request.speechText, stylePrompt: settings.ttsMimoStylePrompt,
    };
    cacheKey = buildMimoCacheKey(payload);
    audio = (await mimoSynthesize({ ...payload, debugLog: appendMimoTtsLog })).audio;
  } else {
    if (!settings.ttsMosslandKey || !settings.ttsMosslandVoiceId) throw new Error("Mossland TTS 配置不完整");
    format = "mp3";
    const payload = {
      apiKey: settings.ttsMosslandKey, voiceId: settings.ttsMosslandVoiceId, text: request.speechText,
      speed: settings.ttsSpeed, volume: settings.ttsVolume, model: settings.ttsMosslandModel, format,
    };
    cacheKey = buildMosslandCacheKey(payload);
    audio = (await mosslandSynthesize(payload)).audio;
  }

  cacheKey = versionTtsCacheKey(cacheKey, request.converterVersion);
  const cachePath = getTtsCachePath(cacheKey, format);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, audio);
  return {
    requestId: request.requestId,
    status: "ready",
    base64: audio.toString("base64"),
    cacheKey,
    format,
    cached: false,
  };
}

const ttsSessionService = new TtsSessionService(synthesizeTtsSession);

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

function syncBuiltInToolToggles(settings: GeneralSettings): void {
  toolRegistry.setEnabled("weather", settings.weatherEnabled);
  toolRegistry.setEnabled("plan_trip", settings.travelEnabled);
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

const citaService = new CitaService({
  store: new ContextStore(),
  engine: new RemoteSemanticEngine(
    async (request, signal) => {
      const settings = loadModelSettings();
      // Kimi k2.6 只允许特定 temperature（0.6），传 0 会被拒。
      // 省略让服务端用默认值，其他模型继续 temperature=0 保证确定性。
      const citaTemp = settings.model.match(/^kimi-k2\.6(?:$|-)/i) ? undefined : 0;
      return llmClient.chatNonStream(
        settings,
        [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: request.userPrompt },
        ],
        citaTemp,
        6_000,
        "CITA understandTurn",
        { mode: "off" as const },
        {
          structuredOutput: request.structuredOutput,
          maxTokens: request.maxTokens,
          extraBody: request.extraBody,
        },
        signal,
      );
    },
    {
      timeoutMs: 8_000,
      systemPrompt: loadPromptFile("cita_system.md"),
      getProfile: () => {
        const settings = loadModelSettings();
        const cfg: VendorConfig = {
          provider: settings.provider,
          baseUrl: settings.baseUrl,
          model: settings.model,
          apiKey: settings.apiKey,
          explicitTransport: settings.explicitTransport,
          reasoning: { mode: "off" },
        };
        const adapter = getAdapterForConfig(cfg);
        return resolveStructuredOutputProfile({
          provider: adapter.id,
          model: cfg.model,
          transport: adapter.transport,
          endpointKind: classifyStructuredOutputEndpoint({
            providerId: adapter.id,
            configuredBaseUrl: cfg.baseUrl,
            officialBaseUrl: adapter.capability.baseUrl,
          }),
        });
      },
    },
  ),
  getSettings: () => normalizeCitaSettings({
    enabled: loadGeneralSettings().citaEnabled,
    semanticEngine: loadGeneralSettings().citaSemanticEngine,
  }),
});

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
    sceneEmbeddingIndex,
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
      stickerEmbeddingIndex = null;
      refreshStickerEmbeddingIndexInBackground("embedding-model-switch");
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
    stickerEmbeddingIndex = null;
    refreshStickerEmbeddingIndexInBackground("user-sticker-add");
  } catch (err) {
    console.error("[stickers] add failed:", err);
    throw err;
  }
  return getStickerManagerConfig();
});

ipcMain.handle(IPC.STICKERS_DELETE, async (_event, id: string) => {
  try {
    await deleteUserSticker(id);
    stickerEmbeddingIndex = null;
    refreshStickerEmbeddingIndexInBackground("user-sticker-delete");
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
  ipcMain.handle(IPC.TTS_SESSION_START, async (event, request: StartTtsRequest) => {
    if (
      !request?.requestId
      || !request.conversationId
      || !request.messageId
      || !request.speechText.trim()
      || !/^[a-z\d][a-z\d._-]{0,63}$/i.test(request.converterVersion)
    ) {
      throw new Error("TTS 会话请求不完整");
    }
    const sender = event.sender;
    return await ttsSessionService.start(request, (sessionEvent) => {
      if (!sender.isDestroyed()) sender.send(IPC.TTS_SESSION_EVENT, sessionEvent);
    });
  });
  ipcMain.handle(IPC.TTS_SESSION_CANCEL, (_event, requestId: string) => {
    return typeof requestId === "string" && requestId.length > 0
      ? ttsSessionService.cancel(requestId)
      : false;
  });

  // 上传音频文件 → file_id
  ipcMain.handle(IPC.TTS_UPLOAD, async (_event, payload: { apiKey: string; filePath: string; purpose: "voice_clone" | "prompt_audio" }) => {
    if (!payload?.apiKey || !payload?.filePath) {
      throw new Error("缺少 API Key 或文件路径");
    }
    return await ttsUploadFile(payload.apiKey, payload.filePath, payload.purpose);
  });

  // 选择音频文件（Electron dialog）
  ipcMain.handle(IPC.TTS_PICK_AUDIO, async () => {
    const result = await dialog.showOpenDialog({
      title: "选择音频文件",
      filters: [{ name: "音频文件", extensions: ["mp3", "m4a", "wav"] }],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // 音色快速复刻 → voice_id
  ipcMain.handle(IPC.TTS_CLONE, async (_event, payload: {
    apiKey: string; fileId: string; voiceId: string;
    promptAudioId?: string; promptText?: string;
    text: string; model?: string;
  }) => {
    if (!payload?.apiKey || !payload?.fileId || !payload?.voiceId || !payload?.text) {
      throw new Error("缺少必要参数（apiKey/fileId/voiceId/text）");
    }
    return await ttsCloneVoice(payload);
  });

  // 语音合成 → base64 音频（聊天朗读 / 测试发音都用这个）
  ipcMain.handle(IPC.TTS_SYNTHESIZE, async (_event, payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; pitch?: number;
    model?: string; format?: "mp3" | "wav" | "pcm";
    vocalEnhance?: { enabled: boolean };
  }) => {
    if (!payload?.apiKey || !payload?.voiceId || !payload?.text) {
      throw new Error("缺少必要参数（apiKey/voiceId/text）");
    }
    const audioBuffer = await ttsSynthesize({
      ...payload,
      debugLog: appendMinimaxTtsLog,
    });
    // Buffer → base64 传给渲染进程（渲染进程用 atob 解码再播）
    return audioBuffer.toString("base64");
  });

  ipcMain.handle(IPC.TTS_SYNTHESIZE_CACHED, async (_event, payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; pitch?: number;
    model?: string; format?: "mp3" | "wav" | "pcm";
    expectedCacheKey?: string;
  }) => {
    const format = payload.format ?? "mp3";

    // 回听优先：如果 expectedCacheKey 对应的缓存文件存在，直接返回，不需要 apiKey/voiceId。
    let expectedPath: string | null = null;
    if (payload.expectedCacheKey) {
      try {
        expectedPath = getTtsCachePath(payload.expectedCacheKey, format);
      } catch { /* expectedCacheKey 格式非法，忽略 */ }
    }
    if (expectedPath && fs.existsSync(expectedPath)) {
      const cachedBuffer = fs.readFileSync(expectedPath);
      appendMinimaxTtsLog({
        requestId: `tts-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: new Date().toISOString(),
        phase: "cache.hit",
        cacheKey: payload.expectedCacheKey,
        audioBytes: cachedBuffer.length,
        textChars: Array.from(payload.text).length,
      });
      return {
        base64: cachedBuffer.toString("base64"),
        cacheKey: payload.expectedCacheKey,
        cached: true,
      };
    }

    // 缓存未命中 → 需要合成，检查 apiKey/voiceId
    if (!payload?.apiKey || !payload?.voiceId || !payload?.text || payload.apiKey === "cache-only") {
      throw new Error("缓存未命中且缺少必要参数（apiKey/voiceId/text）");
    }

    const cacheKey = buildTtsCacheKey(payload);
    const audioPath = getTtsCachePath(cacheKey, format);
    fs.mkdirSync(path.dirname(audioPath), { recursive: true });

    const audioBuffer = await ttsSynthesize({
      ...payload,
      format,
      debugLog: appendMinimaxTtsLog,
    });
    fs.writeFileSync(audioPath, audioBuffer);
    appendMinimaxTtsLog({
      requestId: `tts-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      phase: "cache.write",
      cacheKey,
      audioBytes: audioBuffer.length,
      textChars: Array.from(payload.text).length,
    });
    return {
      base64: audioBuffer.toString("base64"),
      cacheKey,
      cached: false,
    };
  });

  // 流式语音合成（minimax WS 边合成边推 chunk 给渲染端播）
  // 主进程同时攒完整 buffer 落盘缓存，下次同文本走缓存
  ipcMain.handle(IPC.TTS_STREAM_START, async (event, payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; pitch?: number;
    model?: string; format?: "mp3" | "wav" | "pcm";
    vocalEnhance?: { enabled: boolean };
    expectedCacheKey?: string;
  }) => {
    const format = payload.format ?? "mp3";
    const sender = event.sender;

    // 回听优先：expectedCacheKey 命中缓存直接发完整 base64（走 STREAM_END，不走 chunk）
    let expectedPath: string | null = null;
    if (payload.expectedCacheKey) {
      try { expectedPath = getTtsCachePath(payload.expectedCacheKey, format); } catch { /* */ }
    }
    if (expectedPath && fs.existsSync(expectedPath)) {
      const cachedBuf = fs.readFileSync(expectedPath);
      appendMinimaxTtsLog({
        requestId: `tts-stream-cache-${Date.now()}`,
        ts: new Date().toISOString(),
        phase: "stream.cache.hit",
        cacheKey: payload.expectedCacheKey,
        audioBytes: cachedBuf.length,
      });
      // 缓存命中：一次性发完整音频（渲染端会按 STREAM_END 处理，直接播完整 buffer）
      sender.send(IPC.TTS_AUDIO_CHUNK, { base64: cachedBuf.toString("base64") });
      sender.send(IPC.TTS_STREAM_END, { cacheKey: payload.expectedCacheKey, cached: true, format });
      return { started: false, cacheKey: payload.expectedCacheKey, cached: true };
    }

    if (!payload?.apiKey || !payload?.voiceId || !payload?.text) {
      throw new Error("流式合成缺少必要参数（apiKey/voiceId/text）");
    }

    const cacheKey = buildTtsCacheKey(payload);
    const audioPath = getTtsCachePath(cacheKey, format);
    fs.mkdirSync(path.dirname(audioPath), { recursive: true });
    const fullChunks: Buffer[] = [];

    // 异步合成，不 await（handler 立即返回，chunk 通过 send 推送）
    void (async () => {
      try {
        const audioBuffer = await ttsSynthesize({
          apiKey: payload.apiKey,
          voiceId: payload.voiceId,
          text: payload.text,
          speed: payload.speed,
          volume: payload.volume,
          pitch: payload.pitch,
          model: payload.model,
          format,
          vocalEnhance: payload.vocalEnhance,
          debugLog: appendMinimaxTtsLog,
          onChunk: (chunkBase64) => {
            fullChunks.push(Buffer.from(chunkBase64, "base64"));
            if (!sender.isDestroyed()) sender.send(IPC.TTS_AUDIO_CHUNK, { base64: chunkBase64 });
          },
        });
        // 落盘缓存（用完整 buffer，不用拼接的 fullChunks——synthesize 返回的更可靠）
        fs.writeFileSync(audioPath, audioBuffer);
        appendMinimaxTtsLog({
          requestId: `tts-stream-${Date.now()}`,
          ts: new Date().toISOString(),
          phase: "stream.cache.write",
          cacheKey,
          audioBytes: audioBuffer.length,
        });
        if (!sender.isDestroyed()) sender.send(IPC.TTS_STREAM_END, { cacheKey, cached: false, format });
      } catch (err) {
        if (!sender.isDestroyed()) {
          sender.send(IPC.TTS_STREAM_ERROR, { message: err instanceof Error ? err.message : String(err) });
        }
      }
    })();

    return { started: true, cacheKey, cached: false };
  });

  // GPT-SoVITS 语音合成 → base64 音频（测试发音用，不缓存）
  ipcMain.handle(IPC.TTS_SYNTHESIZE_GPTSOVITS, async (_event, payload: {
    baseUrl: string; refAudioPath: string; promptText: string; text: string;
    speed?: number; format?: "wav" | "mp3";
  }) => {
    if (!payload?.baseUrl || !payload?.refAudioPath || !payload?.promptText || !payload?.text) {
      throw new Error("缺少必要参数（baseUrl/refAudioPath/promptText/text）");
    }
    const result = await gptsovitsSynthesize({
      ...payload,
      debugLog: appendGptsovitsTtsLog,
    });
    const cacheKey = buildGptsovitsCacheKey(payload);
    return {
      base64: result.audio.toString("base64"),
      cacheKey,
      cached: false,
      format: result.format,
    };
  });

  // GPT-SoVITS 语音合成 + 本地缓存（聊天朗读用）
  ipcMain.handle(IPC.TTS_SYNTHESIZE_CACHED_GPTSOVITS, async (_event, payload: {
    baseUrl: string; refAudioPath: string; promptText: string; text: string;
    speed?: number; format?: "wav" | "mp3";
    expectedCacheKey?: string;
  }) => {
    const format: "wav" | "mp3" = payload.format ?? "wav";

    // 回听优先：如果 expectedCacheKey 对应的缓存文件存在，直接返回，不需要 baseUrl/refAudioPath。
    let expectedPath: string | null = null;
    if (payload.expectedCacheKey) {
      try {
        expectedPath = getTtsCachePath(payload.expectedCacheKey, format);
      } catch { /* expectedCacheKey 格式非法，忽略 */ }
    }
    if (expectedPath && fs.existsSync(expectedPath)) {
      const cachedBuffer = fs.readFileSync(expectedPath);
      appendGptsovitsTtsLog({
        requestId: `gptsovits-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: new Date().toISOString(),
        phase: "cache.hit",
        cacheKey: payload.expectedCacheKey,
        audioBytes: cachedBuffer.length,
        textChars: Array.from(payload.text).length,
      });
      return {
        base64: cachedBuffer.toString("base64"),
        cacheKey: payload.expectedCacheKey,
        cached: true,
        format,
      };
    }

    // 缓存未命中 → 需要合成，检查必要参数
    if (!payload?.baseUrl || !payload?.refAudioPath || !payload?.promptText || !payload?.text) {
      throw new Error("缓存未命中且缺少必要参数（baseUrl/refAudioPath/promptText/text）");
    }

    const cacheKey = buildGptsovitsCacheKey(payload);
    const audioPath = getTtsCachePath(cacheKey, format);
    fs.mkdirSync(path.dirname(audioPath), { recursive: true });

    const result = await gptsovitsSynthesize({
      baseUrl: payload.baseUrl,
      refAudioPath: payload.refAudioPath,
      promptText: payload.promptText,
      text: payload.text,
      speed: payload.speed,
      format,
      debugLog: appendGptsovitsTtsLog,
    });
    fs.writeFileSync(audioPath, result.audio);
    appendGptsovitsTtsLog({
      requestId: `gptsovits-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      phase: "cache.write",
      cacheKey,
      audioBytes: result.audio.length,
      textChars: Array.from(payload.text).length,
    });
    return {
      base64: result.audio.toString("base64"),
      cacheKey,
      cached: false,
      format: result.format,
    };
  });

  // 自定义云端 TTS 合成 → base64 音频（测试发音用，不缓存）
  ipcMain.handle(IPC.TTS_SYNTHESIZE_CUSTOM_CLOUD, async (_event, payload: {
    endpointUrl: string; apiKey?: string; voiceId?: string; text: string;
    speed?: number; volume?: number; format?: "wav" | "mp3"; timeoutMs?: number;
  }) => {
    if (!payload?.endpointUrl || !payload?.text) {
      throw new Error("缺少必要参数（endpointUrl/text）");
    }
    const result = await customCloudSynthesize({
      ...payload,
      debugLog: appendCustomCloudTtsLog,
    });
    const cacheKey = buildCustomCloudCacheKey(payload);
    return {
      base64: result.audio.toString("base64"),
      cacheKey,
      cached: false,
      format: result.format,
    };
  });

  // 自定义云端 TTS 合成 + 本地缓存（聊天朗读用）
  ipcMain.handle(IPC.TTS_SYNTHESIZE_CACHED_CUSTOM_CLOUD, async (_event, payload: {
    endpointUrl: string; apiKey?: string; voiceId?: string; text: string;
    speed?: number; volume?: number; format?: "wav" | "mp3"; timeoutMs?: number;
    expectedCacheKey?: string;
  }) => {
    const format: "wav" | "mp3" = payload.format ?? "mp3";

    let expectedPath: string | null = null;
    if (payload.expectedCacheKey) {
      try {
        expectedPath = getTtsCachePath(payload.expectedCacheKey, format);
      } catch { /* expectedCacheKey 格式非法，忽略 */ }
    }
    if (expectedPath && fs.existsSync(expectedPath)) {
      const cachedBuffer = fs.readFileSync(expectedPath);
      appendCustomCloudTtsLog({
        requestId: `custom-cloud-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: new Date().toISOString(),
        phase: "cache.hit",
        cacheKey: payload.expectedCacheKey,
        audioBytes: cachedBuffer.length,
        textChars: Array.from(payload.text).length,
      });
      return {
        base64: cachedBuffer.toString("base64"),
        cacheKey: payload.expectedCacheKey,
        cached: true,
        format,
      };
    }

    if (!payload?.endpointUrl || !payload?.text) {
      throw new Error("缓存未命中且缺少必要参数（endpointUrl/text）");
    }

    const cacheKey = buildCustomCloudCacheKey(payload);
    const audioPath = getTtsCachePath(cacheKey, format);
    fs.mkdirSync(path.dirname(audioPath), { recursive: true });

    const result = await customCloudSynthesize({
      endpointUrl: payload.endpointUrl,
      apiKey: payload.apiKey,
      voiceId: payload.voiceId,
      text: payload.text,
      speed: payload.speed,
      volume: payload.volume,
      format,
      timeoutMs: payload.timeoutMs,
      debugLog: appendCustomCloudTtsLog,
    });
    fs.writeFileSync(audioPath, result.audio);
    appendCustomCloudTtsLog({
      requestId: `custom-cloud-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      phase: "cache.write",
      cacheKey,
      audioBytes: result.audio.length,
      textChars: Array.from(payload.text).length,
    });
    return {
      base64: result.audio.toString("base64"),
      cacheKey,
      cached: false,
      format: result.format,
    };
  });

  // 小米 MiMo TTS 合成 → base64 音频（测试发音用，不缓存）
  ipcMain.handle(IPC.TTS_SYNTHESIZE_MIMO, async (_event, payload: {
    apiKey: string; voiceAudioPath?: string; text: string; stylePrompt?: string;
  }) => {
    if (!payload?.apiKey || !payload?.voiceAudioPath || !payload?.text) {
      throw new Error("缺少必要参数（apiKey/voiceAudioPath/text）");
    }
    const result = await mimoSynthesize({
      apiKey: payload.apiKey,
      voiceAudioPath: payload.voiceAudioPath,
      text: payload.text,
      stylePrompt: payload.stylePrompt,
      debugLog: appendMimoTtsLog,
    });
    const cacheKey = buildMimoCacheKey(payload);
    return {
      base64: result.audio.toString("base64"),
      cacheKey,
      cached: false,
      format: result.format,
    };
  });

  // 小米 MiMo TTS 合成 + 本地缓存（聊天朗读用）
  ipcMain.handle(IPC.TTS_SYNTHESIZE_CACHED_MIMO, async (_event, payload: {
    apiKey: string; voiceAudioPath?: string; text: string; stylePrompt?: string;
    expectedCacheKey?: string;
  }) => {
    const format: "wav" = "wav";

    let expectedPath: string | null = null;
    if (payload.expectedCacheKey) {
      try {
        expectedPath = getTtsCachePath(payload.expectedCacheKey, format);
      } catch { /* expectedCacheKey 格式非法，忽略 */ }
    }
    if (expectedPath && fs.existsSync(expectedPath)) {
      const cachedBuffer = fs.readFileSync(expectedPath);
      appendMimoTtsLog({
        requestId: `mimo-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: new Date().toISOString(),
        phase: "cache.hit",
        cacheKey: payload.expectedCacheKey,
        audioBytes: cachedBuffer.length,
        textChars: Array.from(payload.text).length,
      });
      return {
        base64: cachedBuffer.toString("base64"),
        cacheKey: payload.expectedCacheKey,
        cached: true,
        format,
      };
    }

    if (!payload?.apiKey || !payload?.voiceAudioPath || !payload?.text || payload.apiKey === "cache-only") {
      throw new Error("缓存未命中且缺少必要参数（apiKey/voiceAudioPath/text）");
    }

    const cacheKey = buildMimoCacheKey(payload);
    const audioPath = getTtsCachePath(cacheKey, format);
    fs.mkdirSync(path.dirname(audioPath), { recursive: true });

    const result = await mimoSynthesize({
      apiKey: payload.apiKey,
      voiceAudioPath: payload.voiceAudioPath,
      text: payload.text,
      stylePrompt: payload.stylePrompt,
      debugLog: appendMimoTtsLog,
    });
    fs.writeFileSync(audioPath, result.audio);
    appendMimoTtsLog({
      requestId: `mimo-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      phase: "cache.write",
      cacheKey,
      audioBytes: result.audio.length,
      textChars: Array.from(payload.text).length,
    });
    return {
      base64: result.audio.toString("base64"),
      cacheKey,
      cached: false,
      format: result.format,
    };
  });

  // ── Mossland (api.mosi.cn) ──────────────────────────────────────

  // Mossland 合成（Settings「测试发音」用，无缓存）
  ipcMain.handle(IPC.TTS_SYNTHESIZE_MOSSLAND, async (_event, payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; model?: string;
    format?: "mp3" | "wav" | "pcm";
  }) => {
    if (!payload?.apiKey || !payload?.voiceId || !payload?.text) {
      throw new Error("缺少必要参数（apiKey/voiceId/text）");
    }
    const result = await mosslandSynthesize({
      apiKey: payload.apiKey,
      voiceId: payload.voiceId,
      text: payload.text,
      speed: payload.speed,
      volume: payload.volume,
      model: payload.model,
      format: payload.format,
    });
    const cacheKey = buildMosslandCacheKey(payload);
    return {
      base64: result.audio.toString("base64"),
      cacheKey,
      cached: false,
      format: result.format,
    };
  });

  // Mossland 合成 + 本地缓存（聊天自动朗读用；cache-only 兜底由 chat 侧传 "cache-only"）
  ipcMain.handle(IPC.TTS_SYNTHESIZE_CACHED_MOSSLAND, async (_event, payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; model?: string;
    format?: "mp3" | "wav" | "pcm";
    expectedCacheKey?: string;
  }) => {
    const format: "mp3" | "wav" | "pcm" = payload.format ?? "mp3";

    // 缓存命中
    let expectedPath: string | null = null;
    if (payload.expectedCacheKey) {
      try {
        expectedPath = getTtsCachePath(payload.expectedCacheKey, format);
      } catch { /* expectedCacheKey 非法，忽略 */ }
    }
    if (expectedPath && fs.existsSync(expectedPath)) {
      const cachedBuffer = fs.readFileSync(expectedPath);
      return {
        base64: cachedBuffer.toString("base64"),
        cacheKey: payload.expectedCacheKey,
        cached: true,
        format,
      };
    }

    // 缓存未命中 + 缺关键参数（或 chat 端 cache-only 占位）→ 抛错
    if (!payload?.apiKey || !payload?.voiceId || !payload?.text
        || payload.apiKey === "cache-only" || payload.voiceId === "cache-only") {
      throw new Error("缓存未命中且缺少必要参数（apiKey/voiceId/text）");
    }

    const cacheKey = buildMosslandCacheKey(payload);
    const audioPath = getTtsCachePath(cacheKey, format);
    fs.mkdirSync(path.dirname(audioPath), { recursive: true });

    const result = await mosslandSynthesize({
      apiKey: payload.apiKey,
      voiceId: payload.voiceId,
      text: payload.text,
      speed: payload.speed,
      volume: payload.volume,
      model: payload.model,
      format,
    });
    fs.writeFileSync(audioPath, result.audio);
    return {
      base64: result.audio.toString("base64"),
      cacheKey,
      cached: false,
      format: result.format,
    };
  });

  // Mossland 音色克隆（multipart 上传）
  ipcMain.handle(IPC.TTS_CLONE_MOSSLAND, async (_event, payload: {
    apiKey: string; filePath: string; name?: string; description?: string;
  }) => {
    const result = await mosslandCloneVoice({
      apiKey: payload.apiKey,
      filePath: payload.filePath,
      name: payload.name,
      description: payload.description,
    });
    return {
      voiceId: result.voiceId,
      name: result.name,
      createdAt: result.createdAt,
    };
  });

  // Mossland 拉取账号下音色列表
  ipcMain.handle(IPC.TTS_LIST_MOSSLAND_VOICES, async (_event, payload: {
    apiKey: string; limit?: number;
  }) => {
    const result = await mosslandListVoices({
      apiKey: payload.apiKey,
      limit: payload.limit,
    });
    return { voices: result.voices };
  });

  // 聊天会话存储 IPC（chats-store.initialize 会建好 cyrene-chats 目录并加载 index）
  registerChatsIpc();
  proactiveLifecycle.initializeProactiveChatService();
  proactiveLifecycle.initializeProactiveTrigger();

  // 历史召回工具（recall_history）——让模型能回忆滚出窗口的对话
  registerRecallHistoryTool();

  // 文档生成工具（write_excel/write_word/write_pdf/write_markdown）
  registerDocumentTools();

  // 生活类工具（记账/汇率/翻译/代码补丁）
  // 翻译需要主模型，注入 loadModelSettings getter
  setTranslateConfig(() => {
    const s = loadModelSettings();
    return s.apiKey ? { provider: s.provider, baseUrl: s.baseUrl, model: s.model, apiKey: s.apiKey } : null;
  });
  registerLifeTools();

  // 出行工具（路线规划——驾车/步行/骑行/公交，复用 amapKey）
  registerTravelTools();

  // 邮件发送工具（SMTP 直发，需在设置里配置 SMTP 授权码）
  registerEmailTools();
  syncBuiltInToolToggles(loadGeneralSettings());

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

  // 多渠道（微信/飞书/...）：先注入 dispatcher 的 buildAndRunAgent + TTS + 镜像广播 + 最近历史读取，
  // 让 channels 模块拿到真 agent + 出站增强能力 + 对话上下文。
  setDispatcherLoadRecentHistory(async (sessionId, limit) => {
    // 委托给 history-log：读 userData/channels/history/<sessionId>.jsonl 最新 N 条
    const { loadRecentHistory } = await import("./channels/history-log");
    return loadRecentHistory(sessionId, limit);
  });
  setDispatcherLoadGeneralSettings(loadGeneralSettings);

  setDispatcherBuildAndRunAgent(async (msg, sessionId, priorMessages) => {
    // 渠道响应结果：统一由 dispatcher 按 cap 降级到 OutgoingMessage.parts。
    // 包含 sticker 决定（从 onAgentRunFinished 返回，避免在 dispatcher 端重新算一遍 embedding）。
    const channelResult: { text: string; sticker: string | null } = { text: "", sticker: null };

    // Phase 3.3：按 toolSandbox 过滤可用工具
    const sandbox = loadChannelsSettings().toolSandbox;
    const allTools = toolRegistry.getEnabledTools();
    const filteredTools: ToolDefinition[] = sandbox === "off"
      ? []
      : sandbox === "safe-only"
        ? allTools.filter((t) => (t.risk ?? "safe") === ("safe" as ToolRiskLevel))
        : allTools;
    console.log(
      "[Channels] bot run:",
      `msg.channel=${msg.channel} sandbox=${sandbox} tools=${filteredTools.length}/${allTools.length} priorMsgs=${priorMessages?.length ?? 0}`,
    );

    // Phase A：拼接历史 (同桌面端 buildModelMessages 行为: 上滑窗最近 N 条).
    // history-log 统一存 role: "user"|"assistant", 直接用即可.
    const historyMessages = (priorMessages ?? [])
      .filter((m) => typeof m.content === "string" && m.content.trim().length > 0)
      .map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      }));

    // 把 IncomingMessage 转成 AguiRunInput，调 CyreneAgent
    const channelModelSettings = loadModelSettings();
    const imageSendStrategy = decideImageSendStrategy({
      multimodal: channelModelSettings.multimodal,
      vision: loadVisionConfig(),
    });
    const attachmentInputs = await buildChannelAttachmentInputs(msg, {
      imageMode: imageSendStrategy.mode,
      captionImage: async (filePath: string) => {
        const validated = validateCaptionImagePath(filePath);
        if (!validated.ok) return { ok: false, error: validated.error };
        const visionCfg = loadVisionConfig();
        if (!visionCfg) return { ok: false, error: "未配置视觉模型，无法分析图片" };
        try {
          const { captionImage } = await import("./orchestrator/vision-captioner");
          const caption = await captionImage(
            { base64: validated.buffer.toString("base64"), mime: validated.mime },
            IMAGE_CAPTION_PROMPT,
            visionCfg,
          );
          if (caption.startsWith("[错误")) return { ok: false, error: caption };
          return { ok: true, caption };
        } catch (err: any) {
          return { ok: false, error: err?.message || String(err) };
        }
      },
    });
    const { options } = await agentRuntime.buildOptions({
      messages: [
        ...historyMessages,
        { role: "user", content: msg.text },
      ],
      style: "01_default.md",
      sessionId,
      attachments: attachmentInputs.attachments,
      imageAttachments: attachmentInputs.imageAttachments,
      channel: msg.channel,
      executionMode: sandbox === "off" ? "chat" : "work",
      ...(sandbox === "off" ? {
        userTurnId: `${msg.channel}:${msg.senderId}:${msg.at.toISOString()}:user`,
        assistantTurnId: `${msg.channel}:${msg.senderId}:${msg.at.toISOString()}:assistant`,
      } : {}),
    });
    // 把过滤后的 tools 注入 options（覆盖默认的 getEnabledTools）
    options.tools = filteredTools;

    const threadId = `thread-${sessionId}-${Date.now()}`;
    const agent = new CyreneAgent({ threadId, description: `bot:${msg.channel}:${msg.senderId}` });
    const reply = await new Promise<string>((resolve, reject) => {
      agent.runWithEvents(options).subscribe({
        complete: () => {
          resolve(agent.lastResult?.reply ?? "");
        },
        error: (err) => reject(err instanceof Error ? err : new Error(String(err))),
      });
    });
    channelResult.text = reply;
    if (agent.lastResult) {
      const finished = await agentRuntime.onRunFinished(agent.lastResult, msg.text, msg.channel);
      // 把 sticker 决定透出给 dispatcher，让它纳入 OutgoingMessage.parts；
      // 桌面聊天窗的 sticker 仍由 onAgentRunFinished 内部 IPC 广播承担，此处不重复。
      channelResult.sticker = finished.sticker;
    }
    // 落历史
    void indexConversationTurn(sessionId, msg.text, reply);
    return channelResult;
  });

  // Phase 3.1：注入 TTS 合成 —— dispatcher 在 reply 后会用这个生成渠道音频
  setDispatcherSynthesizeTts(async (text: string, context) => {
    const cfg = loadGeneralSettings();
    if (cfg.ttsEngine === "off") return null;
    if (cfg.ttsEngine === "minimax" && (!cfg.ttsMinimaxKey || !cfg.ttsMinimaxVoiceId)) return null;
    if (cfg.ttsEngine === "gptsovits" && (!cfg.ttsGptsovitsBaseUrl || !cfg.ttsGptsovitsRefAudioPath || !cfg.ttsGptsovitsPromptText)) return null;
    if (cfg.ttsEngine === "custom-cloud" && !cfg.ttsCustomCloudEndpointUrl) return null;
    if (cfg.ttsEngine === "mimo" && (!cfg.ttsMimoKey || !cfg.ttsMimoVoiceAudioPath)) return null;
    // 限制 TTS 文本长度（飞书 audio 100M 限制 + 用户体验，太长应截断）
    const ttsText = text.length > 1000 ? text.slice(0, 1000) + "…" : text;
    try {
      const requestedFormat = context.channel === "wechat" ? "wav" : "mp3";
      const result = await synthesizeByEngine(cfg.ttsEngine, {
        text: ttsText,
        speed: cfg.ttsSpeed,
        volume: cfg.ttsVolume,
        // minimax
        apiKey: cfg.ttsEngine === "mimo"
          ? cfg.ttsMimoKey
          : cfg.ttsEngine === "custom-cloud"
            ? cfg.ttsCustomCloudApiKey
            : cfg.ttsMinimaxKey,
        voiceId: cfg.ttsEngine === "mimo"
          ? ""
          : cfg.ttsEngine === "custom-cloud"
            ? cfg.ttsCustomCloudVoiceId
            : cfg.ttsMinimaxVoiceId,
        model: cfg.ttsMinimaxModel,
        // gptsovits
        baseUrl: cfg.ttsGptsovitsBaseUrl,
        refAudioPath: cfg.ttsGptsovitsRefAudioPath,
        promptText: cfg.ttsGptsovitsPromptText,
        // custom-cloud
        endpointUrl: cfg.ttsCustomCloudEndpointUrl,
        timeoutMs: cfg.ttsEngine === "gptsovits" ? cfg.ttsGptsovitsTimeoutMs : cfg.ttsCustomCloudTimeoutMs,
        // mimo
        voiceAudioPath: cfg.ttsMimoVoiceAudioPath,
        stylePrompt: cfg.ttsMimoStylePrompt,
        format: requestedFormat,
      });
      const headerHex = result.audio.subarray(0, 4).toString("hex");
      console.log("[TTS verify] engine=", cfg.ttsEngine, "format=", result.format, "header=", headerHex, "size=", result.audio.length);
      return {
        audio: result.audio,
        format: result.format,
        mime: result.format === "wav" ? "audio/wav" : result.format === "pcm" ? "audio/pcm" : "audio/mpeg",
        extension: result.format === "wav" ? ".wav" : result.format === "pcm" ? ".pcm" : ".mp3",
      };
    } catch (err) {
      console.warn("[Channels] TTS 合成失败:", err instanceof Error ? err.message : err);
      return null;
    }
  });

  // Phase 3.2：注入桌面端镜像广播 —— 把 bot 入站/出站消息推到 reactChatWindow
  setDispatcherBroadcastChat((event) => {
    const win = reactChatWindow;
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send(IPC.AGUI_EVENT, {
        type: "CUSTOM",
        name: "cyrene.botMessage",
        value: event,
      });
    } catch (err) {
      console.warn("[Channels] botMessage 广播失败:", err);
    }
  });

  void initChannels();

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

  const schedulerStore = getSchedulerStore();
  schedulerStore.load();

  // AG-UI 事件流桥：渲染进程 invoke(AGUI_RUN) → CyreneAgent 跑 FC 循环 → 事件透传
  // buildOptions 负责统一构建上下文；onRunFinished 复用副作用
  // Phase 0 重构：抽出到 orchestrator/build-options.ts，三处共用（桌面 / scheduler / bot）
  // deps 函数签名故意宽 (unknown/ReadonlyArray)；这里做一次包装把强类型函数适配进去
  const socialAtomStore = createSocialAtomStore(
    path.join(app.getPath("userData"), "chat-social-atoms.json"),
  );
  const socialContextScheduler = createSocialContextScheduler({
    store: socialAtomStore,
    enqueue: (label, task) => enqueueLLMTask(label, task, {
      log: false,
      retryRateLimit: false,
    }),
    generate: async (input, repair) => {
      const settings = loadModelSettings();
      const config: VendorConfig = {
        provider: settings.provider,
        baseUrl: settings.baseUrl,
        model: settings.model,
        apiKey: settings.apiKey,
        explicitTransport: settings.explicitTransport,
        reasoning: { mode: "off" },
      };
      const adapter = getAdapterForConfig(config);
      const profile = resolveStructuredOutputProfile({
        provider: adapter.id,
        model: config.model,
        transport: adapter.transport,
        endpointKind: classifyStructuredOutputEndpoint({
          providerId: adapter.id,
          configuredBaseUrl: config.baseUrl,
          officialBaseUrl: adapter.capability.baseUrl,
        }),
      });
      const structuredOutput: StructuredOutputRequest = profile.mode === "provider_json_schema"
        ? {
            mode: "json_schema",
            name: "chat_social_atoms",
            schema: SOCIAL_EXTRACTION_SCHEMA,
            strict: true,
          }
        : profile.mode === "provider_json_object"
          ? {
              mode: "json_object",
              name: "chat_social_atoms",
              schema: SOCIAL_EXTRACTION_SCHEMA,
            }
          : {
              mode: "prompt_json",
              name: "chat_social_atoms",
              schema: SOCIAL_EXTRACTION_SCHEMA,
              sendJsonObjectHint: profile.requestHints.sendJsonObject,
            };
      const response = await llmClient.chatNonStream(
        settings,
        [
          {
            role: "system",
            content: "Extract only directly supported chat continuity facts. Return exactly one JSON object and no prose.",
          },
          { role: "user", content: buildSocialExtractionPrompt(input, repair) },
        ],
        // Kimi k2.6 只允许特定 temperature，省略让服务端用默认值
        settings.model.match(/^kimi-k2\.6(?:$|-)/i) ? undefined : 0,
        12_000,
        "Chat social context extraction",
        { mode: "off" },
        {
          structuredOutput,
          maxTokens: 1_000,
          ...(profile.requestHints.reasoningSplit
            ? { extraBody: { reasoning_split: true } }
            : {}),
        },
      );
      if (response.refusal || normalizeFinishReason(response.finishReason) !== "complete") {
        throw new Error("CHAT_SOCIAL_EXTRACTION_INCOMPLETE");
      }
      return response.text;
    },
    recordMetric: (metric) => {
      console.log(
        `[ChatSocialContext] outcome=${metric.outcome} accepted=${metric.acceptedCount} rejected=${metric.rejectedCount} attempts=${metric.attempts} repairs=${metric.repairCount}`,
      );
    },
  });
  const agentRuntime = createAgentRuntime({
    runtimeStateService,
    llmClient,
    enqueueLLMTask,
    loadModelSettings,
    loadGeneralSettings,
    loadUserProfile,
    toolRegistry,
    skillRegistry,
    sceneEmbeddingIndex,
    stickerEmbeddingIndex,
    getEmbeddingProvider,
    getSceneEmbeddingProvider,
    broadcastRuntimeStateChanged,
    citaService,
    socialContextScheduler,
    chatsStore,
    socialAtomStore,
  });

  const schedulerRunner = createSchedulerRunner({
    buildOptions: (task) => agentRuntime.buildSchedulerOptions(task),
    getChatWebContents: () => (reactChatWindow && !reactChatWindow.isDestroyed() ? reactChatWindow.webContents : null),
    recordHistory: (entry) => schedulerStore.recordHistory(entry),
    id: () => `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    now: () => new Date(),
  });
  schedulerEngine = new SchedulerEngine({
    store: schedulerStore,
    runTask: schedulerRunner.runScheduledTask,
  });
  registerSchedulerIpc(schedulerStore, schedulerEngine, () => toolRegistry.getAllTools());

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

  scheduleStartupEmbeddingRefreshes();

  schedulerEngine.start();
});

app.on("window-all-closed", () => {});

// 应用退出前把 token 用量缓存落盘（防抖未触发的最后一次写）
app.on("before-quit", () => {
  windowManager?.dispose();
  schedulerEngine?.stop();
  proactiveLifecycle.stopProactiveTrigger();
  codeRunWorker.cleanup();
  flushTokenUsage();
  void shutdownChannels();
  void screenshotService?.shutdown();
});

app.on("activate", () => {
  windowManager?.createMainWindow();
});







