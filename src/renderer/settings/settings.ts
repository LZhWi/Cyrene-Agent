import "../ui/base.css";
import "./settings.css";
import "../ui/theme";
import neteaseLogoUrl from "./assets/netease-logo.svg?url";
import {
  normalizeChatSocialContextEnabled,
  normalizeDefaultChatMode,
  normalizeMobileMessageSegmentationMode,
  normalizeProactiveChatMode,
  normalizeProactiveDeliveryTarget,
  normalizeSegmentedOutputMode,
  type DefaultChatMode,
  type MobileMessageSegmentationMode,
  type ProactiveChatMode,
  type ProactiveDeliveryTarget,
  type SegmentedOutputMode,
} from "../../shared/preferences";
import { isProactiveDeliveryTargetSelectable } from "../../shared/proactive-delivery";
import type { UiTheme } from "../../shared/ui-theme";
import { DEFAULT_UI_FONT, normalizeUiFont, type UiFont } from "../../shared/ui-font";
import { normalizeUiIcon, type UiIcon } from "../../shared/ui-icon";
import {
  DEFAULT_WINDOW_CORNER_RADIUS,
  normalizeWindowCornerRadius,
} from "../../shared/window-corner-radius";
import { applyWindowCornerRadius } from "../ui/window-corner-radius";
import { getCitaUiState } from "./cita-settings-state";
import { type ReasoningPreference } from "../../shared/reasoning";
import { type LoginFlowState } from "../../shared/music-types";
import { resolveApiEndpoint, type ApiTransport } from "../../shared/api-endpoint";
import type { ChatAppearanceSettings } from "../../shared/chat-appearance";
import {
  DEFAULT_CUSTOM_STYLE,
  normalizeCustomStyleConfig,
  type CustomStyleConfig,
  type DiversityPreference,
  type RepetitionLevel,
} from "../../shared/style-sampling";
import {
  CUSTOM_ENDPOINT_PROVIDERS,
  getCustomEndpointMode,
  getCustomEndpointPresentation,
  getCustomEndpointProvider,
  validateCustomEndpointConfig,
  type CustomEndpointMode,
} from "./custom-endpoint-state";
import {
  deriveNeteaseViewState,
  type MusicStatusSnapshot,
  type NeteaseViewState,
} from "../../shared/music-view-state";
export {
  deriveNeteaseViewState,
  type MusicStatusSnapshot,
  type NeteaseViewState,
} from "../../shared/music-view-state";
import type {
  ScheduleConfig,
  SchedulerApi,
  SchedulerResult,
  SchedulerToolInfo,
  SchedulerToolMode,
  ScheduledTask,
  ScheduledTaskHistoryEntry,
} from "./scheduler/types";
import { musicState } from "./music/state";
import { musicHomeView, musicReturnBtn, musicSearchForm, musicSearchHint, musicQrStatus, musicProfileAvatar, musicLoginBtn, musicCancelBtn, musicDisconnectBtn, musicQrImg, musicQrTip, musicQrBox, musicFeedbackEl, musicAccountStatusText, musicSearchInput, musicSearchBtn, musicSearchResults, musicToggle, musicAccordionCard, musicAccordionBody } from "./music/dom";
import { channelsState } from "./channels/state";
import { channelsWechatEnabledEl, channelsFeishuEnabledEl, channelsWechatStatusEl, channelsFeishuStatusEl, channelsRateUserEl, channelsRateChannelEl, channelsTtsEl, channelsStickerEl, channelsMirrorEl, channelsToolSandboxOffEl, channelsToolSandboxAllEl, channelsToolSandboxSafeEl, channelsFeishuAppIdEl, channelsFeishuAppSecretEl, channelsFeishuAppSecretRevealBtn, channelsFeishuSaveBtn, channelsWechatLoginBtn, channelsWechatRestartBtn, channelsWechatFeedbackEl, channelsFeishuFeedbackEl, channelsLogListEl, channelsLogRefreshBtn, channelsLogClearBtn } from "./channels/dom";
import { memoryState } from "./memory/state";
import { memoryL0NameInput, memoryL0OccupationInput, memoryL0InterestsInput, memoryL0LanguageInput, memoryL0NoteInput, memoryL1GoalsInput, memoryL1PreferencesInput, memoryL1ProjectInput, memoryL2SearchInput, memoryL2List, memoryImportedList, memoryReflectionList, memoryL0EditBtn, memoryL0CancelBtn, memoryL1EditBtn, memoryL1CancelBtn } from "./memory/dom";
import { schedulerState } from "./scheduler/state";
import { schedulerNewBtn, schedulerEmpty, schedulerList, schedulerEditor, schedulerEditorTitle, schedulerEditorClose, schedulerTitleInput, schedulerPromptInput, schedulerEnabledInput, schedulerKindInput, schedulerOnceRunAtInput, schedulerTimeOfDayInput, schedulerDayOfWeekInput, schedulerIntervalEveryInput, schedulerIntervalUnitInput, schedulerToolLimitInput, schedulerToolPicker, schedulerToolEmptyHint, schedulerSaveStatus, schedulerCancelBtn, schedulerSaveBtn } from "./scheduler/dom";
import { timeoutProfileTotalBudgetInput, timeoutProfilePerAttemptInput, timeoutProfileRemainingInput } from "./timeout/dom";
import { tokensState } from "./tokens/state";
import { ttsState } from "./tts/state";
import { modalState } from "./shared/modal-state";
import { formatDateTime, escapeHtml } from "./shared/format";
import { parsePositiveIntOrThrow, parseN1SecToMsOrThrow, parseCommandLine } from "./shared/parse";
import { apiState } from "./api/state";
import { apiForm, apiRuntimeForm, apiTimeoutForm, presetCards, presetWebsiteLink, displayNameInput, baseUrlInput, baseUrlResetBtn, modelInput, modelInputSuggestions, contextWindowInput, apiKeyInput, apiKeyLabel, apiKeyHint, testConnectionBtn, transportSelect, transportHint, endpointPreview, customEndpointControls, customEndpointOverrides, customEndpointSummary, customEndpointGuideBtn, workFlowAdaptBtn, apiNoteText, multimodalToggle, chatRequestTimeoutSecInput, maxIterationsInput, maxReplansInput, maxRefreshInput, perCallTimeoutSecInput, actionGateRepairBudgetSecInput, embeddingDimensionsInput, modelRequestTimeoutSecInput, modelRequestTimeoutSecReset, toggleEnableThinking, toggleDisableThinking, toggleDisableMaxToken } from "./api/dom";
import { visionBaseUrlInput, visionApiKeyInput, visionModelInput, visionFieldsWrap, testVisionBtn, visionTestStatus } from "./vision/dom";
import { appearanceForm, appearanceSaveStatus, runtimeSyncSelect, runtimeSyncNote, windowCornerRadiusInput, windowCornerRadiusVal, petAlwaysOnTopInput, petVisibleInput, petZoomInput, petZoomVal, chatLineHeightInput, chatLineHeightVal, assistantBubbleEnabledInput, chatParaSpacingInput, chatParaSpacingVal, launchAtLoginInput, uiFontCurrent, uiFontImportButton, uiFontResetButton, uiIconSelect, screenshotHotkeyInput, openChromeGpu, disableGpuInput, sidebarVisibleInput, tasksVisibleInput } from "./appearance/dom";
import { generalForm, generalSaveStatus, languageSelect, defaultChatModeSelect, segmentedOutputSelect, mobileMessageSegmentationSelect, proactiveChatSelect, proactiveDeliveryRow, proactiveDeliverySelect, chatSocialContextEnabledInput, citaEnabledInput, citaEngineSelect, clearChatHistoryBtn, customStyleSamplingBtn, customStylePromptBtn } from "./general/dom";
import { minBtn, closeBtn, preferencesForm, sectionTitle, sectionHint, placeholderPanel, cyrenePanel, disclaimerPanel, pluginsPanel, placeholderIcon, placeholderTitle, placeholderCopy, saveStatus, runtimeSaveStatus, preferencesSaveStatus, cyreneSaveStatus, openStickerManagerBtn, addStickerBtn } from "./shared/shell";
import { pluginAddBtn, neteaseDetailView, permissionBlocksWrap, permissionNote, lifeToggle, lifeCard, lifeBody } from "./plugins/dom";
import { preferencesState } from "./preferences/state";
import { stickerEnabledInput, stickerSizeSelect, stickerThresholdInput, stickerThresholdVal, stickerAddOverlay, stickerAddPickBtn, stickerAddFileName, stickerAddId, stickerAddDesc, stickerAddPhrases, stickerAddError, stickerAddConfirm, stickerAddCancel } from "./preferences/dom";
import { diversityDriverOf, diversityValueOf } from "./preferences/style-utils";
import { pluginsState } from "./plugins/state";
import type {
  GeneralSettings,
  MemoryPanelApi,
  MemoryPanelPayload,
  ModelPreset,
  ModelSettings,
  ProviderProfile,
  SettingsApi,
  UserApi,
} from "./shared/types";
import { TTS_FIELD_MAP, TTS_PROVIDER_FIELDS } from "./tts/field-map";
import { MODEL_PRESETS } from "./api/presets";
import { showModal, showHtmlModal, showInputModal } from "./shared/modal";
import {
  setSaveStatus, setCyreneSaveStatus, setPreferencesSaveStatus, setAppearanceSaveStatus,
  setGeneralSaveStatus, setTimeoutSaveStatus, setRuntimeSaveStatus,
} from "./shared/save-status";
import { renderEmptyState, renderInfoList } from "./shared/render";
import { shallowEqual, safeGet } from "./shared/utils";
import {
  loadMemoryPanel,
  enterL0EditMode, exitL0EditMode, saveL0, cancelL0Edit,
  enterL1EditMode, exitL1EditMode, saveL1, cancelL1Edit,
  renderImportedDocs,
} from "./memory/panel";
import {
  setSchedulerStatus, renderSchedulerTools, renderSchedulerList,
  loadSchedulerPanel, openSchedulerEditor, closeSchedulerEditor,
  updateSchedulerConditionalFields, collectSchedule, collectAllowedToolIds,
  saveSchedulerTask, toggleSchedulerTask, fireSchedulerTask,
  deleteSchedulerTask, toggleSchedulerHistory,
} from "./scheduler/panel";
import { loadMusicPanel, disposeMusicPanel } from "./music/panel";
import { loadChannelsPanel } from "./channels/panel";
import { renderProactiveDeliveryAvailability } from "./channels/panel";
import "./asr/panel";  // 副作用导入：执行事件绑定 + 初始加载
import "./email/panel";  // 副作用导入：执行事件绑定 + 初始加载
import "./search/panel";  // 副作用导入：执行事件绑定 + 初始加载
import { saveTimeoutSettings } from "./timeout/panel";  // saveTimeoutSettings 被 API 表单处理器调用
import { DEFAULT_TIMEOUT_SETTINGS, type TimeoutSettings } from "../../shared/timeout-types";  // mock + API 表单校验用
import "./user/panel";  // 副作用导入：执行事件绑定 + 初始加载
import "./plugins/panel";  // 副作用导入：执行事件绑定 + 初始加载
import "./tokens/panel";  // 副作用导入：Token 用量图表 + 时间范围切换

// Inline modal (to avoid Vite tree-shaking)


/**
 * 富文本模态框（基于 cy-modal 样式但使用独立 overlay，避免与 showModal 冲突）。
 * 用于"音色快速复刻"这种需要展示多组说明（规格 / 费用 / 过期规则）的场景。
 * 调用方负责传入安全的 HTML（项目内固定字符串）；若内容来自用户/网络必须先 escapeHtml。
 */


// escapeHtml() 已定义在文件下方（settings.ts:3738），此处复用即可。

// Inline input modal (Electron 禁用了 window.prompt，所以自己实现)




declare global {
  interface Window {
    settings?: SettingsApi;
    cyreneScheduler?: SchedulerApi;
    user?: UserApi;
    memoryPanel?: MemoryPanelApi;
  }
}

// MiMo 的 icon 是 lobehub-icons 仓库的 PNG（不在 icons-static-svg 包里）。
// 单独声明，与 8 家 npmmirror SVG 常量解耦（feat/chore 两个 commit 真正独立）。
// 实施时若图片加载失败，可考虑：1) 锁定 commit hash；2) 下载到本地 assets/icons/mimo.png
const MIMO_ICON_URL =
  "https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/light/xiaomimimo.png";


if (!window.settings) {
  (window as unknown as { settings: SettingsApi }).settings = {
    minimize: () => {},
    close: () => {},
    getConfig: () =>
      Promise.resolve({
        mode: "auto",
        provider: "DeepSeek",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-pro",
        apiKey: "",
        runtimeSync: "off",
        stickerEnabled: true,
        stickerSize: "standard",
        chatRequestTimeoutSec: 300,
        maxIterations: 12,
        maxReplans: 2,
        maxRefresh: 1,
        perCallTimeoutSec: 75,
        citaRepairBudgetSec: 8,
        actionGateRepairBudgetSec: 10,
      }),
    saveConfig: (c) => Promise.resolve(c as ModelSettings),
    getGeneral: () => Promise.resolve({
      petAlwaysOnTop: true,
      petVisible: true,
      petZoom: 1,
      chatLineHeight: 1.75,
      assistantBubbleEnabled: true,
      chatParaSpacing: 0.5,
      sidebarVisible: true,
      tasksVisible: true,
      launchAtLogin: false,
      language: "zh-CN",
      uiTheme: "pearl-white",
      windowCornerRadius: DEFAULT_WINDOW_CORNER_RADIUS,
      defaultChatMode: "chat",
      currentStyleId: "default",
      customStyle: DEFAULT_CUSTOM_STYLE,
      segmentedOutputMode: "off",
      mobileMessageSegmentation: "off",
      proactiveChatMode: "off",
      proactiveDeliveryTarget: "local",
      chatSocialContextEnabled: false,
      screenshotHotkey: "Alt+Shift+S",
    }),
    saveGeneral: (c) => Promise.resolve(c as GeneralSettings),
    openCustomStylePrompt: async () => ({ ok: false, error: "settings api unavailable" }),
    channelsGetStatus: () => Promise.resolve({}),
    onChannelsStatusChanged: () => () => {},
    beginScreenshotHotkeyCapture: () => Promise.resolve(true),
    endScreenshotHotkeyCapture: () => Promise.resolve(true),
    openSidebar: () => {},
    closeSidebar: () => {},
    openTasks: () => {},
    closeTasks: () => {},
    openChromeGpu: () => {},
    setPetAlwaysOnTop: () => {},
    setPetVisible: () => {},
    setPetZoom: () => {},
    openStickerManager: async () => ({ ok: false, error: "settings api unavailable" }),
    stickerPickFile: async () => null,
    stickerAdd: async () => { throw new Error("settings api unavailable"); },
    setToolEnabled: async () => ({ ok: false, error: "settings api unavailable" }),
    getToolEnabled: async () => ({}),
    listSkills: async () => [],
    setSkillEnabled: async () => ({ ok: false, error: "settings api unavailable" }),
    addMcpServer: async () => ({ ok: false, error: "settings api unavailable" }),
    removeMcpServer: async () => ({ ok: false, error: "settings api unavailable" }),
    listMcpServers: async () => [],
    getTimeoutSettings: async () => DEFAULT_TIMEOUT_SETTINGS,
    saveTimeoutSettings: async c => (c as TimeoutSettings),
  };
}

if (!window.cyreneScheduler) {
  (window as unknown as { cyreneScheduler: SchedulerApi }).cyreneScheduler = {
    list: async () => ({ ok: true, value: [] }),
    add: async () => ({ ok: false, error: "scheduler api unavailable" }),
    update: async () => ({ ok: false, error: "scheduler api unavailable" }),
    delete: async () => ({ ok: false, error: "scheduler api unavailable" }),
    toggle: async () => ({ ok: false, error: "scheduler api unavailable" }),
    fireNow: async () => ({ ok: false, reason: "scheduler api unavailable" }),
    getHistory: async () => ({ ok: true, value: [] }),
    getTools: async () => ({ ok: true, value: [] }),
  };
}

document.querySelectorAll<HTMLImageElement>("[data-music-logo]").forEach((image) => {
  image.src = neteaseLogoUrl;
});



// 模式按钮已删除——baseUrl 永远可改、模型名永远可手填（datalist 出预设建议）
// provider 不再暴露给用户（从预设内部拿，保证 capabilities 匹配不出错）。
// 用户看到的是"昵称"框——给模型起自定义名字，状态栏"正在喂养"显示它。
// API 协议下拉（openai / anthropic）—— 不根据 URL 自动猜测。

// 视觉模型配置区元素

// 高级运行设置

// Embedding 维度（可选，仅 cloud 模式）

// 渲染端内存缓存：保存每个厂商上一次填写的 baseUrl / model / apiKey
// 切厂商时从这里读，保存时同步进去；持久化由 main 进程的 saveModelSettings 负责（perProvider 字段）。
const providerProfileCache: Record<string, ProviderProfile> = {};

// 当前激活的厂商：每次 applyPreset 后更新；用于"切到下一家厂商前先把当前那家的输入框值缓存住"



