import * as fs from "fs";
import * as path from "path";
import { DEFAULT_UI_FONT, normalizeUiFont, type UiFont } from "../../shared/ui-font";
import { normalizeUiIcon, type UiIcon } from "../../shared/ui-icon";
import { normalizeUiTheme, type UiTheme } from "../../shared/ui-theme";
import {
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
import type { GptsovitsTextSplitMethod, GptsovitsVersion } from "../../shared/tts-types";
import { normalizeAsrHotwords, normalizeLocalAsrProfile } from "../asr/asr-settings";
import { writeJsonAtomicSync } from "../runtime/atomic-file";
import { normalizeWindowVisibilitySettings } from "../window-visibility-settings";

export interface GeneralSettings {
  musicEnabled: boolean;
  musicVolume: number;
  soundEnabled: boolean;
  soundVolume: number;
  petAlwaysOnTop: boolean;
  petVisible: boolean;
  petZoom: number;
  petIdleMotionsEnabled: boolean;
  petWindowX?: number;
  petWindowY?: number;
  sidebarVisible: boolean;
  tasksVisible: boolean;
  launchAtLogin: boolean;
  language: "zh-CN";
  uiTheme: UiTheme;
  uiFont: UiFont;
  uiIcon: UiIcon;
  defaultChatMode: DefaultChatMode;
  segmentedOutputMode: SegmentedOutputMode;
  mobileMessageSegmentation: MobileMessageSegmentationMode;
  proactiveChatMode: ProactiveChatMode;
  proactiveDeliveryTarget: ProactiveDeliveryTarget;
  proactiveFeedbackEnabled: boolean;
  socialContextEnabled: boolean;
  screenMonitorEnabled: boolean;
  ttsEngine: "off" | "minimax" | "gptsovits" | "custom-cloud" | "mimo";
  ttsAutoRead: boolean;
  ttsSpeed: number;
  ttsVolume: number;
  ttsMinimaxKey: string;
  ttsMinimaxVoiceId: string;
  ttsMinimaxModel: "speech-2.8-hd" | "speech-2.8-turbo";
  ttsStreaming: boolean;
  ttsGptsovitsBaseUrl: string;
  ttsGptsovitsRefAudioPath: string;
  ttsGptsovitsPromptText: string;
  ttsGptsovitsFormat: "wav" | "mp3";
  ttsGptsovitsVersion: GptsovitsVersion;
  ttsGptsovitsGptWeightsPath: string;
  ttsGptsovitsSovitsWeightsPath: string;
  ttsGptsovitsTextSplitMethod: GptsovitsTextSplitMethod;
  ttsGptsovitsTopK: number;
  ttsGptsovitsTopP: number;
  ttsGptsovitsTemperature: number;
  ttsGptsovitsRepetitionPenalty: number;
  ttsGptsovitsSampleSteps: number;
  ttsCustomCloudEndpointUrl: string;
  ttsCustomCloudApiKey: string;
  ttsCustomCloudVoiceId: string;
  ttsCustomCloudFormat: "wav" | "mp3";
  ttsCustomCloudTimeoutMs: number;
  ttsMimoKey: string;
  ttsMimoVoiceAudioPath: string;
  ttsMimoStylePrompt: string;
  weatherSource: "open-meteo" | "amap";
  weatherEnabled: boolean;
  amapKey: string;
  travelEnabled: boolean;
  playwrightMcpEnabled: boolean;
  searchEngine: "off" | "bocha" | "tavily" | "minimax";
  searchBochaKey: string;
  searchTavilyKey: string;
  searchMinimaxKey: string;
  emailEnabled: boolean;
  emailSmtpHost: string;
  emailSmtpPort: number;
  emailSmtpSecure: boolean;
  emailSmtpUser: string;
  emailSmtpPass: string;
  emailFromName: string;
  asrEngine: "off" | "aliyun" | "local";
  asrAliyunAppKey: string;
  asrAliyunAccessKeyId: string;
  asrAliyunAccessKeySecret: string;
  asrLanguage: "zh" | "en" | "auto";
  asrLocalProfile: "qwen17-stream" | "paraformer-qwen17" | "qwen06-stream";
  asrHotwords: string[];
  asrVadSilenceMs: number;
  asrVadThreshold: number;
  asrShowTranscript: boolean;
  openerMode: "off" | "quiet" | "normal" | "lively";
}

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  musicEnabled: false,
  musicVolume: 60,
  soundEnabled: true,
  soundVolume: 70,
  petAlwaysOnTop: true,
  petVisible: true,
  petZoom: 1,
  petIdleMotionsEnabled: false,
  sidebarVisible: true,
  tasksVisible: true,
  launchAtLogin: false,
  language: "zh-CN",
  uiTheme: "classic",
  uiFont: DEFAULT_UI_FONT,
  uiIcon: "cyrene-sun",
  defaultChatMode: "collab",
  segmentedOutputMode: "off",
  mobileMessageSegmentation: "off",
  proactiveChatMode: "off",
  proactiveDeliveryTarget: "local",
  proactiveFeedbackEnabled: true,
  socialContextEnabled: false,
  screenMonitorEnabled: false,
  ttsEngine: "off",
  ttsAutoRead: true,
  ttsSpeed: 1,
  ttsVolume: 1,
  ttsMinimaxKey: "",
  ttsMinimaxVoiceId: "",
  ttsMinimaxModel: "speech-2.8-turbo",
  ttsStreaming: true,
  ttsGptsovitsBaseUrl: "http://localhost:9880",
  ttsGptsovitsRefAudioPath: "",
  ttsGptsovitsPromptText: "",
  ttsGptsovitsFormat: "wav",
  ttsGptsovitsVersion: "auto",
  ttsGptsovitsGptWeightsPath: "",
  ttsGptsovitsSovitsWeightsPath: "",
  ttsGptsovitsTextSplitMethod: "cut5",
  ttsGptsovitsTopK: 15,
  ttsGptsovitsTopP: 1,
  ttsGptsovitsTemperature: 1,
  ttsGptsovitsRepetitionPenalty: 1.35,
  ttsGptsovitsSampleSteps: 32,
  ttsCustomCloudEndpointUrl: "",
  ttsCustomCloudApiKey: "",
  ttsCustomCloudVoiceId: "",
  ttsCustomCloudFormat: "mp3",
  ttsCustomCloudTimeoutMs: 30000,
  ttsMimoKey: "",
  ttsMimoVoiceAudioPath: "",
  ttsMimoStylePrompt: "温柔、自然、略带亲近感，像在轻声陪用户聊天。",
  weatherSource: "open-meteo",
  weatherEnabled: false,
  amapKey: "",
  travelEnabled: false,
  playwrightMcpEnabled: false,
  searchEngine: "off",
  searchBochaKey: "",
  searchTavilyKey: "",
  searchMinimaxKey: "",
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
  asrLocalProfile: "paraformer-qwen17",
  asrHotwords: [],
  asrVadSilenceMs: 1000,
  asrVadThreshold: 0.01,
  asrShowTranscript: false,
  openerMode: "off",
};

