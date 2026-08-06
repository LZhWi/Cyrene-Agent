import * as fs from "fs";
import {
  DEFAULT_WINDOW_CORNER_RADIUS,
  normalizeWindowCornerRadius,
} from "../../shared/window-corner-radius";
import { DEFAULT_UI_FONT, normalizeUiFont } from "../../shared/ui-font";
import {
  DEFAULT_CUSTOM_STYLE,
  normalizeCustomStyleConfig,
  normalizeStyleId,
} from "../../shared/style-sampling";
import { normalizeUiTheme } from "../../shared/ui-theme";
import { normalizeUiIcon } from "../../shared/ui-icon";
import { normalizeChatAppearance } from "../../shared/chat-appearance";
import {
  normalizeChatSocialContextEnabled,
  normalizeDefaultChatMode,
  normalizeMobileMessageSegmentationMode,
  normalizeProactiveChatMode,
  normalizeProactiveDeliveryTarget,
  normalizeSegmentedOutputMode,
} from "../../shared/preferences";
import { normalizeWindowVisibilitySettings } from "../window-visibility-settings";
import { normalizeCitaSettings } from "../cita/settings";
import { getGeneralSettingsPath } from "../settings-store";
import type { GeneralSettings } from "./general-settings";

const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  citaEnabled: false,
  citaSemanticEngine: "remote",
  chatSocialContextEnabled: false,
  petAlwaysOnTop: true,
  petVisible: true,
  petZoom: 1,
  sidebarVisible: true,
  tasksVisible: true,
  launchAtLogin: false,
  language: "zh-CN",
  uiTheme: "pearl-white",
  windowCornerRadius: DEFAULT_WINDOW_CORNER_RADIUS,
  uiThemeRadius: false,
  uiFont: DEFAULT_UI_FONT,
  uiIcon: "cyrene-sun",
  defaultChatMode: "chat",
  currentStyleId: "default",
  customStyle: DEFAULT_CUSTOM_STYLE,
  segmentedOutputMode: "off",
  mobileMessageSegmentation: "off",
  proactiveChatMode: "off",
  proactiveDeliveryTarget: "local",
  ttsEngine: "off",
  ttsAutoRead: true,
  ttsSpeed: 1,
  ttsVolume: 1,
  ttsMinimaxKey: "",
  ttsMinimaxVoiceId: "",
  ttsMinimaxModel: "speech-2.8-turbo",
  ttsStreaming: true,
  ttsMinimaxVocalEnhance: true,
  ttsGptsovitsBaseUrl: "http://localhost:9880",
  ttsGptsovitsRefAudioPath: "",
  ttsGptsovitsPromptText: "",
  ttsGptsovitsFormat: "wav",
  ttsGptsovitsTimeoutMs: 180_000,
  ttsCustomCloudEndpointUrl: "",
  ttsCustomCloudApiKey: "",
  ttsCustomCloudVoiceId: "",
  ttsCustomCloudFormat: "mp3",
  ttsCustomCloudTimeoutMs: 30000,
  ttsMimoKey: "",
  ttsMimoVoiceAudioPath: "",
  ttsMimoStylePrompt: "温柔、自然、略带亲近感，像在轻声陪用户聊天。",
  ttsMosslandKey: "",
  ttsMosslandVoiceId: "",
  ttsMosslandModel: "moss-tts",
  ttsMosslandTestText: "你好呀，我是昔涟。今天也请多多关照♪",
  ttsMosslandFormat: "mp3",
  weatherSource: "open-meteo",
  weatherEnabled: false,
  amapKey: "",
  travelEnabled: false,
  playwrightMcpEnabled: false,
  searchEngine: "off",
  searchBochaKey: "",
  searchTavilyKey: "",
  searchMinimaxKey: "",
  searchAnySearchKey: "",
  emailEnabled: false,
  emailSmtpHost: "",
  emailSmtpPort: 465,
  emailSmtpSecure: true,
  emailSmtpUser: "",
  emailSmtpPass: "",
  emailFromName: "",
  asrEngine: "off",
  asrAliyunAppKey: "",
  asrAliyunAccessKeyId: "",
  asrAliyunAccessKeySecret: "",
  asrLanguage: "zh",
  asrVadSilenceMs: 1000,
  asrVadThreshold: 0.01,
  asrShowTranscript: false,
  screenshotHotkey: "Alt+Shift+S",
  chatLineHeight: 1.75,
  assistantBubbleEnabled: true,
};