const NAV_LABELS: Record<string, { emoji: string; title: string; hint: string }> = {
  memory: { emoji: `<img src="../icons/mimi.png" width="24" height="24" alt="" aria-hidden="true" style="vertical-align:-3px" />`, title: "记忆", hint: "管理长期记忆与画像" },
  chat: { emoji: `<svg style="vertical-align:-3px" width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M33 38H22V30H36V22H44V38H39L36 41L33 38Z" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 6H36V30H17L13 34L9 30H4V6Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 18H20" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M26 18H27" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M12 18H13" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>`, title: "聊天", hint: "管理聊天窗口与会话" },
  user: { emoji: `<svg style="vertical-align:-3px" width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M44 8H4V38H19L24 43L29 38H44V8Z" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="24" cy="19" r="5" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M33 32C33 27.5817 28.9706 24 24 24C19.0294 24 15 27.5817 15 32" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`, title: "用户信息", hint: "编辑你的个人资料" },
  tasks: { emoji: `<svg style="vertical-align:-3px" width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M23.9998 44.3332C34.1251 44.3332 42.3332 36.1251 42.3332 25.9999C42.3332 15.8747 34.1251 7.66656 23.9998 7.66656C13.8746 7.66656 5.6665 15.8747 5.6665 25.9999C5.6665 36.1251 13.8746 44.3332 23.9998 44.3332Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M23.7594 15.3536L23.7582 26.3624L31.5305 34.1347" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 9.00001L11 4.00001" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M44 9.00001L37 4.00001" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`, title: "定时任务", hint: "管理定时提醒与日程" },
  skills: { emoji: `<svg width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="vertical-align:-3px"><title>Skills</title><rect x="9" y="8" width="30" height="36" rx="2" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M18 4V10" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M30 4V10" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 19L32 19" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 27L28 27" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 35H24" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`, title: "Skills", hint: "管理 agent 的 skill 指令（约束如何用工具）" },
  plugins: { emoji: "🔌", title: "MCP", hint: "扩展功能与第三方集成" },
  preferences: { emoji: `<svg width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="vertical-align:-3px"><title>偏好设置</title><path d="M12 35.0137H9H4V8.01273C4 6.90868 4.89543 6.01367 6 6.01367H42C43.1046 6.01367 44 6.90868 44 8.01273V35.0137H36" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 32L14 42H34L24 32Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`, title: "偏好设置", hint: "设置聊天窗口和输出行为的默认偏好" },
  appearance: { emoji: `<svg width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="vertical-align:-3px"><title>外观设置</title><path d="M24 44C29.9601 44 26.3359 35.136 30 31C33.1264 27.4709 44 29.0856 44 24C44 12.9543 35.0457 4 24 4C12.9543 4 4 12.9543 4 24C4 35.0457 12.9543 44 24 44Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M28 17C29.6569 17 31 15.6569 31 14C31 12.3431 29.6569 11 28 11C26.3431 11 25 12.3431 25 14C25 15.6569 26.3431 17 28 17Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M16 21C17.6569 21 19 19.6569 19 18C19 16.3431 17.6569 15 16 15C14.3431 15 13 16.3431 13 18C13 19.6569 14.3431 21 16 21Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M17 34C18.6569 34 20 32.6569 20 31C20 29.3431 18.6569 28 17 28C15.3431 28 14 29.3431 14 31C14 32.6569 15.3431 34 17 34Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`, title: "外观设置", hint: "调整窗口布局、界面主题与昔涟桌宠" },
  general: { emoji: `<svg width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="vertical-align:-3px"><title>通用设置</title><path d="M18.2838 43.1713C14.9327 42.1736 11.9498 40.3213 9.58787 37.867C10.469 36.8227 11 35.4734 11 34.0001C11 30.6864 8.31371 28.0001 5 28.0001C4.79955 28.0001 4.60139 28.01 4.40599 28.0292C4.13979 26.7277 4 25.3803 4 24.0001C4 21.9095 4.32077 19.8938 4.91579 17.9995C4.94381 17.9999 4.97188 18.0001 5 18.0001C8.31371 18.0001 11 15.3138 11 12.0001C11 11.0488 10.7786 10.1493 10.3846 9.35011C12.6975 7.1995 15.5205 5.59002 18.6521 4.72314C19.6444 6.66819 21.6667 8.00013 24 8.00013C26.3333 8.00013 28.3556 6.66819 29.3479 4.72314C32.4795 5.59002 35.3025 7.1995 37.6154 9.35011C37.2214 10.1493 37 11.0488 37 12.0001C37 15.3138 39.6863 18.0001 43 18.0001C43.0281 18.0001 43.0562 17.9999 43.0842 17.9995C43.6792 19.8938 44 21.9095 44 24.0001C44 25.3803 43.8602 26.7277 43.594 28.0292C43.3986 28.01 43.2005 28.0001 43 28.0001C39.6863 28.0001 37 30.6864 37 34.0001C37 35.4734 37.531 36.8227 38.4121 37.867C36.0502 40.3213 33.0673 42.1736 29.7162 43.1713C28.9428 40.752 26.676 39.0001 24 39.0001C21.324 39.0001 19.0572 40.752 18.2838 43.1713Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M24 31C27.866 31 31 27.866 31 24C31 20.134 27.866 17 24 17C20.134 17 17 20.134 17 24C17 27.866 20.134 31 24 31Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`, title: "通用设置", hint: "管理窗口、音频和系统行为" },
  api: { emoji: `<svg width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="vertical-align:-3px"><title>API 设置</title><g clip-path="url(#api-key-nav-clip)"><circle cx="15" cy="33" r="8" fill="none" stroke="currentColor" stroke-width="4"/><path d="M29 16L35.5 22" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 26L37 7" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M35 11L42 17.5" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></g><defs><clipPath id="api-key-nav-clip"><rect width="48" height="48" fill="none"/></clipPath></defs></svg>`, title: "API 设置", hint: "选择预设后只需要填写 API Key。" },
  "api-advanced": { emoji: `<svg width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="vertical-align:-3px"><title>高级设置</title><path d="M34.0003 41L44 24L34.0003 7H14.0002L4 24L14.0002 41H34.0003Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M24 29C26.7614 29 29 26.7614 29 24C29 21.2386 26.7614 19 24 19C21.2386 19 19 21.2386 19 24C19 26.7614 21.2386 29 24 29Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`, title: "高级设置", hint: "配置 API 超时时间、调用模式．" },
  cyrene: { emoji: "🌸", title: "昔涟设置", hint: "管理 Agent 行为、记忆、RAG 与权限" },
  tts: { emoji: "🎙️", title: "TTS 设置", hint: "语音合成与朗读偏好" },
  asr: { emoji: "🎧", title: "ASR 设置", hint: "语音识别与通话配置" },
	  tokens: { emoji: `<svg width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="vertical-align:-3px"><title>Token 用量</title><path d="M4 42H44" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><rect x="8" y="28" width="6" height="14" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><rect x="21" y="18" width="6" height="24" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><rect x="34" y="6" width="6" height="36" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`, title: "Token 用量", hint: "查看 API 调用统计与消耗" },
	  disclaimer: { emoji: `<svg width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="vertical-align:-3px"><title>免责声明</title><rect x="13" y="10" width="28" height="34" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M35 10V4H8C7.44772 4 7 4.44772 7 5V38H13" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 22H33" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 30H33" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`, title: "免责声明", hint: "使用条款与隐私说明" },
};

minBtn.addEventListener("click", () => window.settings?.minimize());
closeBtn.addEventListener("click", () => window.settings?.close());





async function saveAppearancePatch(patch: Partial<GeneralSettings>, successText = "已自动应用"): Promise<void> {
  try {
    setAppearanceSaveStatus("应用中…");
    await window.settings!.saveGeneral(patch);
    setAppearanceSaveStatus(successText, "is-ok");
  } catch (error) {
    console.error("自动应用外观设置失败:", error);
    setAppearanceSaveStatus("自动应用失败", "is-error");
  }
}

function getRuntimeSyncValue(): "off" | "local" | "llm" {
  const v = runtimeSyncSelect.querySelector<HTMLButtonElement>(".option-block.is-active")?.dataset.value; return v === "llm" ? "llm" : v === "local" ? "local" : "off";
}

function applyRuntimeSyncSelection(value: "off" | "local" | "llm"): void {
  runtimeSyncSelect.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
    const active = button.dataset.value === value;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  syncRuntimeNote();
}

function syncRuntimeNote(): void {
  runtimeSyncNote.classList.toggle("is-hidden", getRuntimeSyncValue() !== "llm");
}

function getStickerSizeValue(): "small" | "standard" | "large" {
  const value = stickerSizeSelect.querySelector<HTMLButtonElement>(".option-block.is-active")?.dataset.value;
  return value === "small" || value === "large" ? value : "standard";
}