export function normalizeGeneralSettings(
  input: Partial<GeneralSettings> | null | undefined,
): GeneralSettings {
  const windowVisibility = normalizeWindowVisibilitySettings(input);
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
    musicEnabled: Boolean(input?.musicEnabled),
    musicVolume: clamp(input?.musicVolume, DEFAULT_GENERAL_SETTINGS.musicVolume),
    soundEnabled: input?.soundEnabled === undefined ? DEFAULT_GENERAL_SETTINGS.soundEnabled : Boolean(input.soundEnabled),
    soundVolume: clamp(input?.soundVolume, DEFAULT_GENERAL_SETTINGS.soundVolume),
    petAlwaysOnTop: input?.petAlwaysOnTop === undefined ? DEFAULT_GENERAL_SETTINGS.petAlwaysOnTop : Boolean(input.petAlwaysOnTop),
    petVisible: input?.petVisible === undefined ? DEFAULT_GENERAL_SETTINGS.petVisible : Boolean(input.petVisible),
    petZoom: typeof input?.petZoom === "number" ? Math.max(0.5, Math.min(2, input.petZoom)) : DEFAULT_GENERAL_SETTINGS.petZoom,
    petIdleMotionsEnabled: input?.petIdleMotionsEnabled === undefined
      ? DEFAULT_GENERAL_SETTINGS.petIdleMotionsEnabled
      : Boolean(input.petIdleMotionsEnabled),
    petWindowX: typeof input?.petWindowX === "number" && Number.isFinite(input.petWindowX) ? Math.round(input.petWindowX) : undefined,
    petWindowY: typeof input?.petWindowY === "number" && Number.isFinite(input.petWindowY) ? Math.round(input.petWindowY) : undefined,
    sidebarVisible: windowVisibility.sidebarVisible,
    tasksVisible: windowVisibility.tasksVisible,
    launchAtLogin: Boolean(input?.launchAtLogin),
    language: "zh-CN",
    uiTheme: normalizeUiTheme(input?.uiTheme),
    uiFont: normalizeUiFont(input?.uiFont),
    uiIcon: normalizeUiIcon(input?.uiIcon),
    defaultChatMode: normalizeDefaultChatMode(input?.defaultChatMode),
    segmentedOutputMode: normalizeSegmentedOutputMode(input?.segmentedOutputMode),
    mobileMessageSegmentation: normalizeMobileMessageSegmentationMode(input?.mobileMessageSegmentation),
    proactiveChatMode: normalizeProactiveChatMode(input?.proactiveChatMode),
    proactiveDeliveryTarget: normalizeProactiveDeliveryTarget(input?.proactiveDeliveryTarget),
    proactiveFeedbackEnabled: input?.proactiveFeedbackEnabled === undefined ? DEFAULT_GENERAL_SETTINGS.proactiveFeedbackEnabled : Boolean(input.proactiveFeedbackEnabled),
    socialContextEnabled: input?.socialContextEnabled === undefined ? DEFAULT_GENERAL_SETTINGS.socialContextEnabled : Boolean(input.socialContextEnabled),
    screenMonitorEnabled: input?.screenMonitorEnabled === undefined ? DEFAULT_GENERAL_SETTINGS.screenMonitorEnabled : Boolean(input.screenMonitorEnabled),
    ttsEngine: (["off", "minimax", "gptsovits", "custom-cloud", "mimo"].includes(input?.ttsEngine as string) ? input?.ttsEngine : "off") as GeneralSettings["ttsEngine"],
    ttsAutoRead: input?.ttsAutoRead === undefined ? DEFAULT_GENERAL_SETTINGS.ttsAutoRead : Boolean(input.ttsAutoRead),
    ttsSpeed: typeof input?.ttsSpeed === "number" ? Math.max(0.5, Math.min(2, input.ttsSpeed)) : DEFAULT_GENERAL_SETTINGS.ttsSpeed,
    ttsVolume: typeof input?.ttsVolume === "number" ? Math.max(0, Math.min(1, input.ttsVolume)) : DEFAULT_GENERAL_SETTINGS.ttsVolume,
    ttsMinimaxKey: typeof input?.ttsMinimaxKey === "string" ? input.ttsMinimaxKey : "",
    ttsMinimaxVoiceId: typeof input?.ttsMinimaxVoiceId === "string" ? input.ttsMinimaxVoiceId : "",
    ttsMinimaxModel: input?.ttsMinimaxModel === "speech-2.8-hd" ? "speech-2.8-hd" : "speech-2.8-turbo",
    ttsStreaming: input?.ttsStreaming === undefined ? true : Boolean(input.ttsStreaming),
    weatherSource: ["open-meteo", "amap"].includes(String(input?.weatherSource)) ? input!.weatherSource as GeneralSettings["weatherSource"] : "open-meteo",
    weatherEnabled: Boolean(input?.weatherEnabled),
    amapKey: typeof input?.amapKey === "string" ? input.amapKey : "",
    travelEnabled: Boolean(input?.travelEnabled),
    playwrightMcpEnabled: Boolean(input?.playwrightMcpEnabled),
    searchEngine: ["off", "bocha", "tavily", "minimax"].includes(String(input?.searchEngine)) ? input!.searchEngine as GeneralSettings["searchEngine"] : "off",
    searchBochaKey: typeof input?.searchBochaKey === "string" ? input.searchBochaKey : "",
    searchTavilyKey: typeof input?.searchTavilyKey === "string" ? input.searchTavilyKey : "",
    searchMinimaxKey: typeof input?.searchMinimaxKey === "string" ? input.searchMinimaxKey : "",
    emailEnabled: Boolean(input?.emailEnabled),
    emailSmtpHost: typeof input?.emailSmtpHost === "string" ? input.emailSmtpHost : "",
    emailSmtpPort: clampPort(input?.emailSmtpPort, DEFAULT_GENERAL_SETTINGS.emailSmtpPort),
    emailSmtpSecure: input?.emailSmtpSecure === undefined ? clampPort(input?.emailSmtpPort, DEFAULT_GENERAL_SETTINGS.emailSmtpPort) === 465 : Boolean(input.emailSmtpSecure),
    emailSmtpUser: typeof input?.emailSmtpUser === "string" ? input.emailSmtpUser : "",
    emailSmtpPass: typeof input?.emailSmtpPass === "string" ? input.emailSmtpPass : "",
    emailFromName: typeof input?.emailFromName === "string" ? input.emailFromName : "",
    asrEngine: ["off", "aliyun", "local"].includes(String(input?.asrEngine)) ? input!.asrEngine as GeneralSettings["asrEngine"] : "off",
    asrAliyunAppKey: typeof input?.asrAliyunAppKey === "string" ? input.asrAliyunAppKey : "",
    asrAliyunAccessKeyId: typeof input?.asrAliyunAccessKeyId === "string" ? input.asrAliyunAccessKeyId : "",
    asrAliyunAccessKeySecret: typeof input?.asrAliyunAccessKeySecret === "string" ? input.asrAliyunAccessKeySecret : "",
    asrLanguage: ["zh", "en", "auto"].includes(String(input?.asrLanguage)) ? input!.asrLanguage as GeneralSettings["asrLanguage"] : "zh",
    asrLocalProfile: normalizeLocalAsrProfile(input?.asrLocalProfile),
    asrHotwords: normalizeAsrHotwords(input?.asrHotwords),
    asrVadSilenceMs: typeof input?.asrVadSilenceMs === "number" ? Math.max(300, Math.min(30000, Math.round(input.asrVadSilenceMs))) : DEFAULT_GENERAL_SETTINGS.asrVadSilenceMs,
    asrVadThreshold: typeof input?.asrVadThreshold === "number" ? Math.max(0.001, Math.min(0.5, Number(input.asrVadThreshold))) : DEFAULT_GENERAL_SETTINGS.asrVadThreshold,
    asrShowTranscript: Boolean(input?.asrShowTranscript),
    openerMode: ["off", "quiet", "normal", "lively"].includes(String(input?.openerMode)) ? input!.openerMode as GeneralSettings["openerMode"] : "off",
    ttsGptsovitsBaseUrl: typeof input?.ttsGptsovitsBaseUrl === "string" ? input.ttsGptsovitsBaseUrl : DEFAULT_GENERAL_SETTINGS.ttsGptsovitsBaseUrl,
    ttsGptsovitsRefAudioPath: typeof input?.ttsGptsovitsRefAudioPath === "string" ? input.ttsGptsovitsRefAudioPath : "",
    ttsGptsovitsPromptText: typeof input?.ttsGptsovitsPromptText === "string" ? input.ttsGptsovitsPromptText : "",
    ttsGptsovitsFormat: input?.ttsGptsovitsFormat === "mp3" ? "mp3" : "wav",
    ttsGptsovitsVersion: ["auto", "v1", "v2", "v2Pro", "v2ProPlus", "v3", "v4"].includes(String(input?.ttsGptsovitsVersion)) ? input!.ttsGptsovitsVersion as GptsovitsVersion : "auto",
    ttsGptsovitsGptWeightsPath: typeof input?.ttsGptsovitsGptWeightsPath === "string" ? input.ttsGptsovitsGptWeightsPath : "",
    ttsGptsovitsSovitsWeightsPath: typeof input?.ttsGptsovitsSovitsWeightsPath === "string" ? input.ttsGptsovitsSovitsWeightsPath : "",
    ttsGptsovitsTextSplitMethod: ["cut0", "cut1", "cut2", "cut3", "cut4", "cut5"].includes(String(input?.ttsGptsovitsTextSplitMethod)) ? input!.ttsGptsovitsTextSplitMethod as GptsovitsTextSplitMethod : "cut5",
    ttsGptsovitsTopK: typeof input?.ttsGptsovitsTopK === "number" ? Math.max(1, Math.min(1000, Math.round(input.ttsGptsovitsTopK))) : 15,
    ttsGptsovitsTopP: typeof input?.ttsGptsovitsTopP === "number" ? Math.max(0, Math.min(1, input.ttsGptsovitsTopP)) : 1,
    ttsGptsovitsTemperature: typeof input?.ttsGptsovitsTemperature === "number" ? Math.max(0.01, Math.min(2, input.ttsGptsovitsTemperature)) : 1,
    ttsGptsovitsRepetitionPenalty: typeof input?.ttsGptsovitsRepetitionPenalty === "number" ? Math.max(0.1, Math.min(10, input.ttsGptsovitsRepetitionPenalty)) : 1.35,
    ttsGptsovitsSampleSteps: typeof input?.ttsGptsovitsSampleSteps === "number" ? Math.max(1, Math.min(100, Math.round(input.ttsGptsovitsSampleSteps))) : 32,
    ttsCustomCloudEndpointUrl: typeof input?.ttsCustomCloudEndpointUrl === "string" ? input.ttsCustomCloudEndpointUrl : "",
    ttsCustomCloudApiKey: typeof input?.ttsCustomCloudApiKey === "string" ? input.ttsCustomCloudApiKey : "",
    ttsCustomCloudVoiceId: typeof input?.ttsCustomCloudVoiceId === "string" ? input.ttsCustomCloudVoiceId : "",
    ttsCustomCloudFormat: input?.ttsCustomCloudFormat === "wav" ? "wav" : "mp3",
    ttsCustomCloudTimeoutMs: clampMs(input?.ttsCustomCloudTimeoutMs, DEFAULT_GENERAL_SETTINGS.ttsCustomCloudTimeoutMs),
    ttsMimoKey: typeof input?.ttsMimoKey === "string" ? input.ttsMimoKey : "",
    ttsMimoVoiceAudioPath: typeof input?.ttsMimoVoiceAudioPath === "string" ? input.ttsMimoVoiceAudioPath : "",
    ttsMimoStylePrompt: typeof input?.ttsMimoStylePrompt === "string" ? input.ttsMimoStylePrompt : DEFAULT_GENERAL_SETTINGS.ttsMimoStylePrompt,
  };
}

export type GeneralSettingsChangedListener = (
  before: GeneralSettings,
  after: GeneralSettings,
) => void;

export class SettingsFacade {
  private readonly listeners = new Set<GeneralSettingsChangedListener>();

  constructor(private readonly getSettingsPath: () => string) {}

  load(): GeneralSettings {
    try {
      const filePath = this.getSettingsPath();
      if (!fs.existsSync(filePath)) return DEFAULT_GENERAL_SETTINGS;
      return normalizeGeneralSettings(
        JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<GeneralSettings>,
      );
    } catch (error) {
      console.error("[Cyrene] load general settings failed:", error);
      return DEFAULT_GENERAL_SETTINGS;
    }
  }

  save(settings: Partial<GeneralSettings>): GeneralSettings {
    const before = this.load();
    const normalized = normalizeGeneralSettings({ ...before, ...settings });
    const filePath = this.getSettingsPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeJsonAtomicSync(filePath, normalized);
    for (const listener of this.listeners) listener(before, normalized);
    return normalized;
  }

  onChanged(listener: GeneralSettingsChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