const listeners = new Set<(before: GeneralSettings, after: GeneralSettings) => void>();

let generalSettingsCache: GeneralSettings | null = null;

export function onGeneralSettingsChanged(
  listener: (before: GeneralSettings, after: GeneralSettings) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyGeneralSettingsChanged(before: GeneralSettings, after: GeneralSettings): void {
  for (const listener of listeners) {
    listener(before, after);
  }
}

function normalizeGeneralSettings(
  input: Partial<GeneralSettings> | null | undefined,
): GeneralSettings {
  const windowVisibility = normalizeWindowVisibilitySettings(input);
  const cita = normalizeCitaSettings({
    enabled: input?.citaEnabled,
    semanticEngine: input?.citaSemanticEngine,
  });
  const clamp = (value: unknown, fallback: number) => {
    const num = typeof value === "number" ? value : Number(value);
    return Number.isFinite(num) ? Math.max(0, Math.min(100, Math.round(num))) : fallback;
  };
  const clampPort = (value: unknown, fallback: number) => {
    const num = typeof value === "number" ? value : Number(value);
    return Number.isFinite(num) ? Math.max(1, Math.min(65535, Math.round(num))) : fallback;
  };
  const clampMs = (value: unknown, fallback: number) => {
    const num = typeof value === "number" ? value : Number(value);
    return Number.isFinite(num) ? Math.max(1000, Math.min(120000, Math.round(num))) : fallback;
  };
  return {
    citaEnabled: cita.enabled,
    citaSemanticEngine: cita.semanticEngine,
    chatSocialContextEnabled: normalizeChatSocialContextEnabled(input?.chatSocialContextEnabled),
    petAlwaysOnTop: input?.petAlwaysOnTop === undefined
      ? DEFAULT_GENERAL_SETTINGS.petAlwaysOnTop
      : Boolean(input.petAlwaysOnTop),
    petVisible: input?.petVisible === undefined
      ? DEFAULT_GENERAL_SETTINGS.petVisible
      : Boolean(input.petVisible),
    petZoom: typeof input?.petZoom === "number"
      ? Math.max(0.5, Math.min(2, input.petZoom))
      : DEFAULT_GENERAL_SETTINGS.petZoom,
    petWindowX: typeof input?.petWindowX === "number" && isFinite(input.petWindowX)
      ? Math.round(input.petWindowX)
      : undefined,
    petWindowY: typeof input?.petWindowY === "number" && isFinite(input.petWindowY)
      ? Math.round(input.petWindowY)
      : undefined,
    disableGpuElectron: input?.disableGpuElectron,
    sidebarVisible: windowVisibility.sidebarVisible,
    tasksVisible: windowVisibility.tasksVisible,
    launchAtLogin: Boolean(input?.launchAtLogin),
    language: "zh-CN",
    uiTheme: normalizeUiTheme(input?.uiTheme),
    windowCornerRadius: normalizeWindowCornerRadius(input?.windowCornerRadius),
    uiThemeRadius: input?.uiThemeRadius ?? true,
    uiFont: normalizeUiFont(input?.uiFont),
    uiIcon: normalizeUiIcon(input?.uiIcon),
    defaultChatMode: normalizeDefaultChatMode(input?.defaultChatMode),
    currentStyleId: normalizeStyleId(input?.currentStyleId),
    customStyle: normalizeCustomStyleConfig(input?.customStyle),
    segmentedOutputMode: normalizeSegmentedOutputMode(input?.segmentedOutputMode),
    mobileMessageSegmentation: normalizeMobileMessageSegmentationMode(input?.mobileMessageSegmentation),
    proactiveChatMode: normalizeProactiveChatMode(input?.proactiveChatMode),
    proactiveDeliveryTarget: normalizeProactiveDeliveryTarget(input?.proactiveDeliveryTarget),
    ttsEngine: (["off", "minimax", "gptsovits", "custom-cloud", "mimo", "mossland"].includes(input?.ttsEngine as string)
      ? input?.ttsEngine
      : "off") as GeneralSettings["ttsEngine"],
    ttsAutoRead: input?.ttsAutoRead === undefined
      ? DEFAULT_GENERAL_SETTINGS.ttsAutoRead
      : Boolean(input.ttsAutoRead),
    ttsSpeed: typeof input?.ttsSpeed === "number"
      ? Math.max(0.5, Math.min(2, input.ttsSpeed))
      : DEFAULT_GENERAL_SETTINGS.ttsSpeed,
    ttsVolume: typeof input?.ttsVolume === "number"
      ? Math.max(0, Math.min(1, input.ttsVolume))
      : DEFAULT_GENERAL_SETTINGS.ttsVolume,
    ttsMinimaxKey: typeof input?.ttsMinimaxKey === "string" ? input.ttsMinimaxKey : "",
    ttsMinimaxVoiceId: typeof input?.ttsMinimaxVoiceId === "string" ? input.ttsMinimaxVoiceId : "",
    ttsMinimaxModel: input?.ttsMinimaxModel === "speech-2.8-hd" ? "speech-2.8-hd" : "speech-2.8-turbo",
    ttsStreaming: input?.ttsStreaming === undefined ? true : Boolean(input.ttsStreaming),
    ttsMinimaxVocalEnhance: input?.ttsMinimaxVocalEnhance === undefined
      ? DEFAULT_GENERAL_SETTINGS.ttsMinimaxVocalEnhance
      : Boolean(input.ttsMinimaxVocalEnhance),
    weatherSource: ["open-meteo", "amap"].includes(String(input?.weatherSource))
      ? (input!.weatherSource as "open-meteo" | "amap")
      : "open-meteo",
    weatherEnabled: Boolean(input?.weatherEnabled),
    amapKey: typeof input?.amapKey === "string" ? input.amapKey : "",
    travelEnabled: Boolean(input?.travelEnabled),
    playwrightMcpEnabled: Boolean(input?.playwrightMcpEnabled),
    searchEngine: ["off", "bocha", "tavily", "minimax", "anySearch"].includes(String(input?.searchEngine))
      ? (input!.searchEngine as "off" | "bocha" | "tavily" | "minimax" | "anySearch")
      : "off",
    searchBochaKey: typeof input?.searchBochaKey === "string" ? input.searchBochaKey : "",
    searchTavilyKey: typeof input?.searchTavilyKey === "string" ? input.searchTavilyKey : "",
    searchMinimaxKey: typeof input?.searchMinimaxKey === "string" ? input.searchMinimaxKey : "",
    searchAnySearchKey: typeof input?.searchAnySearchKey === "string" ? input.searchAnySearchKey : "",
    emailEnabled: Boolean(input?.emailEnabled),
    emailSmtpHost: typeof input?.emailSmtpHost === "string" ? input.emailSmtpHost : "",
    emailSmtpPort: clampPort(input?.emailSmtpPort, DEFAULT_GENERAL_SETTINGS.emailSmtpPort),
    emailSmtpSecure: input?.emailSmtpSecure === undefined
      ? (clampPort(input?.emailSmtpPort, DEFAULT_GENERAL_SETTINGS.emailSmtpPort) === 465)
      : Boolean(input.emailSmtpSecure),
    emailSmtpUser: typeof input?.emailSmtpUser === "string" ? input.emailSmtpUser : "",
    emailSmtpPass: typeof input?.emailSmtpPass === "string" ? input.emailSmtpPass : "",
    emailFromName: typeof input?.emailFromName === "string" ? input.emailFromName : "",
    asrEngine: ["off", "aliyun", "local"].includes(String(input?.asrEngine))
      ? (input!.asrEngine as "off" | "aliyun" | "local")
      : "off",
    asrAliyunAppKey: typeof input?.asrAliyunAppKey === "string" ? input.asrAliyunAppKey : "",
    asrAliyunAccessKeyId: typeof input?.asrAliyunAccessKeyId === "string" ? input.asrAliyunAccessKeyId : "",
    asrAliyunAccessKeySecret: typeof input?.asrAliyunAccessKeySecret === "string" ? input.asrAliyunAccessKeySecret : "",
    asrLanguage: ["zh", "en", "auto"].includes(String(input?.asrLanguage))
      ? (input!.asrLanguage as "zh" | "en" | "auto")
      : "zh",
    asrVadSilenceMs: typeof input?.asrVadSilenceMs === "number"
      ? Math.max(300, Math.min(30000, Math.round(input.asrVadSilenceMs)))
      : DEFAULT_GENERAL_SETTINGS.asrVadSilenceMs,
    asrVadThreshold: typeof input?.asrVadThreshold === "number"
      ? Math.max(0.001, Math.min(0.5, Number(input.asrVadThreshold)))
      : DEFAULT_GENERAL_SETTINGS.asrVadThreshold,
    asrShowTranscript: Boolean(input?.asrShowTranscript),
    screenshotHotkey: typeof input?.screenshotHotkey === "string" && input.screenshotHotkey.trim()
      ? input.screenshotHotkey.trim()
      : DEFAULT_GENERAL_SETTINGS.screenshotHotkey,
    ttsGptsovitsBaseUrl: typeof input?.ttsGptsovitsBaseUrl === "string"
      ? input.ttsGptsovitsBaseUrl
      : DEFAULT_GENERAL_SETTINGS.ttsGptsovitsBaseUrl,
    ttsGptsovitsRefAudioPath: typeof input?.ttsGptsovitsRefAudioPath === "string" ? input.ttsGptsovitsRefAudioPath : "",
    ttsGptsovitsPromptText: typeof input?.ttsGptsovitsPromptText === "string" ? input.ttsGptsovitsPromptText : "",
    ttsGptsovitsFormat: input?.ttsGptsovitsFormat === "mp3" ? "mp3" : "wav",
    ttsGptsovitsTimeoutMs: typeof input?.ttsGptsovitsTimeoutMs === "number" && Number.isFinite(input.ttsGptsovitsTimeoutMs)
      ? Math.max(10_000, Math.min(3_600_000, Math.round(input.ttsGptsovitsTimeoutMs)))
      : DEFAULT_GENERAL_SETTINGS.ttsGptsovitsTimeoutMs,
    ttsCustomCloudEndpointUrl: typeof input?.ttsCustomCloudEndpointUrl === "string" ? input.ttsCustomCloudEndpointUrl : "",
    ttsCustomCloudApiKey: typeof input?.ttsCustomCloudApiKey === "string" ? input.ttsCustomCloudApiKey : "",
    ttsCustomCloudVoiceId: typeof input?.ttsCustomCloudVoiceId === "string" ? input.ttsCustomCloudVoiceId : "",
    ttsCustomCloudFormat: input?.ttsCustomCloudFormat === "wav" ? "wav" : "mp3",
    ttsCustomCloudTimeoutMs: clampMs(input?.ttsCustomCloudTimeoutMs, DEFAULT_GENERAL_SETTINGS.ttsCustomCloudTimeoutMs),
    ttsMimoKey: typeof input?.ttsMimoKey === "string" ? input.ttsMimoKey : "",
    ttsMimoVoiceAudioPath: typeof input?.ttsMimoVoiceAudioPath === "string" ? input.ttsMimoVoiceAudioPath : "",
    ttsMimoStylePrompt: typeof input?.ttsMimoStylePrompt === "string"
      ? input.ttsMimoStylePrompt
      : DEFAULT_GENERAL_SETTINGS.ttsMimoStylePrompt,
    ttsMosslandKey: typeof input?.ttsMosslandKey === "string" ? input.ttsMosslandKey : "",
    ttsMosslandVoiceId: typeof input?.ttsMosslandVoiceId === "string" ? input.ttsMosslandVoiceId : "",
    ttsMosslandModel: typeof input?.ttsMosslandModel === "string" ? input.ttsMosslandModel : DEFAULT_GENERAL_SETTINGS.ttsMosslandModel,
    ttsMosslandTestText: typeof input?.ttsMosslandTestText === "string" ? input.ttsMosslandTestText : DEFAULT_GENERAL_SETTINGS.ttsMosslandTestText,
    ttsMosslandFormat: input?.ttsMosslandFormat === "wav" || input?.ttsMosslandFormat === "pcm"
      ? input.ttsMosslandFormat
      : "mp3",
    ...normalizeChatAppearance(input),
  };
}

function loadGeneralSettings0(): GeneralSettings {
  try {
    const filePath = getGeneralSettingsPath();
    if (!fs.existsSync(filePath)) return { ...DEFAULT_GENERAL_SETTINGS };
    return normalizeGeneralSettings(
      JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<GeneralSettings>,
    );
  } catch (err) {
    console.error("[Cyrene] load general settings failed:", err);
    return { ...DEFAULT_GENERAL_SETTINGS };
  }
}

export function loadGeneralSettings(): GeneralSettings {
  if (generalSettingsCache !== null) return generalSettingsCache;
  return (generalSettingsCache = loadGeneralSettings0());
}

export function saveGeneralSettings(partial: Partial<GeneralSettings>): GeneralSettings {
  const before = loadGeneralSettings();
  const normalized = normalizeGeneralSettings({ ...before, ...partial });
  const filePath = getGeneralSettingsPath();
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2));
  generalSettingsCache = normalized;
  notifyGeneralSettingsChanged(before, normalized);
  return normalized;
}