function applyStickerSizeSelection(value: "small" | "standard" | "large"): void {
  stickerSizeSelect.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
    const active = button.dataset.value === value;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function applyLanguageSelection(language: "zh-CN"): void {
  languageSelect.querySelectorAll<HTMLButtonElement>(".language-option").forEach((button) => {
    const active = button.dataset.lang === language;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function applyOptionGroupValue(group: HTMLElement, value: string): void {
  group.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
    const active = button.dataset.value === value;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function getOptionGroupValue(group: HTMLElement, fallback: string): string {
  return group.querySelector<HTMLButtonElement>(".option-block.is-active")?.dataset.value ?? fallback;
}

function applyDefaultChatModeSelection(mode: DefaultChatMode): void {
  applyOptionGroupValue(defaultChatModeSelect, mode);
}

function getDefaultChatModeValue(): DefaultChatMode {
  return normalizeDefaultChatMode(getOptionGroupValue(defaultChatModeSelect, "chat"));
}

function applySegmentedOutputSelection(mode: SegmentedOutputMode): void {
  applyOptionGroupValue(segmentedOutputSelect, mode);
}

function getSegmentedOutputValue(): SegmentedOutputMode {
  return normalizeSegmentedOutputMode(getOptionGroupValue(segmentedOutputSelect, "off"));
}

function applyMobileMessageSegmentationSelection(mode: MobileMessageSegmentationMode): void {
  applyOptionGroupValue(mobileMessageSegmentationSelect, mode);
}

function getMobileMessageSegmentationValue(): MobileMessageSegmentationMode {
  return normalizeMobileMessageSegmentationMode(getOptionGroupValue(mobileMessageSegmentationSelect, "off"));
}

function applyProactiveChatSelection(mode: ProactiveChatMode): void {
  applyOptionGroupValue(proactiveChatSelect, mode);
}

function getProactiveChatValue(): ProactiveChatMode {
  return normalizeProactiveChatMode(getOptionGroupValue(proactiveChatSelect, "off"));
}

function applyProactiveDeliverySelection(target: ProactiveDeliveryTarget): void {
  applyOptionGroupValue(proactiveDeliverySelect, target);
}

function getProactiveDeliveryValue(): ProactiveDeliveryTarget {
  return normalizeProactiveDeliveryTarget(getOptionGroupValue(proactiveDeliverySelect, "local"));
}


function buildCustomStyleConfigFromModal(): CustomStyleConfig {
  if (!preferencesState.customStyleOverlay) return preferencesState.currentCustomStyleConfig;
  const diversityDriver = (
    preferencesState.customStyleOverlay.querySelector<HTMLInputElement>('input[name="custom-diversity"]:checked')?.value
    ?? "model-default"
  ) as DiversityPreference["driver"];
  const rawValue = Number((
    preferencesState.customStyleOverlay.querySelector<HTMLInputElement>("#custom-diversity-value")?.value
    ?? ""
  ).trim());
  const repetition = (
    preferencesState.customStyleOverlay.querySelector<HTMLInputElement>('input[name="custom-repetition"]:checked')?.value
    ?? "model-default"
  ) as RepetitionLevel;
  return normalizeCustomStyleConfig({
    diversity: diversityDriver === "model-default"
      ? { driver: "model-default" }
      : { driver: diversityDriver, value: rawValue },
    repetition,
  });
}

function ensureCustomStyleModal(): HTMLElement {
  if (preferencesState.customStyleOverlay) return preferencesState.customStyleOverlay;
  preferencesState.customStyleOverlay = document.createElement("div");
  preferencesState.customStyleOverlay.id = "custom-style-overlay";
  preferencesState.customStyleOverlay.className = "cy-modal-overlay is-hidden custom-style-overlay";
  preferencesState.customStyleOverlay.innerHTML = [
    '<div class="cy-modal custom-style-modal" role="dialog" aria-modal="true">',
    '  <div class="cy-modal__head"><span class="cy-modal__icon">🖊️</span><h3 class="cy-modal__title">自定义风格采样</h3></div>',
    '  <hr class="cy-modal__divider">',
    '  <div class="custom-style-modal__section">',
    '    <div class="custom-style-modal__label">多样性控制</div>',
    '    <label><input type="radio" name="custom-diversity" value="model-default"> 跟随模型</label>',
    '    <label><input type="radio" name="custom-diversity" value="temperature"> Temperature</label>',
    '    <label><input type="radio" name="custom-diversity" value="top-p"> Top-P</label>',
    '    <div class="custom-style-modal__value" id="custom-diversity-row"><span id="custom-diversity-label">Temperature</span><input id="custom-diversity-value" type="number" min="0" max="2" step="0.01"></div>',
    '  </div>',
    '  <div class="custom-style-modal__section">',
    '    <div class="custom-style-modal__label">重复控制</div>',
    '    <label><input type="radio" name="custom-repetition" value="model-default"> 跟随模型</label>',
    '    <label><input type="radio" name="custom-repetition" value="light"> 轻度抑制</label>',
    '    <label><input type="radio" name="custom-repetition" value="medium"> 中度抑制</label>',
    '    <label><input type="radio" name="custom-repetition" value="strong"> 重度抑制</label>',
    '  </div>',
    '  <div class="cy-modal__actions">',
    '    <button type="button" class="ghost-btn" id="custom-style-reset">恢复默认</button>',
    '    <button type="button" class="ghost-btn" id="custom-style-cancel">取消</button>',
    '    <button type="button" class="btn-primary" id="custom-style-save">保存</button>',
    '  </div>',
    '</div>',
  ].join("\n");
  document.body.appendChild(preferencesState.customStyleOverlay);

  const updateDiversityRow = () => {
    const driver = preferencesState.customStyleOverlay!.querySelector<HTMLInputElement>(
      'input[name="custom-diversity"]:checked',
    )?.value ?? "model-default";
    const row = preferencesState.customStyleOverlay!.querySelector<HTMLElement>("#custom-diversity-row");
    const label = preferencesState.customStyleOverlay!.querySelector<HTMLElement>("#custom-diversity-label");
    const value = preferencesState.customStyleOverlay!.querySelector<HTMLInputElement>("#custom-diversity-value");
    if (!row || !label || !value) return;
    row.hidden = driver === "model-default";
    label.textContent = driver === "top-p" ? "Top-P" : "Temperature";
    value.min = "0";
    value.max = driver === "top-p" ? "1" : "2";
  };
  preferencesState.customStyleOverlay.querySelectorAll<HTMLInputElement>('input[name="custom-diversity"]').forEach((input) => {
    input.addEventListener("change", updateDiversityRow);
  });
  preferencesState.customStyleOverlay.querySelector<HTMLButtonElement>("#custom-style-cancel")?.addEventListener("click", () => {
    preferencesState.customStyleOverlay?.classList.add("is-hidden");
  });
  preferencesState.customStyleOverlay.querySelector<HTMLButtonElement>("#custom-style-reset")?.addEventListener("click", () => {
    renderCustomStyleModal(DEFAULT_CUSTOM_STYLE);
  });
  preferencesState.customStyleOverlay.querySelector<HTMLButtonElement>("#custom-style-save")?.addEventListener("click", async () => {
    try {
      preferencesState.currentCustomStyleConfig = buildCustomStyleConfigFromModal();
      await window.settings!.saveGeneral({ customStyle: preferencesState.currentCustomStyleConfig });
      preferencesState.customStyleOverlay?.classList.add("is-hidden");
      setPreferencesSaveStatus("自定义风格已保存", "is-ok");
    } catch {
      setPreferencesSaveStatus("自定义风格保存失败", "is-error");
    }
  });
  return preferencesState.customStyleOverlay;
}

function renderCustomStyleModal(config: CustomStyleConfig): void {
  const overlay = ensureCustomStyleModal();
  const normalized = normalizeCustomStyleConfig(config);
  const driver = diversityDriverOf(normalized);
  const repetition = normalized.repetition;
  const driverInput = overlay.querySelector<HTMLInputElement>(
    `input[name="custom-diversity"][value="${driver}"]`,
  );
  const repetitionInput = overlay.querySelector<HTMLInputElement>(
    `input[name="custom-repetition"][value="${repetition}"]`,
  );
  if (driverInput) driverInput.checked = true;
  if (repetitionInput) repetitionInput.checked = true;
  const valueInput = overlay.querySelector<HTMLInputElement>("#custom-diversity-value");
  if (valueInput) valueInput.value = String(diversityValueOf(normalized));
  overlay.querySelectorAll<HTMLInputElement>('input[name="custom-diversity"]').forEach((input) => {
    input.dispatchEvent(new Event("change"));
  });
}

function openCustomStyleModal(): void {
  const overlay = ensureCustomStyleModal();
  renderCustomStyleModal(preferencesState.currentCustomStyleConfig);
  overlay.classList.remove("is-hidden");
}

function renderProactiveDeliveryVisibility(): void {
  proactiveDeliveryRow.hidden = getProactiveChatValue() !== "on";
}


function renderUiFont(font: UiFont): void {
  uiFontCurrent.textContent = font.kind === "custom" ? font.displayName : "思源黑体（默认）";
  uiFontResetButton.hidden = font.kind !== "custom";
}

function renderUiIcon(icon: UiIcon): void {
  uiIconSelect.querySelectorAll<HTMLButtonElement>(".appearance-icon-option").forEach((button) => {
    const active = button.dataset.icon === icon;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}




function fillPresetOptions(): void {
  if (!presetCards) return;
  presetCards.replaceChildren();
  for (const preset of MODEL_PRESETS) {
    if (preset.hiddenInPresetList) continue;
    const card = document.createElement("button");
    card.type = "button";
    card.className = "preset-card";
    card.dataset.provider = preset.providerName;
    if (preset.disabled) {
      card.classList.add("is-disabled");
      card.disabled = true;
    }

    // logo：有本地 SVG 用 img，没有（如 DeepSeek）用首字母文字占位
    const logoWrap = document.createElement("span");
    logoWrap.className = "preset-card__logo";
    if (preset.iconUrl) {
      const img = document.createElement("img");
      img.src = preset.iconUrl;
      img.alt = "";
      img.width = 24;
      img.height = 24;
      logoWrap.appendChild(img);
    } else {
      logoWrap.textContent = preset.shortName.charAt(0);
    }
    card.appendChild(logoWrap);

    const label = document.createElement("span");
    label.className = "preset-card__name";
    label.textContent = preset.shortName;
    if (preset.disabled) label.textContent += "（暂未适配）";
    card.appendChild(label);

    presetCards.appendChild(card);
  }
}

/** 标记当前选中的厂商卡片（替换原 presetSelect.value = ...） */
function setActivePresetCard(providerName: string): void {
  if (!presetCards) return;
  const cardProvider = getCustomEndpointMode(providerName)
    ? CUSTOM_ENDPOINT_PROVIDERS.cloud
    : providerName;
  presetCards.querySelectorAll(".preset-card").forEach((card) => {
    card.classList.toggle("is-active", (card as HTMLElement).dataset.provider === cardProvider);
  });
}

function findPreset(providerName: string): ModelPreset {
  // fallback：找不到匹配的预设时，回退到列表第一个可用项（当前是 MiniMax）。
  // 不直接返回 MODEL_PRESETS[0] 是为了未来若把首项改成 disabled 也仍然合法。
  const fallback = MODEL_PRESETS.find((preset) => !preset.disabled) ?? MODEL_PRESETS[0];
  return MODEL_PRESETS.find((preset) => preset.providerName === providerName) ?? fallback;
}

/**
 * 填充模型名输入框 + datalist 联想建议。
 * 模式按钮已删除——只有一个输入框，可手填，按方向键也能从厂商预设里选。
 */
function fillModelOptions(preset: ModelPreset, preferredModel?: string): void {
  // datalist 联想建议
  modelInputSuggestions.replaceChildren();
  for (const model of preset.mainModels) {
    const option = document.createElement("option");
    option.value = model;
    modelInputSuggestions.appendChild(option);
  }

  // 选中值：preferredModel 命中预设则用之；否则用预设首项；
  // preferredModel 不在预设里（用户自填型号）也保留显示，不强行清空。
  const fallback = preset.mainModels[0] ?? "";
  modelInput.value = preferredModel ?? fallback;
}

/**
 * 把"当前输入框里的值"快照到内存缓存里（perProvider）。
 * 切厂商前调用一次，避免覆盖丢失。
 */
function captureActiveProviderProfile(): void {
  if (!apiState.activeProvider) return;
  const cached = providerProfileCache[apiState.activeProvider];
  // reasoning 仍由 renderReasoningControls 写入 cache；这里只保留它（不动 mode/effort）
  providerProfileCache[apiState.activeProvider] = {
    baseUrl: baseUrlInput.value.trim(),
    model: getCurrentModelValue().trim(),
    apiKey: apiKeyInput.value.trim(),
    displayName: displayNameInput.value.trim(),
    explicitTransport: transportSelect.value as ProviderProfile["explicitTransport"],
    reasoning: cached?.reasoning,
  };
}

/** 模式按钮已删除——模型名永远从 input 读取。保留函数名供旧调用点用，语义不变。 */
function getCurrentModelValue(): string {
  return modelInput.value;
}

/** 多模态开关 UI：ON 时隐藏视觉配置区，OFF 时显示。不清空输入框值。 */
function applyMultimodalUI(): void {
  const on = multimodalToggle.checked;
  visionFieldsWrap.classList.toggle("is-hidden", on);
}

/** 填充视觉模型输入框的 datalist 候选。仅渲染候选，不修改 visionModelInput.value。 */
function fillVisionModelOptions(preset: ModelPreset): void {
  const datalist = document.getElementById("vision-model-suggestions") as HTMLDataListElement | null;
  if (!datalist) return;
  datalist.replaceChildren();
  for (const m of preset.visionModels ?? []) {
    const option = document.createElement("option");
    option.value = m;
    datalist.appendChild(option);
  }
}

const LOCAL_ENDPOINT_AUTH_FALLBACK = "__CYRENE_LOCAL_NO_AUTH__";

function getApiKeyForRequest(): string {
  const value = apiKeyInput.value.trim();
  return getCustomEndpointMode(apiState.activeProvider) === "local" && !value
    ? LOCAL_ENDPOINT_AUTH_FALLBACK
    : value;
}

function validateActiveCustomEndpoint(): string | null {
  const mode = getCustomEndpointMode(apiState.activeProvider);
  if (!mode) return null;
  return validateCustomEndpointConfig(mode, {
    baseUrl: baseUrlInput.value,
    model: getCurrentModelValue(),
    apiKey: apiKeyInput.value,
  });
}

function updateEndpointPreview(): void {
  const transport = transportSelect.value as ApiTransport;
  const baseUrl = baseUrlInput.value.trim();
  const defaultSuffix = transport === "anthropic" ? "/v1/messages" : "/chat/completions";

  if (!baseUrl) {
    endpointPreview.textContent = `程序会按所选协议自动追加请求路径（默认 ${defaultSuffix}）。`;
    return;
  }

  const endpoint = resolveApiEndpoint(baseUrl, transport);
  endpointPreview.textContent = endpoint.appendedSuffix
    ? `程序会自动追加 ${endpoint.appendedSuffix}；最终请求地址：${endpoint.url}`
    : `已填写完整接口地址，不再追加后缀；最终请求地址：${endpoint.url}`;
}

function applyCustomEndpointUI(preset: ModelPreset): void {
  const mode = getCustomEndpointMode(preset.providerName);
  customEndpointControls.hidden = mode === null;
  customEndpointOverrides.hidden = mode === null;
  transportSelect.disabled = false;

  if (!mode) {
    apiKeyLabel.textContent = "API Key";
    apiKeyHint.textContent = "填写对应平台创建的 API Key";
    apiKeyInput.placeholder = "sk-...";
    baseUrlInput.placeholder = "https://api.deepseek.com";
    modelInput.placeholder = "选厂商后自动填入，可手填覆盖";
    transportHint.textContent = "请按服务商提供的接口类型明确选择，程序不会自动识别协议。";
    baseUrlResetBtn.title = "重置为厂商默认 URL";
    apiNoteText.textContent = "选择模型预设后会自动填入 Provider、Base URL 和模型名；你只需要填写对应平台的 API Key。配置只保存在本机 Electron 用户数据目录。";
    return;
  }

  apiState.customEndpointMode = mode;
  const presentation = getCustomEndpointPresentation(mode);
  customEndpointControls.querySelectorAll<HTMLButtonElement>("[data-custom-endpoint-mode]").forEach((button) => {
    const active = button.dataset.apiState.customEndpointMode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  customEndpointSummary.textContent = mode === "local"
    ? "填写本机模型服务地址并明确选择接口协议；不扫描端口，也不探测模型能力。"
    : "接入兼容 OpenAI 或 Anthropic 协议的云端服务，能力由服务提供方决定。";
  apiKeyLabel.textContent = presentation.apiKeyOptional ? "API Key（可选）" : "API Key";
  apiKeyHint.textContent = presentation.apiKeyOptional
    ? "本地服务无需鉴权时可留空；如网关要求令牌，请在此填写"
    : "填写自定义服务或第三方代理提供的 API Key";
  apiKeyInput.placeholder = presentation.apiKeyOptional ? "无需鉴权时留空" : "sk-...";
  baseUrlInput.placeholder = presentation.baseUrlPlaceholder;
  modelInput.placeholder = "填写服务实际提供的模型 ID";
  transportHint.textContent = "请按自定义服务实际提供的 O 口或 A 口选择；程序不会自动探测。";
  baseUrlResetBtn.title = "清空自定义 Base URL";
  apiNoteText.textContent = "自定义端点按保守兼容模式运行。保存后请先测试连接；连接成功不代表结构化输出、工具调用或思考模式一定可用。";
}

function applyPreset(
  providerName: string,
  preferredModel?: string,
  preferredApiKey?: string,
  preferredBaseUrl?: string,
  preferredDisplayName?: string,
  preferredExplicitTransport?: ApiTransport,
  preferredVision?: { baseUrl: string; apiKey: string; model: string },
  preferredMultimodal?: boolean,
): void {
  const preset = findPreset(providerName);

  // 模式按钮已删除——ChatGPT / Claude 这种没预设型号的厂商，input 框空着让用户手填，
  // datalist 没建议也不影响（用户知道自己型号）。

  setActivePresetCard(preset.providerName);

  // 昵称：优先用传入的（用户自定义过）；否则用厂商 shortName 作默认。
  // 留空显示厂商短名——但这里主动填 shortName 让用户看到默认值，可改可清。
  displayNameInput.value = preferredDisplayName ?? preset.shortName;

  // baseUrl：仅对官方已确认的 A 口预设做协议配套切换；自定义 URL 永远不猜、不覆盖。
  const selectedTransport = preferredExplicitTransport ?? preset.transport;
  const restoredBaseUrl = preferredBaseUrl ?? preset.baseUrl;
  baseUrlInput.value = selectedTransport === "anthropic"
    && restoredBaseUrl === preset.baseUrl
    && preset.anthropicBaseUrl
      ? preset.anthropicBaseUrl
      : selectedTransport === "openai"
        && preset.anthropicBaseUrl
        && restoredBaseUrl === preset.anthropicBaseUrl
          ? preset.baseUrl
          : restoredBaseUrl;

  fillModelOptions(preset, preferredModel);

  // apiKey：优先用缓存；否则**显式清空**——避免上一家厂商的 key 残留在输入框里被用户误点保存。
  // 这是 v1 切厂商行为里的关键不变量：apiKey 永远只跟当前厂商绑定。
  const customMode = getCustomEndpointMode(preset.providerName);
  apiKeyInput.value = customMode === "local" && preferredApiKey === LOCAL_ENDPOINT_AUTH_FALLBACK
    ? ""
    : (preferredApiKey ?? "");

  // 协议优先恢复用户保存值，否则使用预设的明确默认值；永远不按 URL 猜测。
  transportSelect.value = selectedTransport;
  applyCustomEndpointUI(preset);
  updateEndpointPreview();

  if (preferredMultimodal !== undefined) {
    multimodalToggle.checked = preset.independentVision === true ? false : preferredMultimodal;
  } else {
    multimodalToggle.checked = preset.supportsVision === true && preset.independentVision !== true;
  }

  // 视觉三框：始终写入值（从 preferredVision 或 preset 默认），不受开关影响
  if (preferredVision) {
    visionBaseUrlInput.value = preferredVision.baseUrl;
    visionApiKeyInput.value = preferredVision.apiKey;
    visionModelInput.value = preferredVision.model;
  } else {
    visionBaseUrlInput.value = preset.visionBaseUrl ?? baseUrlInput.value;
    visionApiKeyInput.value = apiKeyInput.value;
    visionModelInput.value = preset.defaultVisionModel ?? modelInput.value;
  }

  fillVisionModelOptions(preset);

  // 官网链接：有 websiteUrl 就显示并指向，没有就隐藏。
  if (preset.websiteUrl) {
    presetWebsiteLink.href = preset.websiteUrl;
    presetWebsiteLink.title = `前往 ${preset.shortName} 官网`;
    presetWebsiteLink.style.display = "";
  } else {
    presetWebsiteLink.style.display = "none";
  }

  apiState.activeProvider = preset.providerName;
  applyMultimodalUI();
}

async function loadConfig(): Promise<void> {
  try {
    fillPresetOptions();
    const cfg = await window.settings!.getConfig();
    // 模式按钮已删除——mode 字段不再用 UI 控制，直接忽略 cfg.mode
    // 把 main 进程返回的 perProvider 灌进渲染端内存缓存，切厂商时用到
    if (cfg.perProvider && typeof cfg.perProvider === "object") {
      for (const [key, value] of Object.entries(cfg.perProvider)) {
        if (value && typeof value === "object") {
          providerProfileCache[key] = {
            baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : "",
            model: typeof value.model === "string" ? value.model : "",
            apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
            displayName: typeof (value as { displayName?: unknown }).displayName === "string"
              ? (value as { displayName: string }).displayName
              : undefined,
            explicitTransport: (value as { explicitTransport?: ApiTransport }).explicitTransport,
            reasoning: (value as { reasoning?: ReasoningPreference }).reasoning,
          };
        }
      }
    }
    const vision = cfg.vision;
    applyPreset(
      cfg.provider,
      cfg.model,
      cfg.apiKey,
      cfg.baseUrl,
      cfg.displayName,
      cfg.explicitTransport,
      vision
        ? {
            baseUrl: vision.baseUrl,
            apiKey: vision.apiKey,
            model: vision.model,
          }
        : undefined,
      cfg.multimodal,
    );
    applyRuntimeSyncSelection(cfg.runtimeSync);
    stickerEnabledInput.checked = cfg.stickerEnabled !== false;
    applyStickerSizeSelection(cfg.stickerSize);
    const threshold = cfg.stickerSimilarityThreshold ?? 0.55;
    stickerThresholdInput.value = String(threshold);
    stickerThresholdVal.textContent = threshold.toFixed(2);
    chatRequestTimeoutSecInput.value = String(cfg.chatRequestTimeoutSec ?? 300);
    maxIterationsInput.value = String(cfg.maxIterations ?? 12);
    maxReplansInput.value = String(cfg.maxReplans ?? 2);
    maxRefreshInput.value = String(cfg.maxRefresh ?? 1);
    perCallTimeoutSecInput.value = String(cfg.perCallTimeoutSec ?? 75);
    actionGateRepairBudgetSecInput.value = String(cfg.actionGateRepairBudgetSec ?? 10);
    if (embeddingDimensionsInput) {
      embeddingDimensionsInput.value = cfg.embeddingDimensions ? String(cfg.embeddingDimensions) : "";
    }
    toggleEnableThinking.checked = cfg.thinkingOverride === 1;
    toggleDisableThinking.checked = cfg.thinkingOverride === -1;
    toggleDisableMaxToken.checked = !!cfg.disableMaxToken;
    contextWindowInput.value = String(cfg.contextWindowTokens ?? 256000);

    // 视觉模型配置已并入 applyPreset（preferredVision 参数）。

    setSaveStatus("等待保存");
    setCyreneSaveStatus("等待保存");
  } catch {
    fillPresetOptions();
    // 默认厂商已从 DeepSeek 改为 MiniMax（v1 vendor adapter 第一家落地的）
    applyPreset("MiniMax（稀宇科技）");
    setSaveStatus("读取配置失败", "is-error");
    setCyreneSaveStatus("读取配置失败", "is-error");
  }
}

async function loadGeneralSettings(): Promise<void> {
  try {
    const cfg = await window.settings!.getGeneral();
    const cita = getCitaUiState({ enabled: cfg.citaEnabled, semanticEngine: cfg.citaSemanticEngine });
    citaEnabledInput.checked = cita.enabled;
    chatSocialContextEnabledInput.checked = normalizeChatSocialContextEnabled(cfg.chatSocialContextEnabled);
    citaEngineSelect.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
      const selected = button.dataset.value === cita.selectedEngine;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    const windowCornerRadius = normalizeWindowCornerRadius(cfg.windowCornerRadius);
    windowCornerRadiusInput.value = String(windowCornerRadius);
    windowCornerRadiusVal.textContent = `${windowCornerRadius}px`;
    applyWindowCornerRadius(windowCornerRadius);
    petAlwaysOnTopInput.checked = cfg.petAlwaysOnTop;
    petVisibleInput.checked = cfg.petVisible;
    petZoomInput.value = String(cfg.petZoom ?? 1);
    petZoomVal.textContent = Math.round((cfg.petZoom ?? 1) * 100) + "%";
    chatLineHeightInput.value = String(cfg.chatLineHeight ?? 1.75);
    chatLineHeightVal.textContent = (cfg.chatLineHeight ?? 1.75).toFixed(2);
    document.documentElement.style.setProperty("--rb-chat-line-height", String(cfg.chatLineHeight ?? 1.75));
    assistantBubbleEnabledInput.checked = cfg.assistantBubbleEnabled ?? true;
    chatParaSpacingInput.value = String(cfg.chatParaSpacing ?? 0.5);
    chatParaSpacingVal.textContent = (cfg.chatParaSpacing ?? 0.5).toFixed(2) + "em";
    document.documentElement.style.setProperty("--rb-chat-para-spacing", (cfg.chatParaSpacing ?? 0.5) + "em");
    disableGpuInput.checked = cfg.disableGpuElectron ?? false;
    sidebarVisibleInput.checked = cfg.sidebarVisible ?? true;
    tasksVisibleInput.checked = cfg.tasksVisible ?? true;
    launchAtLoginInput.checked = cfg.launchAtLogin;
    renderUiFont(normalizeUiFont(cfg.uiFont));
    renderUiIcon(normalizeUiIcon(cfg.uiIcon));
    applyDefaultChatModeSelection(normalizeDefaultChatMode(cfg.defaultChatMode));
    preferencesState.currentCustomStyleConfig = normalizeCustomStyleConfig(cfg.customStyle);
    applySegmentedOutputSelection(normalizeSegmentedOutputMode(cfg.segmentedOutputMode));
    applyMobileMessageSegmentationSelection(normalizeMobileMessageSegmentationMode(cfg.mobileMessageSegmentation));
    applyProactiveChatSelection(normalizeProactiveChatMode(cfg.proactiveChatMode));
    applyProactiveDeliverySelection(normalizeProactiveDeliveryTarget(cfg.proactiveDeliveryTarget));
    renderProactiveDeliveryVisibility();
    if (screenshotHotkeyInput) {
      screenshotHotkeyInput.value = cfg.screenshotHotkey ?? "Alt+Shift+S";
    }
    void window.settings!.channelsGetStatus()
      .then((status: unknown) => renderProactiveDeliveryAvailability(status as Record<string, { phase?: string }>))
      .catch(() => renderProactiveDeliveryAvailability({}));
    applyLanguageSelection("zh-CN");
    setPreferencesSaveStatus("等待保存");
    setAppearanceSaveStatus("等待保存");
    setGeneralSaveStatus("等待保存");
  } catch {
    setPreferencesSaveStatus("读取偏好失败", "is-error");
    setAppearanceSaveStatus("读取外观失败", "is-error");
    setGeneralSaveStatus("读取设置失败", "is-error");
  }
}


toggleEnableThinking.addEventListener("change", () => {
  if (toggleEnableThinking.checked) {
    toggleDisableThinking.checked = false;
  }
});
toggleDisableThinking.addEventListener("change", () => {
  if (toggleDisableThinking.checked) {
    toggleEnableThinking.checked = false;
  }
});

runtimeSyncSelect.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
  button.addEventListener("click", () => {
    const value = button.dataset.value as "off" | "local" | "llm";
    applyRuntimeSyncSelection(value);
    window.settings?.previewRuntimeSync(value);
    setCyreneSaveStatus("有未保存的更改");
  });
});

stickerEnabledInput.addEventListener("change", () => {
  setCyreneSaveStatus("有未保存的更改");
});

// 任何高级字段改动都标记"有未保存的更改"
[
  chatRequestTimeoutSecInput, maxIterationsInput, maxReplansInput, maxRefreshInput,
  perCallTimeoutSecInput, actionGateRepairBudgetSecInput,
].forEach((el) => {
  el.addEventListener("input", () => setCyreneSaveStatus("有未保存的更改"));
});

stickerSizeSelect.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
  button.addEventListener("click", () => {
    const value = button.dataset.value;
    applyStickerSizeSelection(value === "small" || value === "large" ? value : "standard");
    setCyreneSaveStatus("有未保存的更改");
  });
});

stickerThresholdInput.addEventListener("input", () => {
  stickerThresholdVal.textContent = parseFloat(stickerThresholdInput.value).toFixed(2);
  setCyreneSaveStatus("有未保存的更改");
});

openChromeGpu.addEventListener("click", () => {
  window.settings?.openChromeGpu();
});

disableGpuInput.addEventListener("change", () => {
  void window.settings?.saveGeneral({ disableGpuElectron: disableGpuInput.checked });
});

sidebarVisibleInput.addEventListener("change", () => {
  if (sidebarVisibleInput.checked) window.settings?.openSidebar();
  else window.settings?.closeSidebar();
  void window.settings?.saveGeneral({ sidebarVisible: sidebarVisibleInput.checked });
});

tasksVisibleInput.addEventListener("change", () => {
  if (tasksVisibleInput.checked) window.settings?.openTasks();
  else window.settings?.closeTasks();
  void window.settings?.saveGeneral({ tasksVisible: tasksVisibleInput.checked });
});

windowCornerRadiusInput.addEventListener("input", () => {
  const radius = applyWindowCornerRadius(windowCornerRadiusInput.value);
  windowCornerRadiusVal.textContent = `${radius}px`;
  setAppearanceSaveStatus("松开后自动应用");
});

windowCornerRadiusInput.addEventListener("change", () => {
  const windowCornerRadius = normalizeWindowCornerRadius(windowCornerRadiusInput.value);
  void saveAppearancePatch({ windowCornerRadius });
});

petAlwaysOnTopInput.addEventListener("change", () => {
  window.settings?.setPetAlwaysOnTop(petAlwaysOnTopInput.checked);
  setAppearanceSaveStatus("已应用", "is-ok");
});

uiFontImportButton.addEventListener("click", async () => {
  try {
    const sourcePath = await window.settings?.pickUiFont();
    if (!sourcePath) return;
    uiFontImportButton.disabled = true;
    setAppearanceSaveStatus("正在导入字体…");
    const font = await window.settings!.importUiFont(sourcePath);
    renderUiFont(font);
    setAppearanceSaveStatus("字体已应用", "is-ok");
  } catch (error) {
    console.error("导入字体失败:", error);
    setAppearanceSaveStatus("导入字体失败", "is-error");
  } finally {
    uiFontImportButton.disabled = false;
  }
});

uiFontResetButton.addEventListener("click", async () => {
  try {
    uiFontResetButton.disabled = true;
    const font = await window.settings!.resetUiFont();
    renderUiFont(font);
    setAppearanceSaveStatus("已恢复思源黑体", "is-ok");
  } catch (error) {
    console.error("恢复默认字体失败:", error);
    setAppearanceSaveStatus("恢复默认字体失败", "is-error");
  } finally {
    uiFontResetButton.disabled = false;
  }
});

uiIconSelect.querySelectorAll<HTMLButtonElement>(".appearance-icon-option").forEach((button) => {
  button.addEventListener("click", async () => {
    const icon = normalizeUiIcon(button.dataset.icon);
    try {
      await window.settings!.saveGeneral({ uiIcon: icon });
      renderUiIcon(icon);
      setAppearanceSaveStatus("图标已应用", "is-ok");
    } catch (error) {
      console.error("应用图标失败:", error);
      setAppearanceSaveStatus("应用图标失败", "is-error");
    }
  });
});

petVisibleInput.addEventListener("change", () => {
  window.settings?.setPetVisible(petVisibleInput.checked);
  setAppearanceSaveStatus("已应用", "is-ok");
});
petZoomInput.addEventListener("input", () => {
  petZoomVal.textContent = Math.round(Number(petZoomInput.value) * 100) + "%";
});
petZoomInput.addEventListener("change", () => {
  window.settings?.setPetZoom(Number(petZoomInput.value));
  setAppearanceSaveStatus("已应用", "is-ok");
});

// 行间距滑块
chatLineHeightInput.addEventListener("input", () => {
  const val = Number(chatLineHeightInput.value);
  chatLineHeightVal.textContent = val.toFixed(2);
  document.documentElement.style.setProperty("--rb-chat-line-height", String(val));
  setAppearanceSaveStatus("松开后自动应用");
});
chatLineHeightInput.addEventListener("change", () => {
  void saveAppearancePatch({ chatLineHeight: Number(chatLineHeightInput.value) });
});
assistantBubbleEnabledInput.addEventListener("change", () => {
  void saveAppearancePatch({ assistantBubbleEnabled: assistantBubbleEnabledInput.checked });
});
// 段间距滑块
chatParaSpacingInput.addEventListener("input", () => {
  const val = Number(chatParaSpacingInput.value);
  chatParaSpacingVal.textContent = val.toFixed(2) + "em";
  document.documentElement.style.setProperty("--rb-chat-para-spacing", val + "em");
  setAppearanceSaveStatus("松开后自动应用");
});
chatParaSpacingInput.addEventListener("change", () => {
  void saveAppearancePatch({ chatParaSpacing: Number(chatParaSpacingInput.value) });
});

defaultChatModeSelect.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
  button.addEventListener("click", () => {
    applyDefaultChatModeSelection(normalizeDefaultChatMode(button.dataset.value));
    setPreferencesSaveStatus("有未保存的更改");
  });
});

segmentedOutputSelect.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
  button.addEventListener("click", () => {
    applySegmentedOutputSelection(normalizeSegmentedOutputMode(button.dataset.value));
    setPreferencesSaveStatus("有未保存的更改");
  });
});

mobileMessageSegmentationSelect.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
  button.addEventListener("click", () => {
    applyMobileMessageSegmentationSelection(normalizeMobileMessageSegmentationMode(button.dataset.value));
    setPreferencesSaveStatus("有未保存的更改");
  });
});

proactiveChatSelect.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
  button.addEventListener("click", () => {
    applyProactiveChatSelection(normalizeProactiveChatMode(button.dataset.value));
    renderProactiveDeliveryVisibility();
    setPreferencesSaveStatus("有未保存的更改");
  });
});

proactiveDeliverySelect.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.disabled) return;
    applyProactiveDeliverySelection(normalizeProactiveDeliveryTarget(button.dataset.value));
    setPreferencesSaveStatus("有未保存的更改");
  });
});

citaEnabledInput.addEventListener("change", () => {
  setPreferencesSaveStatus("有未保存的更改");
});

// ── 截图热键捕获 ──
// 聚焦时临时挂起全局快捷键（防止录入时触发截图），失焦恢复。
const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta"]);

screenshotHotkeyInput?.addEventListener("focus", async () => {
  await window.settings!.beginScreenshotHotkeyCapture();
});

screenshotHotkeyInput?.addEventListener("blur", async () => {
  await window.settings!.endScreenshotHotkeyCapture();
});

screenshotHotkeyInput?.addEventListener("keydown", (e) => {
  e.preventDefault();

  if (e.key === "Escape") {
    screenshotHotkeyInput!.blur();
    return;
  }
  if (e.key === "Enter") {
    screenshotHotkeyInput!.blur();
    return;
  }

  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Super");

  // 纯修饰键不提交
  if (MODIFIER_KEYS.has(e.key)) return;

  const keyName = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  parts.push(keyName);

  // 至少需要一个修饰键
  if (parts.length < 2) return;

  screenshotHotkeyInput!.value = parts.join("+");
  setPreferencesSaveStatus("有未保存的更改");
});

chatSocialContextEnabledInput.addEventListener("change", () => {
  setPreferencesSaveStatus("有未保存的更改");
});

customStyleSamplingBtn?.addEventListener("click", () => {
  openCustomStyleModal();
});

customStylePromptBtn?.addEventListener("click", async () => {
  try {
    const result = await window.settings?.openCustomStylePrompt?.();
    if (!result?.ok) {
      setPreferencesSaveStatus("打开 Prompt 文件失败", "is-error");
      return;
    }
    setPreferencesSaveStatus("已打开 Prompt 文件位置", "is-ok");
  } catch {
    setPreferencesSaveStatus("打开 Prompt 文件失败", "is-error");
  }
});

preferencesForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setPreferencesSaveStatus("保存中…");
  try {
    await window.settings!.saveGeneral({
      citaEnabled: citaEnabledInput.checked,
      citaSemanticEngine: "remote",
      chatSocialContextEnabled: chatSocialContextEnabledInput.checked,
      defaultChatMode: "chat",
      segmentedOutputMode: "off",
      mobileMessageSegmentation: getMobileMessageSegmentationValue(),
      proactiveChatMode: getProactiveChatValue(),
      proactiveDeliveryTarget: getProactiveDeliveryValue(),
      screenshotHotkey: screenshotHotkeyInput?.value || "Alt+Shift+S",
    });
    setPreferencesSaveStatus("已保存", "is-ok");
  } catch {
    setPreferencesSaveStatus("保存失败", "is-error");
  }
});

openStickerManagerBtn.addEventListener("click", async () => {
  console.log("[settings] open sticker manager clicked");
  try {
    const result = await window.settings?.openStickerManager();
    if (!result?.ok) {
      console.error("[settings] open sticker manager failed", result?.error);
      window.alert("表情包管理窗口打开失败，请查看终端日志。" + (result?.error ? `\n${result.error}` : ""));
    }
  } catch (error) {
    console.error("[settings] open sticker manager error", error);
    window.alert("表情包管理窗口打开失败，请查看终端日志。");
  }
});

// ── 添加表情包弹窗 ──


function openStickerAddModal(): void {
  preferencesState.stickerAddPickedPath = null;
  stickerAddFileName.textContent = "未选择";
  stickerAddId.value = "";
  stickerAddDesc.value = "";
  stickerAddPhrases.value = "";
  stickerAddError.classList.add("is-hidden");
  stickerAddOverlay.classList.remove("is-hidden");
}

function closeStickerAddModal(): void {
  stickerAddOverlay.classList.add("is-hidden");
}

addStickerBtn.addEventListener("click", openStickerAddModal);
stickerAddCancel.addEventListener("click", closeStickerAddModal);

stickerAddPickBtn.addEventListener("click", async () => {
  const filePath = await window.settings?.stickerPickFile?.();
  if (filePath) {
    preferencesState.stickerAddPickedPath = filePath;
    const name = filePath.split(/[\\/]/).pop() || filePath;
    stickerAddFileName.textContent = name;
    if (!stickerAddId.value) {
      const baseName = name.replace(/\.[^.]+$/, "");
      stickerAddId.value = baseName.replace(/[^a-zA-Z0-9_-]/g, "");
    }
  }
});

stickerAddConfirm.addEventListener("click", async () => {
  stickerAddError.classList.add("is-hidden");

  if (!preferencesState.stickerAddPickedPath) {
    stickerAddError.textContent = "请先选择图片文件";
    stickerAddError.classList.remove("is-hidden");
    return;
  }
  const id = stickerAddId.value.trim();
  if (!id) {
    stickerAddError.textContent = "请填写英文名称";
    stickerAddError.classList.remove("is-hidden");
    return;
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    stickerAddError.textContent = "名称只能用英文字母、数字、下划线和连字符";
    stickerAddError.classList.remove("is-hidden");
    return;
  }
  const description = stickerAddDesc.value.trim();
  if (!description) {
    stickerAddError.textContent = "请填写图片描述";
    stickerAddError.classList.remove("is-hidden");
    return;
  }
  const phrases = stickerAddPhrases.value.split("\n").map((s) => s.trim()).filter(Boolean);
  if (phrases.length === 0) {
    stickerAddError.textContent = "请至少写一行相近语义";
    stickerAddError.classList.remove("is-hidden");
    return;
  }

  try {
    await window.settings?.stickerAdd?.({ sourcePath: preferencesState.stickerAddPickedPath, id, description, phrases });
    closeStickerAddModal();
  } catch (err) {
    stickerAddError.textContent = "添加失败：" + (err as Error).message;
    stickerAddError.classList.remove("is-hidden");
  }
});

// ── MCP Server 管理 UI ──────────────────────────────────────
console.log("[settings] plugin-add-btn 查询结果:", pluginAddBtn ? "找到" : "未找到");


pluginAddBtn?.addEventListener("click", async () => {
  console.log("[settings] ＋ 按钮被点击，弹出输入框…");
  const command = await showInputModal({
    title: "添加 MCP Server",
    message: "输入启动命令，例如：node C:\\my-mcp-server\\index.js",
    placeholder: "node path\\to\\server.js --flag",
    icon: "🧩",
  });
  if (!command || !command.trim()) {
    console.log("[settings] 用户取消或命令为空");
    return;
  }

  const nameInput = await showInputModal({
    title: "MCP Server 名称",
    message: "给这个 MCP server 起个名字（仅用于展示）",
    placeholder: "例如：天气工具",
    icon: "🏷️",
  });
  const name = (nameInput && nameInput.trim()) || "未命名 MCP";
  const serverId = "mcp-" + Date.now();
  const parsed = parseCommandLine(command.trim());
  if (!parsed.command) {
    await showModal({ title: "添加失败", message: "请输入有效的启动命令", icon: "⚠️" });
    return;
  }

  console.log("[settings] 添加 MCP server:", name, serverId, command.trim());

  try {
    const result = await window.settings?.addMcpServer?.({
      id: serverId,
      name: name,
      transport: "stdio",
      command: parsed.command,
      args: parsed.args,
    });

    if (result?.ok) {
      console.log("[settings] MCP server 添加成功，工具数:", result.toolIds?.length);
      await showModal({
        title: "添加成功",
        message: '"' + name + '" 已连接，发现 ' + (result.toolIds?.length || 0) + " 个工具。详情见终端日志。",
        icon: "✅",
      });
    } else {
      console.error("[settings] MCP server 添加失败:", result?.error);
      await showModal({
        title: "添加失败",
        message: (result?.error || "未知错误") + "（详情见终端日志）",
        icon: "⚠️",
      });
    }
  } catch (err) {
    console.error("[settings] MCP server 添加异常:", err);
    await showModal({
      title: "添加异常",
      message: "调用过程中发生错误，详情见终端日志。",
      icon: "⚠️",
    });
  }
});

clearChatHistoryBtn.addEventListener("click", async () => {
  if (!window.confirm("清空所有聊天会话？\n此操作会删除全部历史对话，无法恢复。")) return;
  try {
    const sessions = await window.chatStore?.list();
    if (sessions && sessions.length > 0) {
      // 串行删除（store 不支持批量删除；会话数量不会大，可接受）
      for (const s of sessions) {
        await window.chatStore?.delete(s.id);
      }
    }
    setGeneralSaveStatus("所有聊天会话已清空", "is-ok");
  } catch (err) {
    console.warn("[settings] 清空聊天会话失败:", err);
    setGeneralSaveStatus("清空失败，请查看终端日志", "is-error");
  }
});

presetCards?.addEventListener("click", (e) => {
  const card = (e.target as HTMLElement).closest(".preset-card") as HTMLElement | null;
  if (!card || card.classList.contains("is-disabled")) return;
  const cardProviderName = card.dataset.provider;
  if (!cardProviderName) return;

  // 切厂商前先把当前厂商的输入值快照进缓存，避免覆盖丢失
  captureActiveProviderProfile();

  const providerName = getCustomEndpointMode(cardProviderName)
    ? getCustomEndpointProvider(apiState.customEndpointMode)
    : cardProviderName;
  // 从缓存里取目标厂商的旧配置；没有缓存就用 preset 默认值
  const cached = providerProfileCache[providerName];
  applyPreset(
    providerName,
    cached?.model,
    cached?.apiKey,
    cached?.baseUrl,
    cached?.displayName,
    cached?.explicitTransport,
  );
  setSaveStatus(cached ? "已切回上次配置" : "已应用预设，填写 API Key 后保存");
});

customEndpointControls?.addEventListener("click", (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-custom-endpoint-mode]");
  const nextMode = button?.dataset.apiState.customEndpointMode as CustomEndpointMode | undefined;
  if (!nextMode || nextMode === apiState.customEndpointMode) return;

  captureActiveProviderProfile();
  apiState.customEndpointMode = nextMode;
  const providerName = getCustomEndpointProvider(nextMode);
  const cached = providerProfileCache[providerName];
  applyPreset(
    providerName,
    cached?.model,
    cached?.apiKey,
    cached?.baseUrl,
    cached?.displayName,
    cached?.explicitTransport,
  );
  setSaveStatus(cached ? "已切回上次配置" : nextMode === "local"
    ? "请填写本地服务地址和模型 ID"
    : "请填写云端服务地址、API Key 和模型 ID");
});

const CUSTOM_ENDPOINT_GUIDE_BODY = [
  '<section class="custom-endpoint-guide-section">',
  '  <h4>官方云端模型</h4>',
  '  <p>从列表选择已适配厂商（OpenAI、Claude、Kimi、DeepSeek、MiniMax、智谱 GLM、通义千问、豆包、小米 MiMo），填写对应平台获取的 API Key 即可。Base URL 与推荐模型 ID 已预填。</p>',
  '  <p class="custom-endpoint-guide-note">同一厂商的不同模型在结构化输出、工具调用和思考模式等能力上可能存在差异，请优先使用列表内的推荐型号。</p>',
  '</section>',
  '<section class="custom-endpoint-guide-section">',
  '  <h4>自定义端点 <span>高级</span></h4>',
  '  <p>可接入提供 OpenAI 或 Anthropic 兼容接口的云端服务、本地推理服务或第三方代理。请明确选择 API 协议，并填写 Base URL 和服务实际提供的模型 ID。</p>',
  '  <div class="custom-endpoint-guide-warning"><strong>本地模型与自定义端点不在官方技术支持范围内。</strong>实际能力取决于推理服务的具体实现，系统不会扫描端口、探测模型或自动升级能力档位。接入第三方代理前，请自行评估隐私和数据安全风险。</div>',
  '  <p>建议保存后点击“<strong>测试连接</strong>”进行基础验证。连接成功仅表示服务能够响应，不代表结构化输出、工具调用和思考模式一定可用。</p>',
  '  <p class="custom-endpoint-guide-security">🔒 你的 API Key 仅存储在本地设备，不会上传至昔涟的服务器。</p>',
  '</section>',
  '<section class="custom-endpoint-guide-section custom-endpoint-faq">',
  '  <h4>常见问题</h4>',
  '  <details>',
  '    <summary>本地模型回复格式异常</summary>',
  '    <p>许多本地推理服务缺少稳定的约束解码或完整协议实现，偶尔输出多余文本、Markdown 围栏或不完整 JSON 属于常见情况。系统会使用本地校验与自动修复兜底；如需更高稳定性，建议选择官方云端模型。</p>',
  '  </details>',
  '  <details>',
  '    <summary>MiniMax 思考模式失效</summary>',
  '    <p>MiniMax 在 JSON 模式下不建议同时启用思考。系统会依据已验证的配置自动处理这一冲突，以结构化结果的稳定性为优先。</p>',
  '  </details>',
  '  <details>',
  '    <summary>Claude 配置项比其他厂商少</summary>',
  '    <p>Claude 的接口规范与 OpenAI 兼容接口不同，部分参数和结构化输出档位并不适用，因此页面显示的配置项会更少。这属于正常差异，不影响已适配能力的使用。</p>',
  '  </details>',
  '</section>',
].join("\n");

customEndpointGuideBtn?.addEventListener("click", () => {
  void showHtmlModal({
    title: "模型服务接入说明",
    icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 10.5V17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="7.25" r="1.1" fill="currentColor"/></svg>',
    htmlBody: CUSTOM_ENDPOINT_GUIDE_BODY,
  });
});

// ── 模型厂商 Work 流程适配说明 ──────────────────────────────
// 展示各厂商结构化输出档位与实测兼容性；「详细文档」在 app 内本地渲染完整实测报告。
// 模型厂商 Work 流程适配（手写 HTML，避免引入 markdown 渲染依赖）
const WORK_FLOW_COMPAT_MD = `
<h2>模型兼容性</h2>
<blockquote>Cyrene 会根据不同厂商自动选择对应的 Structured Output Profile。</blockquote>
<table>
  <thead>
    <tr><th>厂商</th><th>支持状态</th><th>档位</th><th>已实测模型</th><th>说明</th></tr>
  </thead>
  <tbody>
    <tr><td>OpenAI</td><td>⚠️ 文档适配</td><td>A</td><td>-</td><td>已完成官方协议适配，等待实测。</td></tr>
    <tr><td>Claude</td><td>⚠️ 文档适配</td><td>A</td><td>-</td><td>已完成官方协议适配，等待实测。</td></tr>
    <tr><td>豆包</td><td>✅ 已实测</td><td>A</td><td>Seed 2.1 Turbo / Pro</td><td>推荐使用，完整 Work 流程稳定。</td></tr>
    <tr><td>Kimi</td><td>✅ 已实测</td><td>A</td><td>K2.6、K2.7 Code</td><td>推荐普通 API，Coding 端点不建议用于 Work。</td></tr>
    <tr><td>DeepSeek</td><td>✅ 已实测</td><td>B</td><td>V4 Flash、V4 Pro</td><td>推荐，速度快、稳定。</td></tr>
    <tr><td>Qwen</td><td>✅ 已实测</td><td>B</td><td>Qwen3.7 Max</td><td>推荐，表现稳定。</td></tr>
    <tr><td>GLM</td><td>✅ 已实测</td><td>B</td><td>GLM 5.1、5.2</td><td>推荐，4.7 不建议。</td></tr>
    <tr><td>MiMo</td><td>✅ 已实测</td><td>B</td><td>MiMo 2.5、2.5 Pro</td><td>推荐，表现稳定。</td></tr>
    <tr><td>MiniMax</td><td>✅ 已实测</td><td>M</td><td>MiniMax M3</td><td>推荐，需使用 M 档适配。</td></tr>
    <tr><td>其他模型</td><td>⚠️ 文档适配</td><td>D</td><td>-</td><td>使用通用兼容模式，请自行验证。</td></tr>
  </tbody>
</table>
<h3>档位说明</h3>
<ul>
  <li><strong>A</strong>：原生 JSON Schema / Function Calling</li>
  <li><strong>B</strong>：JSON Object + 本地校验</li>
  <li><strong>M</strong>：MiniMax 专用适配</li>
  <li><strong>D</strong>：通用兼容模式（未知模型 / 自定义端点）</li>
</ul>
`.trim();

function buildWorkFlowAdaptBody(): string {
  return [
    '<div class="custom-endpoint-guide-warning work-flow-adapt-meta">',
    "  <strong>模型厂商 Work 流程适配</strong>",
    '  <span class="work-flow-adapt-date">最新更新于 2026/7/24</span>',
    "</div>",
    `<div class="work-flow-adapt-table">${WORK_FLOW_COMPAT_MD}</div>`,
  ].join("\n");
}

workFlowAdaptBtn?.addEventListener("click", () => {
  void showHtmlModal({
    title: "模型厂商 Work 流程适配",
    icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 10.5V17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="7.25" r="1.1" fill="currentColor"/></svg>',
    htmlBody: buildWorkFlowAdaptBody(),
  });
});

// 测试连接按钮：调用厂商 adapter 的真实连接测试
if (testConnectionBtn) {
  testConnectionBtn.addEventListener("click", async () => {
    const provider = apiState.activeProvider;
    const baseUrl = baseUrlInput.value;
    const model = getCurrentModelValue().trim();
    const customValidationError = validateActiveCustomEndpoint();
    if (customValidationError) {
      setSaveStatus(customValidationError, "is-error");
      return;
    }
    const apiKey = getApiKeyForRequest();
    if (!baseUrl) { setSaveStatus("请先填写 API URL 再测试", "is-error"); return; }
    if (!model) { setSaveStatus("请先选择/填写模型再测试", "is-error"); return; }
    if (!await saveTimeoutSettings(true)) {
      return;
    }
    setSaveStatus("测试连接中…");
    testConnectionBtn.disabled = true;
    try {
      const result = await window.settings!.testConnection({
        provider,
        baseUrl,
        model,
        apiKey,
        explicitTransport: transportSelect.value as ProviderProfile["explicitTransport"],
        reasoning: providerProfileCache[apiState.activeProvider]?.reasoning,
      });
      if (result.ok) setSaveStatus("连接成功 " + result.latency + "ms · " + (result.sample ?? ""), "is-ok");
      else setSaveStatus("连接失败：" + (result.error ?? "未知错误"), "is-error");
    } catch (e) {
      setSaveStatus("连接失败：" + (e instanceof Error ? e.message : String(e)), "is-error");
    } finally {
      testConnectionBtn.disabled = false;
    }
  });
}

// ── 视觉模型配置事件 ──────────────────────────────────────
// 多模态开关：ON 隐藏视觉配置区，OFF 显示
multimodalToggle.addEventListener("change", () => {
  applyMultimodalUI();
  setSaveStatus("有未保存的更改");
});

// Base URL 重置按钮：一键复原厂商默认 baseUrl
baseUrlResetBtn.addEventListener("click", () => {
  const preset = findPreset(apiState.activeProvider);
  if (preset) {
    baseUrlInput.value = transportSelect.value === "anthropic" && preset.anthropicBaseUrl
      ? preset.anthropicBaseUrl
      : preset.baseUrl;
    updateEndpointPreview();
    setSaveStatus("已重置为厂商默认 URL");
  }
});

baseUrlInput.addEventListener("input", updateEndpointPreview);
transportSelect.addEventListener("change", () => {
  const preset = findPreset(apiState.activeProvider);
  const currentBaseUrl = baseUrlInput.value.trim().replace(/\/$/, "");
  const knownPresetUrls = [preset.baseUrl, preset.anthropicBaseUrl]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.replace(/\/$/, ""));
  if (knownPresetUrls.includes(currentBaseUrl)) {
    if (transportSelect.value === "anthropic" && preset.anthropicBaseUrl) {
      baseUrlInput.value = preset.anthropicBaseUrl;
    } else if (transportSelect.value === "openai") {
      baseUrlInput.value = preset.baseUrl;
    }
  }
  updateEndpointPreview();
  if (transportSelect.value === "anthropic" && !preset.anthropicBaseUrl && preset.transport !== "anthropic") {
    transportHint.textContent = "该厂商的 A口地址未内置；请按服务商文档填写 A口 Base URL，程序只追加 /v1/messages。";
  }
  setSaveStatus("有未保存的更改");
});

// 测试视觉模型按钮（仅在多模态开关 OFF 时可见）
testVisionBtn.addEventListener("click", async () => {
  const synced = isVisionSynced();
  const baseUrl = synced ? baseUrlInput.value : visionBaseUrlInput.value;
  const apiKey = synced ? apiKeyInput.value : visionApiKeyInput.value;
  const model = synced ? getCurrentModelValue() : visionModelInput.value;
  if (!baseUrl) { visionTestStatus.textContent = "请先填写 API URL"; return; }
  if (!model) { visionTestStatus.textContent = "请先填写视觉型号"; return; }
  visionTestStatus.textContent = "测试中…";
  testVisionBtn.disabled = true;
  try {
    const result = await window.settings!.testVision?.({ baseUrl, apiKey, model });
    if (result?.ok) visionTestStatus.textContent = "✅ 连接成功 " + result.latency + "ms · " + (result.sample ?? "");
    else visionTestStatus.textContent = "❌ " + (result?.error ?? "未知错误");
  } catch (e) {
    visionTestStatus.textContent = "❌ " + (e instanceof Error ? e.message : String(e));
  } finally {
    testVisionBtn.disabled = false;
  }
});




apiRuntimeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setRuntimeSaveStatus("保存中…");
  try {
    const parsedTimeoutSec = Math.max(30, Math.min(1800, parseInt(chatRequestTimeoutSecInput.value, 10) || 300));
    const parsedMaxIterations = Math.max(5, Math.min(30, parseInt(maxIterationsInput.value, 10) || 12));
    const parsedMaxReplans = Math.max(1, Math.min(5, parseInt(maxReplansInput.value, 10) || 2));
    const parsedMaxRefresh = Math.max(0, Math.min(3, parseInt(maxRefreshInput.value, 10) || 1));
    const parsedPerCallSec = Math.max(30, Math.min(120, parseInt(perCallTimeoutSecInput.value, 10) || 75));
    const parsedAgSec = Math.max(5, Math.min(40, parseInt(actionGateRepairBudgetSecInput.value, 10) || 10));
    await window.settings!.saveConfig({
      chatRequestTimeoutSec: parsedTimeoutSec,
      maxIterations: parsedMaxIterations,
      maxReplans: parsedMaxReplans,
      maxRefresh: parsedMaxRefresh,
      perCallTimeoutSec: parsedPerCallSec,
      actionGateRepairBudgetSec: parsedAgSec,
    });
    // 同步超时到 TimeoutSettings（秒→毫秒）
    await window.settings!.saveTimeoutSettings({
      chatRequestTimeout: parsedTimeoutSec * 1000,
      perRoundTimeout: parsedPerCallSec * 1000,
      profileTotalBudgetMs: parseN1SecToMsOrThrow(timeoutProfileTotalBudgetInput.value, "Action Gate 总阶段时限"),
      profilePerAttemptTimeoutMs: parseN1SecToMsOrThrow(timeoutProfilePerAttemptInput.value, "阶段内单次尝试超时"),
      profileMinimumRemainingBudgetMs: parseN1SecToMsOrThrow(timeoutProfileRemainingInput.value, "最小剩余时间"),
    });
    setRuntimeSaveStatus("已保存", "is-ok");
  } catch {
    setRuntimeSaveStatus("保存失败", "is-error");
  }
});

apiTimeoutForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setTimeoutSaveStatus("保存中…");
  try {
    await saveTimeoutSettings(false);
    setTimeoutSaveStatus("已保存", "is-ok");
  } catch {
    setTimeoutSaveStatus("保存失败", "is-error");
  }
});

appearanceForm.addEventListener("submit", (e) => {
  e.preventDefault();
});

generalForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setGeneralSaveStatus("保存中…");
  try {
    await window.settings!.saveGeneral({
      disableGpuElectron: disableGpuInput.checked,
      sidebarVisible: sidebarVisibleInput.checked,
      tasksVisible: tasksVisibleInput.checked,
      launchAtLogin: launchAtLoginInput.checked,
      language: "zh-CN",
    });
    setGeneralSaveStatus("已保存", "is-ok");
  } catch {
    setGeneralSaveStatus("保存失败", "is-error");
  }
});

cyrenePanel.addEventListener("submit", async (e) => {
  e.preventDefault();
  setCyreneSaveStatus("保存中…");
  try {
    const parsedTimeoutSec = Math.max(30, Math.min(1800, parseInt(chatRequestTimeoutSecInput.value, 10) || 300));
    const parsedMaxIterations = Math.max(5, Math.min(30, parseInt(maxIterationsInput.value, 10) || 12));
    const parsedMaxReplans = Math.max(1, Math.min(5, parseInt(maxReplansInput.value, 10) || 2));
    const parsedMaxRefresh = Math.max(0, Math.min(3, parseInt(maxRefreshInput.value, 10) || 1));
    const parsedPerCallSec = Math.max(30, Math.min(120, parseInt(perCallTimeoutSecInput.value, 10) || 75));
    const parsedAgSec = Math.max(5, Math.min(40, parseInt(actionGateRepairBudgetSecInput.value, 10) || 10));
    const rawDim = embeddingDimensionsInput?.value?.trim();
    const parsedNum = rawDim ? Number(rawDim) : NaN;
    const parsedDim = Number.isFinite(parsedNum) && parsedNum > 0
      ? Math.max(1, Math.min(65536, Math.round(parsedNum)))
      : undefined;
    await window.settings!.saveConfig({
      runtimeSync: getRuntimeSyncValue(),
      stickerEnabled: stickerEnabledInput.checked,
      stickerSize: getStickerSizeValue(),
      stickerSimilarityThreshold: parseFloat(stickerThresholdInput.value),
      chatRequestTimeoutSec: parsedTimeoutSec,
      maxIterations: parsedMaxIterations,
      maxReplans: parsedMaxReplans,
      maxRefresh: parsedMaxRefresh,
      perCallTimeoutSec: parsedPerCallSec,
      actionGateRepairBudgetSec: parsedAgSec,
      embeddingDimensions: parsedDim && parsedDim > 0 ? parsedDim : undefined,
    });
    setCyreneSaveStatus("已保存", "is-ok");
  } catch {
    setCyreneSaveStatus("保存失败", "is-error");
  }
});

apiForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const customValidationError = validateActiveCustomEndpoint();
  if (customValidationError) {
    setSaveStatus(customValidationError, "is-error");
    return;
  }
  setSaveStatus("保存中…");
  try {
    if (!await saveTimeoutSettings(true)) {
      return;
    }
    // 保存前把当前输入快照进 perProvider 缓存（main 进程也会做一次，但渲染端先做一遍，
    // 是为了下一次切厂商再切回来不依赖磁盘往返）
    captureActiveProviderProfile();
    // mode 字段在 UI 层已删除，但仍传给 main 进程保留向后兼容（旧配置文件可能有该字段）。
    // 默认 "manual"（baseUrl 永远可改、模型名永远可填，行为等同原 Manual）。
    await window.settings!.saveConfig({
      mode: "manual",
      provider: apiState.activeProvider,
      displayName: displayNameInput.value.trim(),
      baseUrl: baseUrlInput.value.trim(),
      model: getCurrentModelValue().trim(),
      apiKey: getApiKeyForRequest(),
      explicitTransport: transportSelect.value as ApiTransport,
      reasoning: providerProfileCache[apiState.activeProvider]?.reasoning,
      perProvider: { ...providerProfileCache },
      multimodal: multimodalToggle.checked,
      // 视觉配置始终传三框值，不论开关状态（开关 ON 时保留但不使用）
      vision: {
        baseUrl: visionBaseUrlInput.value.trim(),
        apiKey: visionApiKeyInput.value.trim(),
        model: visionModelInput.value.trim(),
      },
      thinkingOverride: toggleEnableThinking.checked ? 1 : toggleDisableThinking.checked ? -1 : 0,
      disableMaxToken: toggleDisableMaxToken.checked,
      contextWindowTokens: Math.max(4096, parseInt(contextWindowInput.value, 10) || 256000),
    });
    setSaveStatus("已保存", "is-ok");
  } catch {
    setSaveStatus("保存失败", "is-error");
  }
});












function switchSection(section: string): void {
  const label = NAV_LABELS[section] ?? NAV_LABELS.api;
  sectionTitle.textContent = label.title;
  sectionHint.textContent = label.hint;

  const isApi = section === "api";
  const isApiAdvanced = section === "api-advanced";
  const isAppearance = section === "appearance";
  const isGeneral = section === "general";
  const isPreferences = section === "preferences";
  const isCyrene = section === "cyrene";
  const isDisclaimer = section === "disclaimer";
  const isMemory = section === "memory";
  const isUser = section === "user";
  const isTasks = section === "tasks";
  const isPlugins = section === "plugins";
  const isSkills = section === "skills";
  const isTokens = section === "tokens";
  const isChannels = section === "channels";
  const isTts = section === "tts";
  const isAsr = section === "asr";
  const isMusic = section === "music";
  apiForm.classList.toggle("is-hidden", !isApi);
  apiRuntimeForm.classList.toggle("is-hidden", !isApiAdvanced);
  apiTimeoutForm.classList.toggle("is-hidden", !isApiAdvanced);
  appearanceForm.classList.toggle("is-hidden", !isAppearance);
  generalForm.classList.toggle("is-hidden", !isGeneral);
  preferencesForm.classList.toggle("is-hidden", !isPreferences);
  cyrenePanel.classList.toggle("is-hidden", !isCyrene);
  disclaimerPanel.classList.toggle("is-hidden", !isDisclaimer);
  const memoryPanel = document.getElementById("memory-panel");
  if (memoryPanel) memoryPanel.classList.toggle("is-hidden", !isMemory);
  const userPanel = document.getElementById("user-panel");
  if (userPanel) userPanel.classList.toggle("is-hidden", !isUser);
  const tasksPanel = document.getElementById("tasks-panel");
  if (tasksPanel) tasksPanel.classList.toggle("is-hidden", !isTasks);
  if (isTasks) void loadSchedulerPanel();
  pluginsPanel.classList.toggle("is-hidden", !isPlugins);
  const skillsPanel = document.getElementById("skills-panel");
  if (skillsPanel) skillsPanel.classList.toggle("is-hidden", !isSkills);
  if (isSkills) void renderSkills();
  const tokenPanel = document.getElementById("token-panel");
  if (tokenPanel) tokenPanel.classList.toggle("is-hidden", !isTokens);
  const channelsPanel = document.getElementById("channels-panel");
  if (channelsPanel) channelsPanel.classList.toggle("is-hidden", !isChannels);
  if (isChannels) void loadChannelsPanel();
  const ttsPanel = document.getElementById("tts-panel");
  if (ttsPanel) ttsPanel.classList.toggle("is-hidden", !isTts);
  const asrPanel = document.getElementById("asr-panel");
  if (asrPanel) asrPanel.classList.toggle("is-hidden", !isAsr);
  const musicPanel = document.getElementById("music-panel");
  if (musicPanel) musicPanel.classList.toggle("is-hidden", !isMusic);
  if (isMusic) void loadMusicPanel();
  else disposeMusicPanel();
  placeholderPanel.classList.toggle(
    "is-hidden",
    isApi || isApiAdvanced || isAppearance || isGeneral || isPreferences || isCyrene || isDisclaimer || isMemory || isUser || isTasks || isPlugins || isSkills || isTokens || isChannels || isTts || isAsr || isMusic,
  );

  if (
    !isApi &&
    !isApiAdvanced &&
    !isAppearance &&
    !isGeneral &&
    !isPreferences &&
    !isCyrene &&
    !isDisclaimer &&
    !isMemory &&
    !isUser &&
    !isTasks &&
    !isPlugins &&
    !isSkills &&
    !isTokens &&
    !isChannels &&
    !isTts &&
    !isAsr &&
    !isMusic
  ) {
	    placeholderIcon.innerHTML = label.emoji;
    placeholderTitle.textContent = label.title;
    placeholderCopy.textContent = "这个模块先占位，等核心聊天与 API 接通后再继续扩展。";
  }

  document.querySelectorAll(".nav-item").forEach((el) => {
    const isMatch = (el as HTMLElement).dataset.section === section;
    el.classList.toggle("is-active", isMatch);
  });
  const activeNav = document.querySelector(".nav-item.is-active");
  console.log("[Settings/Trace] switchSection section=", section, "activeNav=", activeNav ? (activeNav as HTMLElement).dataset.section : null);
}

document.querySelectorAll(".nav-item").forEach((el) => {
  el.addEventListener("click", () => {
    const section = (el as HTMLElement).dataset.section;
    if (section) switchSection(section);
  });
});

schedulerNewBtn?.addEventListener("click", () => void openSchedulerEditor());
schedulerEditorClose?.addEventListener("click", closeSchedulerEditor);
schedulerCancelBtn?.addEventListener("click", closeSchedulerEditor);
schedulerSaveBtn?.addEventListener("click", () => void saveSchedulerTask());
schedulerKindInput?.addEventListener("change", updateSchedulerConditionalFields);
schedulerToolLimitInput?.addEventListener("change", updateSchedulerConditionalFields);
updateSchedulerConditionalFields();

// ===== 游戏代肝插件卡（在 plugins 面板里，MCP 下、生活工具上）=====
function initGameBotPluginCard(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gb = (window as any).gameBot as {
    getConfig: () => Promise<{ enabled: boolean; exePath: string; activeRecipe: string; vlm: { baseUrl: string; apiKey: string; model: string } }>;
    saveConfig: (c: unknown) => Promise<unknown>;
    listRecipes: () => Promise<{ id: string; name: string }[]>;
    listRefs: (r: string) => Promise<string[]>;
    refsDir: (r: string) => Promise<string>;
    start: () => Promise<{ ok: boolean; error?: string }>;
    stop: () => Promise<unknown>;
    onProgress: (cb: (i: unknown) => void) => (() => void) | void;
  } | undefined;
  if (!gb) return;

  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
  const enabledCb = $<HTMLInputElement>("plugin-gamebot-enabled");
  const configEl = $("plugin-gamebot-config");
  const exe = $<HTMLInputElement>("gamebot-exe");
  const url = $<HTMLInputElement>("gamebot-vlm-url");
  const key = $<HTMLInputElement>("gamebot-vlm-key");
  const model = $<HTMLInputElement>("gamebot-vlm-model");
  const recipeSel = $<HTMLSelectElement>("gamebot-recipe");
  const refsDirEl = $("gamebot-refs-dir");
  const refsListEl = $("gamebot-refs-list");
  const startBtn = $<HTMLButtonElement>("gamebot-start-btn");
  const stopBtn = $<HTMLButtonElement>("gamebot-stop-btn");
  const logEl = $("gamebot-log");
  if (!enabledCb || !configEl || !exe || !url || !key || !model || !recipeSel) return;

  let currentRecipe = "star-rail-daily";

  function appendLog(line: string): void {
    if (!logEl) return;
    logEl.textContent = new Date().toLocaleTimeString() + " " + line + "\n" + (logEl.textContent ?? "");
  }

  async function refreshRefs(): Promise<void> {
    if (refsDirEl) refsDirEl.textContent = await gb!.refsDir(currentRecipe);
    const refs = await gb!.listRefs(currentRecipe);
    if (refsListEl) {
      refsListEl.innerHTML = refs.length
        ? "已就位参考图：" + refs.map((r) => "<code>" + r + "</code>").join(" ")
        : "（目录还没有参考图，把裁好的小图按命名放进上方目录）";
    }
  }

  async function refresh(): Promise<void> {
    const cfg = await gb!.getConfig();
    enabledCb!.checked = cfg.enabled;
    configEl!.style.display = cfg.enabled ? "block" : "none";
    exe.value = cfg.exePath;
    url.value = cfg.vlm.baseUrl;
    key.value = cfg.vlm.apiKey;
    model.value = cfg.vlm.model;
    currentRecipe = cfg.activeRecipe;
    const recipes = await gb!.listRecipes();
    recipeSel.innerHTML = "";
    for (const r of recipes) {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = r.name + " (" + r.id + ")";
      if (r.id === currentRecipe) opt.selected = true;
      recipeSel.appendChild(opt);
    }
    await refreshRefs();
  }

  // 胶囊开关：开/关时保存 enabled 并显隐配置区
  enabledCb.addEventListener("change", async () => {
    configEl.style.display = enabledCb.checked ? "block" : "none";
    await gb.saveConfig({ enabled: enabledCb.checked });
  });

  // 配置项失焦即存
  const saveFields = () => gb.saveConfig({
    exePath: exe.value.trim(),
    activeRecipe: recipeSel.value,
    vlm: { baseUrl: url.value.trim(), apiKey: key.value.trim(), model: model.value.trim() },
  });
  for (const el of [exe, url, key, model]) el.addEventListener("change", () => void saveFields());
  recipeSel.addEventListener("change", () => { currentRecipe = recipeSel.value; void saveFields().then(refreshRefs); });

  startBtn?.addEventListener("click", async () => {
    const r = await gb.start();
    appendLog(r.ok ? "代肝已启动" : "启动失败: " + (r.error ?? ""));
  });
  stopBtn?.addEventListener("click", () => { void gb.stop(); appendLog("已请求停止"); });

  gb.onProgress((info) => {
    const i = info as { index: number; total: number; desc: string };
    appendLog(i.desc + (i.index >= 0 ? " (" + (i.index + 1) + "/" + i.total + ")" : ""));
  });

  void refresh();
}

initGameBotPluginCard();
void loadConfig();
void loadGeneralSettings();
window.settings?.onChannelsStatusChanged((status) => {
  renderProactiveDeliveryAvailability(status as Record<string, { phase?: string }>);
});

// ===== channels panel (连接手机) =====
// 飞书配置输入框（Phase 2 长连接版：只需 App ID + App Secret）
// 微信按钮





// ===== Phase 3.4：消息日志 =====





// 首次进入 channels panel 时拉一次日志
// （也可以在用户展开 details 时再拉，但保持简单直接拉）
void loadChannelsPanel();

// ===== Phase 2: 音乐工具面板 =====
// 备注：window.music.* 已在 preload 中通过 contextBridge 暴露。
// 由于 renderer 走 Vite 打包、main/preload 走 esbuild，两端类型不互通，
// 这里直接用 (window as any).music 做弱类型化调用，避免给 global.d.ts 加一堆 cross-bundle 类型。




















// ── 网易云折叠卡片用的全局 status 订阅（不依赖切到 music 面板） ────────
// 让 MCP 面板里的「网易云音乐 / 尚未连接」永远跟主进程状态同步。
// 用一个独立的 unsub 句柄，跟 music 面板自己的订阅解耦。
(() => {
  const api = getMusicApi();
  if (!api || typeof api.onStateChanged !== "function") return;
  try {
    api.onStateChanged((s) => {
      // 只更新折叠卡片的状态文案，避免与 music 面板里的 renderMusicStatus 重复副作用
      const el = document.getElementById("music-platform-status");
      if (!el) return;
      const state = deriveNeteaseViewState(s);
      const connected = state === "connected" || state === "connected_without_client";
      el.textContent = connected ? "已连接" : "尚未连接";
      el.classList.toggle("is-connected", connected);
    });
    api.getStatus().then((r) => {
      if (!r.ok) return;
      const el = document.getElementById("music-platform-status");
      if (!el) return;
      const state = deriveNeteaseViewState(r.data);
      const connected = state === "connected" || state === "connected_without_client";
      el.textContent = connected ? "已连接" : "尚未连接";
      el.classList.toggle("is-connected", connected);
    }).catch(() => { /* ignore */ });
  } catch {
    /* window.music 还没准备好，忽略 */
  }
})();

// 启动时读 URL hash 决定初始标签（main 通过 loadURL 带 #api 实现"切换模型按钮跳 API"）。
// 无 hash 默认 general。
const initialSection = (window.location.hash || "#general").slice(1);
switchSection(initialSection);
// 监听 main 发来的切标签事件（窗口已打开时，main 不重新 loadURL，改发事件）
window.settings?.onSwitchSection?.((section) => {
  switchSection(section);
});
/* ===== RAG model card toggle (embedding only) ===== */
(function () {
  const cards = document.querySelectorAll<HTMLButtonElement>(".rag-model-card:not([data-reranker])");
  const KEY = "cyrene.rag.model";
  const saved = localStorage.getItem(KEY) || "minilm";
  cards.forEach((card) => {
    const value = card.dataset.value;
    if (!value) return;
    card.classList.toggle("is-active", value === saved);
    card.addEventListener("click", async () => {
      const previousActive = document.querySelector(".rag-model-card.is-active:not([data-reranker])") as HTMLElement | null;
      const previousValue = previousActive?.dataset.value;

      // Optimistic UI update
      cards.forEach((c) => c.classList.remove("is-active"));
      card.classList.add("is-active");
      localStorage.setItem(KEY, value);

      // Call IPC to hot-switch the embedding model
      try {
        const result = await (window as any).settings?.embeddingSetModel?.(value);
        if (result?.ok) {
          console.log("[settings] embedding switched to", value, "cleared:", result.clearedEntries);
          if (result.clearedEntries && result.clearedEntries > 0) {
            window.alert("已切换至 " + (value === "bgem3" ? "BGE-M3" : "MiniLM") + "。由于向量维度不同，已清除 " + result.clearedEntries + " 条旧向量记忆。");
          }
        } else {
          // Rollback on failure
          cards.forEach((c) => c.classList.remove("is-active"));
          if (previousValue) {
            const prevCard = document.querySelector('.rag-model-card[data-value="' + previousValue + '"]:not([data-reranker])');
            prevCard?.classList.add("is-active");
            localStorage.setItem(KEY, previousValue);
          }
          window.alert("切换失败：" + (result?.error || "未知错误"));
        }
      } catch (err) {
        // Rollback on error
        cards.forEach((c) => c.classList.remove("is-active"));
        if (previousValue) {
          const prevCard = document.querySelector('.rag-model-card[data-value="' + previousValue + '"]:not([data-reranker])');
          prevCard?.classList.add("is-active");
          localStorage.setItem(KEY, previousValue);
        }
        console.error("[settings] embedding switch error:", err);
      }
    });
  });
})();
/* ===== Reranker mode toggle ===== */
(function () {
  const cards = document.querySelectorAll<HTMLButtonElement>(".rag-model-card[data-reranker]");
  const KEY = "cyrene.reranker.mode";
  const saved = localStorage.getItem(KEY) || "light";
  cards.forEach((card) => {
    const value = card.dataset.value;
    if (!value) return;
    card.classList.toggle("is-active", value === saved);
    card.addEventListener("click", async () => {
      const previousActive = document.querySelector(".rag-model-card.is-active[data-reranker]") as HTMLElement | null;
      const previousValue = previousActive?.dataset.value;

      cards.forEach((c) => c.classList.remove("is-active"));
      card.classList.add("is-active");
      localStorage.setItem(KEY, value);
      try {
        await (window as any).settings?.rerankerSetMode?.(value);
      } catch (err) {
        // Rollback on failure
        cards.forEach((c) => c.classList.remove("is-active"));
        if (previousValue) {
          const prevCard = document.querySelector('.rag-model-card[data-value="' + previousValue + '"][data-reranker]');
          prevCard?.classList.add("is-active");
          localStorage.setItem(KEY, previousValue);
        }
        console.warn("[Reranker] set mode failed:", err);
      }
    });
  });
})();

/* ===== Reranker install status (real on-disk check via IPC) ===== */
(async () => {
  const lightEl = document.getElementById("reranker-light-status");
  const standardEl = document.getElementById("reranker-standard-status");
  try {
    const status = await (window as any).settings?.getRerankerStatus?.();
    if (!status) return;
    if (lightEl) lightEl.textContent = status.light ? "已下载 · 约 23MB" : "未下载 · 可选";
    if (standardEl) standardEl.textContent = status.standard ? "已下载 · 约 279MB" : "未下载 · 可选";
  } catch (err) {
    console.warn("[Reranker] status check failed:", err);
    if (lightEl) lightEl.textContent = "状态未知";
    if (standardEl) standardEl.textContent = "状态未知";
  }
})();

/* ===== Embedding model status ===== */
(async () => {
  const bgem3El = document.getElementById("embedding-bgem3-status");
  const minilmEl = document.getElementById("embedding-minilm-status");
  try {
    const status = await window.modelConfig?.getModelInstallStatus?.();
    if (!status) {
      if (bgem3El) bgem3El.textContent = "状态未知";
      if (minilmEl) minilmEl.textContent = "状态未知";
      return;
    }
    if (bgem3El) bgem3El.textContent = status.embedding?.bgem3 ? "已下载 · 约 570MB" : "未下载";
    if (minilmEl) minilmEl.textContent = status.embedding?.minilm ? "已下载 · 约 23MB" : "未下载";
  } catch (err) {
    console.warn("[Embedding] status check failed:", err);
    if (bgem3El) bgem3El.textContent = "状态未知";
    if (minilmEl) minilmEl.textContent = "状态未知";
  }
})();

/* ===== Embedding download / delete ===== */
(function () {
  const downloadBtn = document.getElementById("embedding-download-btn") as HTMLButtonElement | null;
  const deleteBtn = document.getElementById("embedding-delete-btn") as HTMLButtonElement | null;
  const mirrorGroup = document.getElementById("embedding-mirror") as HTMLElement | null;

  function getSelectedMirror(): string {
    const active = mirrorGroup?.querySelector(".option-block.is-active") as HTMLElement | null;
    return active?.dataset.value || "official";
  }

  function getSelectedModel(): string {
    const active = document.querySelector(".rag-model-card.is-active:not([data-reranker])") as HTMLElement | null;
    return active?.dataset.value || "minilm";
  }

  downloadBtn?.addEventListener("click", async () => {
    // 打开模型安装说明文档
    await window.system?.openExternal(
      "https://github.com/Playa-0v0/Cyrene-Agent/blob/master/docs/local-models.md"
    );
  });


  // Inline modal helper
  function _showModal(opts: { title: string; message: string; icon?: string; confirmText?: string; cancelText?: string }): Promise<boolean> {
    var ov = document.getElementById("cy-modal-overlay");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "cy-modal-overlay";
      ov.className = "cy-modal-overlay is-hidden";
      ov.innerHTML = '<div class="cy-modal" role="alertdialog" aria-modal="true"><div class="cy-modal__head"><span class="cy-modal__icon" id="cy-modal-icon">📌</span><h3 class="cy-modal__title" id="cy-modal-title">提示</h3></div><hr class="cy-modal__divider"><p class="cy-modal__body" id="cy-modal-message">确认执行此操作吗？</p><div class="cy-modal__actions"><button type="button" class="ghost-btn" id="cy-modal-cancel">取消</button><button type="button" class="btn-primary" id="cy-modal-confirm">确定</button></div></div>';
      document.body.appendChild(ov);
    }
    var iconEl = ov.querySelector("#cy-modal-icon") as HTMLElement;
    var titleEl = ov.querySelector("#cy-modal-title") as HTMLElement;
    var msgEl = ov.querySelector("#cy-modal-message") as HTMLElement;
    var cancelBtn = ov.querySelector("#cy-modal-cancel") as HTMLButtonElement;
    var confirmBtn = ov.querySelector("#cy-modal-confirm") as HTMLButtonElement;
    iconEl.innerHTML = opts.icon || "📌";
    titleEl.textContent = opts.title;
    msgEl.textContent = opts.message;
    cancelBtn.textContent = opts.cancelText || "取消";
    confirmBtn.textContent = opts.confirmText || "确定";
    ov.classList.remove("is-hidden");
    return new Promise(function (resolve) {
      var cleanup = function (result: boolean) {
        ov?.classList.add("is-hidden");
        cancelBtn.removeEventListener("click", onCancel);
        confirmBtn.removeEventListener("click", onConfirm);
        resolve(result);
      };
      var onCancel = function () { cleanup(false); };
      var onConfirm = function () { cleanup(true); };
      cancelBtn.addEventListener("click", onCancel);
      confirmBtn.addEventListener("click", onConfirm);
    });
  }
  deleteBtn?.addEventListener("click", async () => {
    const model = getSelectedModel();
    const name = model === "minilm" ? "MiniLM" : "BGE-M3";
    var confirmed = await _showModal({ title: "删 除 模 型", message: "确 定 删 除 " + name + " 模 型 缓 存？下 次 使 用 需 重 新 下 载。", icon: "⚠️", confirmText: "删 除", cancelText: "取 消" });
    if (!confirmed) return;
    deleteBtn.disabled = true;
    deleteBtn.textContent = "\u5220\u9664\u4E2D\u2026";
    try {
      const result = await window.settings?.deleteEmbeddingModel?.(model);
      if (result?.ok) {
        deleteBtn.textContent = "\u2705 \u5DF2\u5220\u9664";
        setTimeout(() => location.reload(), 800);
      } else {
        deleteBtn.textContent = "\u274C \u5931\u8D25";
        deleteBtn.disabled = false;
      }
    } catch (err) {
      deleteBtn.textContent = "\u274C \u5931\u8D25";
      deleteBtn.disabled = false;
    }
  });

  // Mirror source toggle
  mirrorGroup?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-value]") as HTMLElement | null;
    if (!btn) return;
    const value = btn.dataset.value;
    if (!value) return;
    mirrorGroup.querySelectorAll(".option-block").forEach((b) => {
      const v = b.getAttribute("data-value");
      b.classList.toggle("is-active", v === value);
      b.setAttribute("aria-pressed", v === value ? "true" : "false");
    });
    localStorage.setItem("cyrene.rag.mirror", value);
  });

  // Restore saved mirror on load
  const savedMirror = localStorage.getItem("cyrene.rag.mirror") || "official";
  mirrorGroup?.querySelectorAll(".option-block").forEach((b) => {
    const v = b.getAttribute("data-value");
    b.classList.toggle("is-active", v === savedMirror);
    b.setAttribute("aria-pressed", v === savedMirror ? "true" : "false");
  });
})();
(function () {
  const updateBtn = document.getElementById("embedding-update-btn") as HTMLButtonElement | null;
  updateBtn?.addEventListener("click", () => {
    updateBtn.textContent = "已是最新版本";
    updateBtn.disabled = true;
    setTimeout(() => {
      updateBtn.textContent = "检查更新";
      updateBtn.disabled = false;
    }, 2000);
  });
})();
// --- L0/L1 editable logic ---














// Bind edit button events
memoryL0EditBtn?.addEventListener("click", () => {
  if (memoryState.l0Editing) { saveL0(); } else { enterL0EditMode(); }
});
memoryL0CancelBtn?.addEventListener("click", cancelL0Edit);

memoryL1EditBtn?.addEventListener("click", () => {
  if (memoryState.l1Editing) { saveL1(); } else { enterL1EditMode(); }
});
memoryL1CancelBtn?.addEventListener("click", cancelL1Edit);



memoryImportedList?.addEventListener("click", async (event) => {
  const target = event.target as HTMLElement | null;
  const deleteBtn = target?.closest(".memory-record__delete") as HTMLElement | null;
  if (!deleteBtn) return;

  const importId = deleteBtn.dataset.importId || "";
  const fileName = deleteBtn.dataset.fileName || "未命名文档";

  const confirmed = await showModal({
    title: "删除导入知识",
    message: "确定删除导入知识？\n\n文件：\n《" + fileName + "》\n\n删除后不可恢复，如需使用请重新导入。",
    icon: "⚠️",
    confirmText: "删除",
    cancelText: "取消",
  });

  if (!confirmed) return;

  try {
    const result = await window.memoryPanel?.deleteImportedDoc(importId, fileName);
    if (result?.ok) {
      await loadMemoryPanel();
    }
  } catch (err) {
    console.error("[settings] delete imported doc failed", err);
  }
});


void loadMemoryPanel();

// ── 权限档位 UI ───────────────────────────────────────────
type PermissionLevel = "read-only" | "scoped" | "per-action" | "full";


const PERMISSION_NOTES: Record<PermissionLevel, string> = {
  "read-only": "只读：昔涟不会修改本地任何文件，也不能为你安装新工具。",
  "scoped": "指定目录：昔涟只能在你授权的目录里读写文件（白名单后续在此面板配置）。",
  "per-action": "每次审批：每次涉及文件或安装的操作，昔涟都会在聊天里弹卡片让你确认。",
  "full": "完全访问：昔涟可以自由调用本地命令（含 git/npm/pip）。请只在你完全信任的情况下使用。",
};

function paintPermissionUI(level: PermissionLevel): void {
  if (!permissionBlocksWrap) return;
  // scoped 档已从插件面板移除，回退显示只读
  const display = level === "scoped" ? "read-only" : level;
  const blocks = permissionBlocksWrap.querySelectorAll<HTMLButtonElement>("button[data-level]");
  blocks.forEach((b) => {
    const isActive = b.dataset.level === display;
    b.classList.toggle("is-active", isActive);
    b.setAttribute("aria-pressed", String(isActive));
  });
  if (permissionNote) {
    permissionNote.textContent = PERMISSION_NOTES[level];
  }
}

async function confirmFullAccess(): Promise<boolean> {
  // 完全访问需要延迟确认 + 风险提示
  _initModalOverlay();
  if (!modalState.cyOverlay) return false;
  const iconEl = modalState.cyOverlay.querySelector("#cy-modal-icon") as HTMLElement;
  const titleEl = modalState.cyOverlay.querySelector("#cy-modal-title") as HTMLElement;
  const msgEl = modalState.cyOverlay.querySelector("#cy-modal-message") as HTMLElement;
  const cancelBtn = modalState.cyOverlay.querySelector("#cy-modal-cancel") as HTMLButtonElement;
  const confirmBtn = modalState.cyOverlay.querySelector("#cy-modal-confirm") as HTMLButtonElement;
  iconEl.textContent = "⚠️";
  titleEl.textContent = "切换到完全访问？";
  msgEl.textContent = "这意味着昔涟可以在你的电脑上自由执行命令，包括 git clone、npm install、删除文件等。请只在你完全信任她的判断时启用。";
  cancelBtn.textContent = "再想想";
  modalState.cyOverlay.classList.remove("is-hidden");

  // 倒计时 5 秒强制等待
  let remain = 5;
  confirmBtn.disabled = true;
  confirmBtn.textContent = "我了解风险（" + remain + "）";
  const tick = setInterval(() => {
    remain -= 1;
    if (remain <= 0) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "我了解风险，启用";
      clearInterval(tick);
    } else {
      confirmBtn.textContent = "我了解风险（" + remain + "）";
    }
  }, 1000);

  return new Promise((resolve) => {
    const cleanup = (result: boolean) => {
      clearInterval(tick);
      confirmBtn.disabled = false;
      modalState.cyOverlay?.classList.add("is-hidden");
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      resolve(result);
    };
    const onCancel = () => cleanup(false);
    const onConfirm = () => cleanup(true);
    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
  });
}

if (permissionBlocksWrap) {
  permissionBlocksWrap.addEventListener("click", async (event) => {
    const btn = (event.target as HTMLElement)?.closest("button[data-level]") as HTMLButtonElement | null;
    if (!btn) return;
    const target = (btn.dataset.level || "") as PermissionLevel;
    if (!target) return;
    if (btn.classList.contains("is-active")) {
      console.log("[settings] 档位未变，不动作");
      return;
    }

    if (target === "full") {
      const ok = await confirmFullAccess();
      if (!ok) {
        console.log("[settings] 用户取消了完全访问");
        return;
      }
    }

    console.log("[settings] 切换权限档位 →", target);
    try {
      const result = await window.settings?.setPermissionLevel?.(target);
      if (result?.ok) {
        paintPermissionUI((result.level || target) as PermissionLevel);
      } else {
        console.warn("[settings] 切换档位失败:", result?.error);
      }
    } catch (err) {
      console.error("[settings] 切换档位异常:", err);
    }
  });

  // 初始化：从后端拿当前档位
  void (async () => {
    try {
      const result = await window.settings?.getPermissionLevel?.();
      const level = (result?.level || "read-only") as PermissionLevel;
      console.log("[settings] 当前权限档位:", level);
      paintPermissionUI(level);
    } catch (err) {
      console.warn("[settings] 加载权限档位失败:", err);
      paintPermissionUI("read-only");
    }
  })();
}

// ── 生活工具手风琴 ─────────────────────────────────────────
lifeToggle?.addEventListener("click", () => {
  const expanded = lifeToggle.getAttribute("aria-expanded") === "true";
  lifeToggle.setAttribute("aria-expanded", String(!expanded));
  lifeCard?.classList.toggle("is-expanded", !expanded);
  lifeBody?.classList.toggle("is-collapsed", expanded);
});

// ── 音乐工具手风琴（跟生活工具一样的折叠逻辑）────────────────
musicToggle?.addEventListener("click", () => {
  const expanded = musicToggle.getAttribute("aria-expanded") === "true";
  musicToggle.setAttribute("aria-expanded", String(!expanded));
  musicAccordionCard?.classList.toggle("is-expanded", !expanded);
  musicAccordionBody?.classList.toggle("is-collapsed", expanded);
});

// ── 音乐工具路由 ──────────────────────────────────────────────
document.getElementById("music-platform-netease")?.addEventListener("click", () => {
  switchSection("music");
  musicHomeView?.classList.add("is-hidden");
  neteaseDetailView?.classList.remove("is-hidden");
});
musicReturnBtn?.addEventListener("click", () => {
	  switchSection("plugins");
	});


// ── Skill 面板：列 skill 开关 ──────────────────────────────
async function renderSkills(): Promise<void> {
  const listEl = document.getElementById("skills-list");
  const emptyEl = document.getElementById("skills-empty");
  if (!listEl || !window.settings?.listSkills) return;

  let skills: Array<{ id: string; name: string; description: string; tools: string[]; enabled: boolean; source: string; version?: string; references: string[] }> = [];
  try {
    skills = await window.settings.listSkills();
  } catch (err) {
    console.warn("[settings] 加载 skill 列表失败:", err);
  }

  listEl.innerHTML = "";
  if (skills.length === 0) {
    if (emptyEl) emptyEl.classList.remove("is-hidden");
    return;
  }
  if (emptyEl) emptyEl.classList.add("is-hidden");

  // MiniMax 办公合集 id 列表
  const officeGroupIds = new Set(["docx", "pdf", "pptx-generator", "xlsx"]);
  const officeSkills = skills.filter((s) => officeGroupIds.has(s.id));
  const otherSkills = skills.filter((s) => !officeGroupIds.has(s.id));

  // 渲染单条 skill
  function renderSkillRow(s: typeof skills[number]): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "skill-row";
    const label = document.createElement("div");
    label.className = "skill-row__info";
    const title = document.createElement("div");
    title.className = "skill-row__title";
    title.textContent = s.name + (s.source === "user" ? " （用户）" : "");
    const desc = document.createElement("div");
    desc.className = "skill-row__desc";
    const short = s.description.length > 120 ? s.description.slice(0, 120) + "…" : s.description;
    const toolsStr = s.tools.length > 0 ? ` [tools: ${s.tools.join(", ")}]` : "";
    desc.textContent = short + toolsStr;
    label.appendChild(title);
    label.appendChild(desc);

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "skill-toggle";
    toggle.checked = s.enabled;
    toggle.addEventListener("change", async () => {
      try {
        await window.settings?.setSkillEnabled?.(s.id, toggle.checked);
      } catch (err) {
        console.warn("[settings] 切换 skill 失败:", err);
        toggle.checked = !toggle.checked;
      }
    });

    row.appendChild(label);
    row.appendChild(toggle);
    return row;
  }

  // 渲染其他（非合集）skill
  for (const s of otherSkills) {
    listEl.appendChild(renderSkillRow(s));
  }

  // MiniMax 办公合集折叠组
  if (officeSkills.length > 0) {
    const group = document.createElement("div");
    group.className = "skill-group";

    const header = document.createElement("div");
    header.className = "skill-group__header";
    const arrow = document.createElement("span");
    arrow.className = "skill-group__arrow";
    arrow.textContent = "▶";
    const gTitle = document.createElement("span");
    gTitle.className = "skill-group__title";
    gTitle.textContent = "MiniMAX-office-skills";
    const gDesc = document.createElement("span");
    gDesc.className = "skill-group__desc";
    gDesc.textContent = "MiniMax开源的办公文档Skills合集";
    header.appendChild(arrow);
    header.appendChild(gTitle);
    header.appendChild(gDesc);
    header.addEventListener("click", () => {
      body.classList.toggle("is-open");
      arrow.textContent = body.classList.contains("is-open") ? "▼" : "▶";
    });

    const body = document.createElement("div");
    body.className = "skill-group__body";
    for (const s of officeSkills) {
      body.appendChild(renderSkillRow(s));
    }

    group.appendChild(header);
    group.appendChild(body);
    listEl.appendChild(group);
  }
}








/* ============================================================
   🎙️ TTS 设置面板交互
   - 配置加载/保存（存 general settings，跟其他设置一起）
   - 引擎选择卡片切换：选中哪个展开哪个配置表单
   - 语速/音量滑块实时显示数值 + 自动保存
   - MiniMax 测试发音：调 synthesize 合成固定文本并播放
   - 音色快速复刻：选文件→上传→训练→自动填入 voice_id
   ============================================================ */

interface TtsApi {
  upload: (apiKey: string, filePath: string, purpose: "voice_clone" | "prompt_audio") => Promise<{ file_id: string }>;
  pickAudio: () => Promise<string | null>;
  clone: (payload: {
    apiKey: string; fileId: string; voiceId: string;
    promptAudioId?: string; promptText?: string;
    text: string; model?: string;
  }) => Promise<{ voiceId: string; audioDemo?: string }>;
  synthesize: (payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; pitch?: number;
    model?: string; format?: "mp3" | "wav" | "pcm";
  }) => Promise<string>; // base64 音频
  // GPT-SoVITS（返回 base64 + cacheKey + cached + format）
  synthesizeGptsovits: (payload: {
    baseUrl: string; refAudioPath: string; promptText: string; text: string;
    speed?: number; format?: "wav" | "mp3";
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" | "mp3" }>;
  synthesizeCachedGptsovits: (payload: {
    baseUrl: string; refAudioPath: string; promptText: string; text: string;
    speed?: number; format?: "wav" | "mp3";
    expectedCacheKey?: string;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" | "mp3" }>;
  // 自定义云端（返回 base64 + cacheKey + cached + format）
  synthesizeCustomCloud: (payload: {
    endpointUrl: string; apiKey?: string; voiceId?: string; text: string;
    speed?: number; volume?: number; format?: "wav" | "mp3"; timeoutMs?: number;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" | "mp3" }>;
  synthesizeCachedCustomCloud: (payload: {
    endpointUrl: string; apiKey?: string; voiceId?: string; text: string;
    speed?: number; volume?: number; format?: "wav" | "mp3"; timeoutMs?: number;
    expectedCacheKey?: string;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" | "mp3" }>;
  // 小米 MiMo（返回 base64 + cacheKey + cached + format）
  synthesizeMimo: (payload: {
    apiKey: string; voiceAudioPath?: string; text: string; stylePrompt?: string;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" }>;
  synthesizeCachedMimo: (payload: {
    apiKey: string; voiceAudioPath?: string; text: string; stylePrompt?: string;
    expectedCacheKey?: string;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" }>;
  // Mossland（api.mosi.cn）
  synthesizeMossland: (payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; model?: string;
    format?: "mp3" | "wav" | "pcm";
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "mp3" | "wav" | "pcm" }>;
  synthesizeCachedMossland: (payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; model?: string;
    format?: "mp3" | "wav" | "pcm";
    expectedCacheKey?: string;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "mp3" | "wav" | "pcm" }>;
  cloneMossland: (payload: {
    apiKey: string; filePath: string; name?: string; description?: string;
  }) => Promise<{ voiceId: string; name?: string; createdAt?: number }>;
  listMosslandVoices: (payload: {
    apiKey: string; limit?: number;
  }) => Promise<{ voices: Array<{ id: string; name: string; createdAt: number }> }>;
  pickAudioFile: () => Promise<string | null>;
  saveSettings: (tts: Record<string, unknown>) => Promise<unknown>;
  loadSettings: () => Promise<Record<string, unknown>>;
}

declare global {
  interface Window {
    tts?: TtsApi;
  }
}

const TTS_TEST_TEXT = "你好，我是昔涟，很高兴见到你。";

// 获取 DOM 元素的辅助函数
function ttsEl(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

// 当前加载的 TTS 配置（内存缓存，改一个字段就存一次）

// 加载配置并填充表单
async function loadTtsConfig(): Promise<void> {
  if (!window.tts) return;
  try {
    ttsState.config = await window.tts.loadSettings() as Record<string, unknown>;
  } catch (err) {
    console.warn("[TTS] 加载配置失败:", err);
    return;
  }

  // 引擎选择
  const engine = String(ttsState.config.ttsEngine || "off");
  document.querySelectorAll<HTMLButtonElement>(".tts-engine").forEach((btn) => {
    const isActive = btn.dataset.engine === engine;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-checked", isActive ? "true" : "false");
  });
  document.querySelectorAll<HTMLElement>(".tts-config").forEach((el) => { el.hidden = true; });
  if (engine !== "off") {
    const config = document.getElementById("tts-config-" + engine);
    if (config) config.hidden = false;
  }

  // 播放交互
  ttsEl("tts-auto-read").checked = Boolean(ttsState.config.ttsAutoRead);
  ttsEl("tts-speed").value = String(ttsState.config.ttsSpeed ?? 1);
  ttsEl("tts-volume").value = String(ttsState.config.ttsVolume ?? 1);
  updateTtsSliderLabels();

  // MiniMax
  ttsEl("tts-minimax-key").value = String(ttsState.config.ttsMinimaxKey ?? "");
  ttsEl("tts-minimax-voice").value = String(ttsState.config.ttsMinimaxVoiceId ?? "");
  (ttsEl("tts-minimax-model") as HTMLSelectElement).value =
    ttsState.config.ttsMinimaxModel === "speech-2.8-hd" ? "speech-2.8-hd" : "speech-2.8-turbo";
  ttsEl("tts-streaming").checked = ttsState.config.ttsStreaming !== false;
  ttsEl("tts-minimax-vocal-enhance").checked = ttsState.config.ttsMinimaxVocalEnhance !== false;

  // GPT-SoVITS
  ttsEl("tts-gptsovits-url").value = String(ttsState.config.ttsGptsovitsBaseUrl ?? "http://localhost:9880");
  ttsEl("tts-gptsovits-ref-audio").value = String(ttsState.config.ttsGptsovitsRefAudioPath ?? "");
  ttsEl("tts-gptsovits-prompt-text").value = String(ttsState.config.ttsGptsovitsPromptText ?? "");
  (ttsEl("tts-gptsovits-format") as HTMLSelectElement).value =
    ttsState.config.ttsGptsovitsFormat === "mp3" ? "mp3" : "wav";
  ttsEl("tts-gptsovits-timeout").value = String(ttsState.config.ttsGptsovitsTimeoutMs ?? 180000);

  // 自定义云端
  ttsEl("tts-custom-cloud-url").value = String(ttsState.config.ttsCustomCloudEndpointUrl ?? "");
  ttsEl("tts-custom-cloud-key").value = String(ttsState.config.ttsCustomCloudApiKey ?? "");
  ttsEl("tts-custom-cloud-voice").value = String(ttsState.config.ttsCustomCloudVoiceId ?? "");
  (ttsEl("tts-custom-cloud-format") as HTMLSelectElement).value =
    ttsState.config.ttsCustomCloudFormat === "wav" ? "wav" : "mp3";
  ttsEl("tts-custom-cloud-timeout").value = String(ttsState.config.ttsCustomCloudTimeoutMs ?? 30000);

  // 小米 MiMo
  ttsEl("tts-mimo-key").value = String(ttsState.config.ttsMimoKey ?? "");
  ttsEl("tts-mimo-voice-audio").value = String(ttsState.config.ttsMimoVoiceAudioPath ?? "");
  ttsEl("tts-mimo-style").value = String(ttsState.config.ttsMimoStylePrompt ?? "温柔、自然、略带亲近感，像在轻声陪用户聊天。");

  // Mossland（UI 骨架已就位，IPC 第二步接通；字段值已写入 ttsState.config 以便保存）
  ttsEl("tts-mossland-key").value = String(ttsState.config.ttsMosslandKey ?? "");
  ttsEl("tts-mossland-voice").value = String(ttsState.config.ttsMosslandVoiceId ?? "");
  (ttsEl("tts-mossland-model") as HTMLSelectElement).value = "moss-tts";
  ttsEl("tts-mossland-text").value = String(ttsState.config.ttsMosslandTestText ?? TTS_TEST_TEXT);
  (ttsEl("tts-mossland-format") as HTMLSelectElement).value =
    ttsState.config.ttsMosslandFormat === "wav" ? "wav"
    : ttsState.config.ttsMosslandFormat === "pcm" ? "pcm"
    : "mp3";
  ttsState.config.ttsMosslandKey       = String(ttsEl("tts-mossland-key").value);
  ttsState.config.ttsMosslandVoiceId   = String(ttsEl("tts-mossland-voice").value);
  ttsState.config.ttsMosslandModel     = (ttsEl("tts-mossland-model") as HTMLSelectElement).value;
  ttsState.config.ttsMosslandTestText  = String(ttsEl("tts-mossland-text").value);
  ttsState.config.ttsMosslandFormat    = (ttsEl("tts-mossland-format") as HTMLSelectElement).value;

  // 加载完成后清掉所有 Provider 的脏态（按钮隐藏，status 清空）
  for (const provider of Object.keys(TTS_PROVIDER_FIELDS)) {
    const ui = ttsProviderUi[provider];
    if (!ui) continue;
    ui.btn.classList.add("is-hidden");
    ui.status.textContent = "";
  }
}

function updateTtsSliderLabels(): void {
  const speedVal = document.getElementById("tts-speed-val");
  const volVal = document.getElementById("tts-volume-val");
  if (speedVal) speedVal.textContent = Number(ttsEl("tts-speed").value).toFixed(1) + "x";
  if (volVal) volVal.textContent = Math.round(Number(ttsEl("tts-volume").value) * 100) + "%";
}

// 保存单个 TTS 配置字段
async function saveTtsField(field: string, value: unknown): Promise<void> {
  if (!window.tts) return;
  ttsState.config[field] = value;
  try {
    await window.tts.saveSettings({ [field]: value });
  } catch (err) {
    console.warn("[TTS] 保存配置失败:", field, err);
  }
}

// 播放 base64 音频。format 决定 Blob MIME（minimax 默认 mp3，gptsovits 默认 wav）
function playTtsAudio(base64: string, format: "wav" | "mp3" = "mp3"): void {
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const mime = format === "wav" ? "audio/wav" : "audio/mp3";
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.play().catch((err) => console.warn("[TTS] 播放失败:", err));
    audio.onended = () => URL.revokeObjectURL(url);
  } catch (err) {
    console.warn("[TTS] 音频解码失败:", err);
  }
}

// 引擎选择切换
// 只匹配带 data-engine 的按钮（即 TTS 厂商按钮）——主动开口档位按钮虽然
// 共用 .tts-engine 视觉 class，但只有 data-mode 没有 data-engine，
// 用属性选择器避免误触把它们当作 TTS 厂商处理。
document.querySelectorAll<HTMLButtonElement>("[data-engine]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const engine = btn.dataset.engine || "off";
    document.querySelectorAll<HTMLButtonElement>("[data-engine]").forEach((b) => {
      b.classList.remove("is-active");
      b.setAttribute("aria-checked", "false");
    });
    btn.classList.add("is-active");
    btn.setAttribute("aria-checked", "true");
    document.querySelectorAll<HTMLElement>(".tts-config").forEach((el) => { el.hidden = true; });
    if (engine !== "off") {
      const config = document.getElementById("tts-config-" + engine);
      if (config) config.hidden = false;
    }
    void saveTtsField("ttsEngine", engine);
  });
});

// 自动朗读开关
ttsEl("tts-auto-read").addEventListener("change", () => {
  void saveTtsField("ttsAutoRead", ttsEl("tts-auto-read").checked);
});

// 语速/音量滑块（change 时保存，input 时实时显示）
ttsEl("tts-speed").addEventListener("input", updateTtsSliderLabels);
ttsEl("tts-speed").addEventListener("change", () => saveTtsField("ttsSpeed", Number(ttsEl("tts-speed").value)));
ttsEl("tts-volume").addEventListener("input", updateTtsSliderLabels);
ttsEl("tts-volume").addEventListener("change", () => saveTtsField("ttsVolume", Number(ttsEl("tts-volume").value)));

// GPT-SoVITS 超时输入框（number，blur 时保存并做简单边界限制）
ttsEl("tts-gptsovits-timeout").addEventListener("change", () => {
  let value = Number(ttsEl("tts-gptsovits-timeout").value);
  if (!Number.isFinite(value) || value < 10000) value = 10000;
  if (value > 3600000) value = 3600000;
  ttsEl("tts-gptsovits-timeout").value = String(value);
  void saveTtsField("ttsGptsovitsTimeoutMs", value);
});

// ── TTS 文本输入框：按 Provider 分组 + 手动保存 ──
// 之前这里有 input/change 自动 saveTtsField（settings.ts:4270–4295），
// 但每次 input 都会触发 IPC，IME 组字过程会被打断，用户反馈"打着打着输入法被打断"。
// 现在改为：文本框只 mark dirty，真正保存只发生在用户点击 Provider 自己的"保存配置"按钮。
// switch / slider / select / 引擎选择 / Opener 档位仍然走立即保存（保持即时反馈）。

// Provider ID → { 保存按钮, 状态 div }
// 用 ttsEl() 安全获取：拿不到时返回 null，不让整个 settings.ts 初始化崩。
const ttsProviderUi: Record<string, { btn: HTMLButtonElement; status: HTMLElement } | null> = {
  minimax:        ttsEl("tts-minimax-save-btn") && safeGet("tts-minimax-save-status")
                    ? { btn: ttsEl("tts-minimax-save-btn"), status: safeGet("tts-minimax-save-status") as HTMLElement }
                    : null,
  gptsovits:      ttsEl("tts-gptsovits-save-btn") && safeGet("tts-gptsovits-save-status")
                    ? { btn: ttsEl("tts-gptsovits-save-btn"), status: safeGet("tts-gptsovits-save-status") as HTMLElement }
                    : null,
  "custom-cloud": ttsEl("tts-custom-cloud-save-btn") && safeGet("tts-custom-cloud-save-status")
                    ? { btn: ttsEl("tts-custom-cloud-save-btn"), status: safeGet("tts-custom-cloud-save-status") as HTMLElement }
                    : null,
  mimo:           ttsEl("tts-mimo-save-btn") && safeGet("tts-mimo-save-status")
                    ? { btn: ttsEl("tts-mimo-save-btn"), status: safeGet("tts-mimo-save-status") as HTMLElement }
                    : null,
  mossland:       ttsEl("tts-mossland-save-btn") && safeGet("tts-mossland-save-status")
                    ? { btn: ttsEl("tts-mossland-save-btn"), status: safeGet("tts-mossland-save-status") as HTMLElement }
                    : null,
};

// 输入框触发脏态：只显示按钮和"有未保存的更改"，不发 IPC
function markTtsProviderDirty(provider: string): void {
  const ui = ttsProviderUi[provider];
  if (!ui) return;
  ui.btn.classList.remove("is-hidden");
  ui.status.textContent = "有未保存的更改";
  ui.status.className = "save-status";
}

for (const [provider, elIds] of Object.entries(TTS_PROVIDER_FIELDS)) {
  for (const elId of elIds) {
    const el = ttsEl(elId);
    el.addEventListener("input", () => markTtsProviderDirty(provider));
  }
}

// 保存某个 Provider 的所有文本配置
async function saveTtsProvider(provider: string): Promise<void> {
  const ui = ttsProviderUi[provider];
  if (!ui) return;
  const fields = TTS_PROVIDER_FIELDS[provider] ?? [];
  ui.btn.disabled = true;
  ui.status.textContent = "保存中…";
  ui.status.className = "save-status";
  try {
    const payload: Record<string, unknown> = {};
    for (const elId of fields) {
      const field = TTS_FIELD_MAP[elId];
      if (!field) continue;
      const el = ttsEl(elId);
      // 数字字段（timeout）转 Number；无效则跳过该字段但继续保存其他字段
      let value: unknown = el.value;
      if (elId === "tts-custom-cloud-timeout") {
        const num = Number(el.value);
        if (!Number.isFinite(num) || num <= 0) continue;
        value = num;
      }
      payload[field] = value;
      ttsState.config[field] = value;   // 同步内存中的 ttsState.config 缓存
    }
    if (Object.keys(payload).length === 0) {
      ui.status.textContent = "没有可保存的更改";
      ui.status.className = "save-status";
      return;
    }
    await window.tts!.saveSettings(payload);
    ui.status.textContent = "已保存";
    ui.status.className = "save-status is-ok";
    ui.btn.classList.add("is-hidden");
    setTimeout(() => { ui.status.textContent = ""; }, 2000);
  } catch (e) {
    ui.status.textContent = "保存失败：" + (e instanceof Error ? e.message : String(e));
    ui.status.className = "save-status is-error";
  } finally {
    ui.btn.disabled = false;
  }
}

// 注册点击 handler
for (const [provider, ui] of Object.entries(ttsProviderUi)) {
  ui?.btn.addEventListener("click", () => void saveTtsProvider(provider));
}

// GPT-SoVITS 格式选择（select，change 时直接保存）
(ttsEl("tts-gptsovits-format") as HTMLSelectElement).addEventListener("change", () => {
  void saveTtsField("ttsGptsovitsFormat", (ttsEl("tts-gptsovits-format") as HTMLSelectElement).value as "wav" | "mp3");
});

// 自定义云端格式选择
(ttsEl("tts-custom-cloud-format") as HTMLSelectElement).addEventListener("change", () => {
  void saveTtsField("ttsCustomCloudFormat", (ttsEl("tts-custom-cloud-format") as HTMLSelectElement).value as "wav" | "mp3");
});

// MiniMax 流式播放开关
ttsEl("tts-streaming").addEventListener("change", () => {
  void saveTtsField("ttsStreaming", ttsEl("tts-streaming").checked);
});

// MiniMax 语音增强开关
ttsEl("tts-minimax-vocal-enhance").addEventListener("change", () => {
  void saveTtsField("ttsMinimaxVocalEnhance", ttsEl("tts-minimax-vocal-enhance").checked);
});

// GPT-SoVITS 选择参考音频
document.getElementById("tts-gptsovits-ref-pick")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const filePath = await window.tts.pickAudioFile();
  if (filePath) {
    ttsEl("tts-gptsovits-ref-audio").value = filePath;
    void saveTtsField("ttsGptsovitsRefAudioPath", filePath);
  }
});

// GPT-SoVITS 测试发音
document.getElementById("tts-gptsovits-test")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const baseUrl = ttsEl("tts-gptsovits-url").value.trim();
  const refAudioPath = ttsEl("tts-gptsovits-ref-audio").value.trim();
  const promptText = ttsEl("tts-gptsovits-prompt-text").value.trim();
  const format = (ttsEl("tts-gptsovits-format") as HTMLSelectElement).value as "wav" | "mp3";
  if (!baseUrl) { window.alert("请先填写 GPT-SoVITS API 地址"); return; }
  if (!refAudioPath) { window.alert("请先选择参考音频文件"); return; }
  if (!promptText) { window.alert("请先填写参考音频对应的文本"); return; }

  const btn = document.getElementById("tts-gptsovits-test") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "合成中…";
  try {
    const result = await window.tts.synthesizeGptsovits({
      baseUrl, refAudioPath, promptText, text: TTS_TEST_TEXT, format,
    });
    playTtsAudio(result.base64, result.format);
  } catch (err) {
    window.alert("测试失败: " + (err instanceof Error ? err.message : String(err)));
  } finally {
    btn.disabled = false;
    btn.textContent = "🔊 测试发音";
  }
});

// 小米 MiMo 选择昔涟克隆参考音频
document.getElementById("tts-mimo-voice-pick")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const filePath = await window.tts.pickAudioFile();
  if (filePath) {
    ttsEl("tts-mimo-voice-audio").value = filePath;
    void saveTtsField("ttsMimoVoiceAudioPath", filePath);
  }
});

// 自定义云端测试发音
document.getElementById("tts-custom-cloud-test")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const endpointUrl = ttsEl("tts-custom-cloud-url").value.trim();
  const apiKey = ttsEl("tts-custom-cloud-key").value.trim();
  const voiceId = ttsEl("tts-custom-cloud-voice").value.trim();
  const format = (ttsEl("tts-custom-cloud-format") as HTMLSelectElement).value as "wav" | "mp3";
  const timeoutMs = Number(ttsEl("tts-custom-cloud-timeout").value) || 30000;
  if (!endpointUrl) { window.alert("请先填写自定义云端 Endpoint URL"); return; }

  const btn = document.getElementById("tts-custom-cloud-test") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "合成中…";
  try {
    const result = await window.tts.synthesizeCustomCloud({
      endpointUrl, apiKey, voiceId, text: TTS_TEST_TEXT,
      speed: Number(ttsEl("tts-speed").value),
      volume: Number(ttsEl("tts-volume").value),
      format,
      timeoutMs,
    });
    playTtsAudio(result.base64, result.format);
  } catch (err) {
    window.alert("测试失败: " + (err instanceof Error ? err.message : String(err)));
  } finally {
    btn.disabled = false;
    btn.textContent = "🔊 测试发音";
  }
});

// 小米 MiMo 测试发音
document.getElementById("tts-mimo-test")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const apiKey = ttsEl("tts-mimo-key").value.trim();
  const voiceAudioPath = ttsEl("tts-mimo-voice-audio").value.trim();
  const stylePrompt = ttsEl("tts-mimo-style").value.trim();
  if (!apiKey) { window.alert("请先填写小米 MiMo API Key"); return; }
  if (!voiceAudioPath) { window.alert("请先选择昔涟克隆参考音频"); return; }

  const btn = document.getElementById("tts-mimo-test") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "合成中…";
  try {
    const result = await window.tts.synthesizeMimo({
      apiKey, voiceAudioPath, stylePrompt, text: TTS_TEST_TEXT,
    });
    playTtsAudio(result.base64, result.format);
  } catch (err) {
    window.alert("测试失败: " + (err instanceof Error ? err.message : String(err)));
  } finally {
    btn.disabled = false;
    btn.textContent = "🔊 测试发音";
  }
});

// ── Mossland ──
// 当前为 UI 骨架：所有按钮触发"功能开发中"占位 modal，
// ── Mossland ──
// 第二步已接通：所有按钮走真实 IPC 调用，错误抛到 status / alert。
function setMosslandStatus(text: string, type: "ok" | "error" | "loading"): void {
  const el = document.getElementById("tts-mossland-clone-status");
  if (!el) return;
  el.textContent = text;
  el.className = "tts-clone-status" + (type ? " is-" + type : "");
}

function setMosslandListStatus(text: string, type: "ok" | "error" | "loading"): void {
  const el = document.getElementById("tts-mossland-list-voices-status");
  if (!el) return;
  el.textContent = text;
  el.className = "tts-clone-status" + (type ? " is-" + type : "");
}

/** 把拉到的 voices 列表渲染成 `<ul>`；每行有一个"使用此 voice"按钮，点击回填到 #tts-mossland-voice */
function renderMosslandVoiceList(voices: Array<{ id: string; name: string }>): void {
  const ul = document.getElementById("tts-mossland-voice-list");
  if (!ul) return;
  ul.replaceChildren();
  for (const v of voices) {
    const li = document.createElement("li");
    const idSpan = document.createElement("span");
    idSpan.className = "voice-id";
    idSpan.textContent = v.id;
    const nameSpan = document.createElement("span");
    nameSpan.className = "voice-name";
    nameSpan.textContent = v.name;
    const useBtn = document.createElement("button");
    useBtn.type = "button";
    useBtn.className = "voice-use";
    useBtn.textContent = "使用";
    useBtn.addEventListener("click", () => {
      ttsEl("tts-mossland-voice").value = v.id;
    });
    li.append(idSpan, nameSpan, useBtn);
    ul.appendChild(li);
  }
}

// 测试发音：走 window.tts.synthesizeMossland
document.getElementById("tts-mossland-test")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const apiKey = ttsEl("tts-mossland-key").value.trim();
  const voiceId = ttsEl("tts-mossland-voice").value.trim();
  const text = ttsEl("tts-mossland-text").value.trim();
  const model = (ttsEl("tts-mossland-model") as HTMLSelectElement).value;
  const format = (ttsEl("tts-mossland-format") as HTMLSelectElement).value as "mp3" | "wav" | "pcm";
  if (!apiKey) { window.alert("请先填写 Mossland API Key"); return; }
  if (!voiceId) { window.alert("请先填写音色 ID（可从下方拉取列表）"); return; }
  if (!text) { window.alert("请先填写试听文本"); return; }

  const btn = document.getElementById("tts-mossland-test") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "合成中…";
  const statusEl = document.getElementById("tts-mossland-test-status");
  if (statusEl) { statusEl.textContent = "合成中…"; statusEl.className = "tts-clone-status is-loading"; }
  try {
    const result = await window.tts.synthesizeMossland({
      apiKey, voiceId, text, model, format,
      speed: Number(ttsEl("tts-speed").value),
      volume: Number(ttsEl("tts-volume").value),
    });
    playTtsAudio(result.base64, result.format);
    if (statusEl) {
      statusEl.textContent = "✅ 合成成功";
      statusEl.className = "tts-clone-status is-ok";
      setTimeout(() => { statusEl.textContent = ""; }, 2000);
    }
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = "❌ " + (err instanceof Error ? err.message : String(err));
      statusEl.className = "tts-clone-status is-error";
    } else {
      window.alert("合成失败: " + (err instanceof Error ? err.message : String(err)));
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "测试发音";
  }
});


// 克隆子区块：选择文件（用现有 pickAudio）
document.getElementById("tts-mossland-clone-pick")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const filePath = await window.tts.pickAudio();
  if (filePath) ttsEl("tts-mossland-clone-file").value = filePath;
});

// 克隆子区块：开始上传（multipart）
document.getElementById("tts-mossland-clone-start")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const apiKey = ttsEl("tts-mossland-key").value.trim();
  const filePath = ttsEl("tts-mossland-clone-file").value.trim();
  const name = ttsEl("tts-mossland-clone-name").value.trim();
  const description = ttsEl("tts-mossland-clone-desc").value.trim();
  if (!apiKey) { window.alert("请先填写 Mossland API Key"); return; }
  if (!filePath) { window.alert("请先选择参考音频"); return; }

  setMosslandStatus("正在上传并创建音色…", "loading");
  try {
    const result = await window.tts.cloneMossland({
      apiKey, filePath,
      name: name || undefined,
      description: description || undefined,
    });
    // 自动填到上方「音色 ID」+ 同步写到 ttsState.config（让保存按钮 / chat 调度都能用）
    ttsEl("tts-mossland-voice").value = result.voiceId;
    void saveTtsField("ttsMosslandVoiceId", result.voiceId);
    setMosslandStatus(`✅ 克隆成功！voice_id「${result.voiceId}」已自动填入音色 ID 框。`, "ok");
  } catch (err) {
    setMosslandStatus("❌ " + (err instanceof Error ? err.message : String(err)), "error");
  }
});

// 拉取音色列表：调 listMosslandVoices + 渲染
document.getElementById("tts-mossland-list-voices")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const apiKey = ttsEl("tts-mossland-key").value.trim();
  if (!apiKey) { window.alert("请先填写 Mossland API Key"); return; }

  setMosslandListStatus("正在拉取音色列表…", "loading");
  try {
    const result = await window.tts.listMosslandVoices({ apiKey, limit: 50 });
    if (result.voices.length === 0) {
      setMosslandListStatus("账号下还没有已克隆的音色，请先到上方「音色克隆」创建一个。", "error");
    } else {
      renderMosslandVoiceList(result.voices);
      setMosslandListStatus(`✅ 拉到 ${result.voices.length} 个音色。点击右侧「使用」可填入音色 ID 框。`, "ok");
    }
  } catch (err) {
    setMosslandListStatus("❌ " + (err instanceof Error ? err.message : String(err)), "error");
  }
});

// 克隆须知 modal（富文本，复用 showHtmlModal 复用 MiniMax 那套样式）
document.getElementById("tts-mossland-clone-info-btn")?.addEventListener("click", () => {
  void showHtmlModal({
    title: "Mossland 音色克隆 · 完整规格",
    icon: "ⓘ",
    htmlBody: [
      '<div class="tts-clone-spec-block">',
      '  <h4><svg class="tts-clone-spec-icon" width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M24 44C35.0457 44 44 35.0457 44 24C44 12.9543 35.0457 4 24 4C12.9543 4 4 12.9543 4 24C4 35.0457 12.9543 44 24 44Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M18 22H30" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 28H30" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24.0083 22V34" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M30 15L24 21L18 15" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg> 费用</h4>',
      '  <p>请参阅 Mossland 平台定价页（文档未提供具体单价）。每次成功创建 voice_id 都会计费。',
      '     与 MiniMax 不同：<strong>Mossland 没有「7 天过期」</strong>，voice_id 永久有效。</p>',
      '</div>',
      '<div class="tts-clone-spec-block">',
      '  <h4><svg class="tts-clone-spec-icon" width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M7 4H41" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 44H41" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M11 44C13.6667 30.6611 18 23.9944 24 24C30 24.0056 34.3333 30.6722 37 44H11Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M37 4C34.3333 17.3389 30 24.0056 24 24C18 23.9944 13.6667 17.3278 11 4H37Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M21 15H27" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 38H29" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg> 持久化规则</h4>',
      '  <p>创建的 voice_id <strong>永久有效</strong>，无过期、无冷却。直接复制到「音色 ID」即可永久复用。</p>',
      '</div>',
      '<div class="tts-clone-spec-block">',
      '  <h4><svg class="tts-clone-spec-icon" width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 44V4H31L40 14.5V44H8Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M32 14L26 16.9688V31.5" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="20.5" cy="31.5" r="5.5" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg> 参考音频 <code>audio_sample</code></h4>',
      '  <ul>',
      '    <li>请求格式：<strong>multipart/form-data</strong>（不支持 JSON / URL / base64）</li>',
      '    <li>字段名：<code>audio_sample</code>（必填）</li>',
      '    <li>字段名：<code>name</code>（可选，给音色起名）</li>',
      '    <li>字段名：<code>description</code>（可选，描述音色）</li>',
      '    <li>时长限制：≤ 60 秒（实测，官方文档未标注）</li>',
      '    <li>格式：文档示例为 wav</li>',
      '  </ul>',
      '</div>',
      '<div class="tts-clone-spec-block">',
      '  <h4><svg class="tts-clone-spec-icon" width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="24" cy="24" r="18" fill="none" stroke="currentColor" stroke-width="4"/><path d="M24 14V16" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><circle cx="24" cy="32" r="2.5" fill="currentColor"/></svg> 后续合成</h4>',
      '  <ul>',
      '    <li>拿到 voice_id 后，调用 <code>POST /v1/audio/speech</code>，body 形如 <code>{ model: "moss-tts", input: "...", voice_id: "..." }</code></li>',
      '    <li>可选 <code>delivery_method: "audio" \| "url"</code>（默认 audio，二进制流；url 返回 JSON 含 URL）</li>',
      '    <li><code>version</code> 字段为预留能力，当前请不传，服务端使用默认版本</li>',
      '  </ul>',
      '</div>',
    ].join("\n"),
  });
});

// MiniMax 测试发音
document.getElementById("tts-minimax-test")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const apiKey = ttsEl("tts-minimax-key").value.trim();
  const voiceId = ttsEl("tts-minimax-voice").value.trim();
  const modelSelect = ttsEl("tts-minimax-model") as HTMLSelectElement;
  const model = modelSelect.value === "speech-2.8-hd" ? "speech-2.8-hd" : "speech-2.8-turbo";
  if (!apiKey) { window.alert("请先填写 MiniMax API Key"); return; }
  if (!voiceId) { window.alert("请先填写音色 ID（或下方复刻训练）"); return; }

  const btn = document.getElementById("tts-minimax-test") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "合成中…";
  try {
    const vocalEnhance = { enabled: ttsEl("tts-minimax-vocal-enhance").checked };
    const base64 = await window.tts.synthesize({ apiKey, voiceId, text: TTS_TEST_TEXT, model, vocalEnhance });
    playTtsAudio(base64);
  } catch (err) {
    window.alert("测试失败: " + (err instanceof Error ? err.message : String(err)));
  } finally {
    btn.disabled = false;
    btn.textContent = "🔊 测试发音";
  }
});

// ── 音色快速复刻 ──
// 选择配音文件
document.getElementById("tts-clone-pick")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const filePath = await window.tts.pickAudio();
  if (filePath) ttsEl("tts-clone-file").value = filePath;
});

// 选择示例音频
document.getElementById("tts-clone-prompt-pick")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const filePath = await window.tts.pickAudio();
  if (filePath) ttsEl("tts-clone-prompt-file").value = filePath;
});

// 设置复刻状态文案
function setCloneStatus(text: string, type: "ok" | "error" | "loading"): void {
  const el = document.getElementById("tts-clone-status");
  if (!el) return;
  el.textContent = text;
  el.className = "tts-clone-status" + (type ? " is-" + type : "");
}

// 开始复刻
document.getElementById("tts-clone-start")?.addEventListener("click", async () => {
  if (!window.tts) return;
  const apiKey = ttsEl("tts-minimax-key").value.trim();
  const cloneFile = ttsEl("tts-clone-file").value.trim();
  const promptFile = ttsEl("tts-clone-prompt-file").value.trim();
  const promptText = ttsEl("tts-clone-prompt-text").value.trim();
  const cloneText = ttsEl("tts-clone-text").value.trim();
  const voiceId = ttsEl("tts-clone-voice-id").value.trim();

  if (!apiKey) { window.alert("请先填写 MiniMax API Key"); return; }
  if (!cloneFile) { window.alert("请选择配音文件"); return; }
  if (!cloneText) { window.alert("请填写复刻文本"); return; }
  if (!voiceId) { window.alert("请填写音色命名"); return; }

  const btn = document.getElementById("tts-clone-start") as HTMLButtonElement;
  btn.disabled = true;
  setCloneStatus("正在上传配音文件…", "loading");

  try {
    // 步骤1: 上传配音文件
    const cloneUpload = await window.tts.upload(apiKey, cloneFile, "voice_clone");
    setCloneStatus("配音文件上传完成 (file_id: " + cloneUpload.file_id + ")，正在上传示例音频…", "loading");

    // 步骤2: 上传示例音频（可选）
    let promptFileId: string | undefined;
    if (promptFile) {
      const promptUpload = await window.tts.upload(apiKey, promptFile, "prompt_audio");
      promptFileId = promptUpload.file_id;
      setCloneStatus("示例音频上传完成，正在训练音色…", "loading");
    } else {
      setCloneStatus("正在训练音色…", "loading");
    }

    // 步骤3: 音色克隆
    const result = await window.tts.clone({
      apiKey, fileId: cloneUpload.file_id, voiceId,
      promptAudioId: promptFileId, promptText: promptText || undefined,
      text: cloneText,
    });

    // 自动填入音色 ID
    ttsEl("tts-minimax-voice").value = result.voiceId;
    void saveTtsField("ttsMinimaxVoiceId", result.voiceId);

    setCloneStatus("✅ 复刻成功！音色 ID「" + result.voiceId + "」已自动填入。", "ok");

    // 如果有试听音频，播放
    if (result.audioDemo) {
      try {
        const resp = await fetch(result.audioDemo);
        const buf = await resp.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        playTtsAudio(base64);
      } catch { /* 试听音频播放失败不影响主流程 */ }
    }
  } catch (err) {
    setCloneStatus("❌ " + (err instanceof Error ? err.message : String(err)), "error");
  } finally {
    btn.disabled = false;
  }
});

// ── 音色快速复刻：规格说明模态框 ──
// 字段顺序：file_id → voice_id → clone_prompt(prompt_audio / prompt_text) → text(试听)
const CLONE_SPEC_BODY = [
  '<div class="tts-clone-spec-block">',
  '  <h4>',
  '    <svg class="tts-clone-spec-icon" width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
  '      <path d="M24 44C35.0457 44 44 35.0457 44 24C44 12.9543 35.0457 4 24 4C12.9543 4 4 12.9543 4 24C4 35.0457 12.9543 44 24 44Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>',
  '      <path d="M18 22H30" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M18 28H30" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M24.0083 22V34" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M30 15L24 21L18 15" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '    </svg>',
  '    费用',
  '  </h4>',
  '  <p>每次成功发起复刻将收取 <span class="tts-clone-fee">¥9.9</span>。',
  '     试听（<code>text</code> + <code>model</code>）按字符数另计 T2A 费用，与平台其他 T2A 接口同价。</p>',
  '</div>',
  '<div class="tts-clone-spec-block">',
  '  <h4>',
  '    <svg class="tts-clone-spec-icon" width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
  '      <path d="M7 4H41" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M7 44H41" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M11 44C13.6667 30.6611 18 23.9944 24 24C30 24.0056 34.3333 30.6722 37 44H11Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>',
  '      <path d="M37 4C34.3333 17.3389 30 24.0056 24 24C18 23.9944 13.6667 17.3278 11 4H37Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>',
  '      <path d="M21 15H27" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M19 38H29" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '    </svg>',
  '    过期规则',
  '  </h4>',
  '  <p>复刻得到的音色若 <strong>7 天内</strong>无任何调用，将被系统自动删除。如需长期保留音色，平时不定期点一下「🔊 测试发音」即可续命。</p>',
  '</div>',
  '<div class="tts-clone-spec-block">',
  '  <h4>',
  '    <svg class="tts-clone-spec-icon" width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
  '      <path d="M8 44V4H31L40 14.5V44H8Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M32 14L26 16.9688V31.5" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <circle cx="20.5" cy="31.5" r="5.5" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '    </svg>',
  '    配音文件 <code>file_id</code>（必填）',
  '  </h4>',
  '  <ul>',
  '    <li>格式：mp3 / m4a / wav</li>',
  '    <li>时长：10 秒 ~ 5 分钟</li>',
  '    <li>大小：≤ 20 MB</li>',
  '  </ul>',
  '</div>',
  '<div class="tts-clone-spec-block">',
  '  <h4>',
  '    <svg class="tts-clone-spec-icon" width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
  '      <path d="M10 10H32H38V44H10V10Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M10 10L32 4V10" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <circle cx="24" cy="24" r="4" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M20 34H28" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '    </svg>',
  '    自定义 voice_id（必填）',
  '  </h4>',
  '  <ul>',
  '    <li>长度范围：8 ~ 256 个字符</li>',
  '    <li>首字符必须为英文字母</li>',
  '    <li>允许：数字、字母、<code>-</code>、<code>_</code></li>',
  '    <li>末位字符不可为 <code>-</code> 或 <code>_</code></li>',
  '    <li>不得与已有 voice_id 重复</li>',
  '  </ul>',
  '</div>',
  '<div class="tts-clone-spec-block">',
  '  <h4>',
  '    <svg class="tts-clone-spec-icon" width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
  '      <path d="M24 44C35.0457 44 44 35.0457 44 24C44 12.9543 35.0457 4 24 4C12.9543 4 4 12.9543 4 24C4 35.0457 12.9543 44 24 44Z" fill="none" stroke="currentColor" stroke-width="4"/>',
  '      <path d="M30 18V30" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  '      <path d="M36 22V26" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  '      <path d="M18 18V30" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  '      <path d="M12 22V26" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  '      <path d="M24 14V34" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  '    </svg>',
  '    示例音频 clone_prompt（可选，强烈推荐）',
  '  </h4>',
  '  <p>提供一段示例音频可显著增强合成音色的相似度与稳定性。</p>',
  '  <ul>',
  '    <li>格式：mp3 / m4a / wav</li>',
  '    <li>时长：&lt; 8 秒</li>',
  '    <li>大小：≤ 20 MB</li>',
  '    <li>须填写对应的示例文本 <code>prompt_text</code>，句末需有标点</li>',
  '  </ul>',
  '</div>',
  '<div class="tts-clone-spec-block">',
  '  <h4>',
  '    <svg class="tts-clone-spec-icon" width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
  '      <path d="M40 33V42C40 43.1046 39.1046 44 38 44H31.5" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M40 16V6C40 4.89543 39.1046 4 38 4H10C8.89543 4 8 4.89543 8 6V42C8 43.1046 8.89543 44 10 44H16" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  '      <path d="M16 16H30" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  '      <path d="M23 44L40 23" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  '      <path d="M16 24H24" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  '    </svg>',
  '    复刻文本 <code>text</code>（试听用，建议 ≤1000 字符）',
  '  </h4>',
  '  <p>模型会用克隆后的音色朗读这段文本并返回试听音频链接，便于人工核对相似度。</p>',
  '</div>',
].join("\n");

function showCloneSpecModal(): void {
  void showHtmlModal({
    title: "🎙️ 音色快速复刻 · 完整规格",
    icon: "ⓘ",
    htmlBody: CLONE_SPEC_BODY,
  });
}

document.getElementById("tts-clone-info-btn")?.addEventListener("click", showCloneSpecModal);
document.getElementById("tts-clone-info-link")?.addEventListener("click", showCloneSpecModal);

// 初始加载配置
void loadTtsConfig();