// TTS 引擎共享类型（main / renderer 共用）。

export type TtsEngine = "off" | "minimax" | "gptsovits" | "custom-cloud" | "mimo";

export type GptsovitsVersion = "auto" | "v1" | "v2" | "v2Pro" | "v2ProPlus" | "v3" | "v4";
export type GptsovitsTextSplitMethod = "cut0" | "cut1" | "cut2" | "cut3" | "cut4" | "cut5";

export interface GptsovitsAdvancedOptions {
  version?: GptsovitsVersion;
  gptWeightsPath?: string;
  sovitsWeightsPath?: string;
  textSplitMethod?: GptsovitsTextSplitMethod;
  topK?: number;
  topP?: number;
  temperature?: number;
  repetitionPenalty?: number;
  sampleSteps?: number;
}

/** GPT-SoVITS 合成请求（渲染端 → 主进程 IPC payload）。 */
export interface GptsovitsSynthesizeRequest extends GptsovitsAdvancedOptions {
  baseUrl: string;             // 形如 "http://localhost:9880"，不含路径
  refAudioPath: string;        // 参考音频绝对路径
  promptText: string;          // 参考音频对应的文本
  text: string;                // 待合成文本
  speed?: number;              // 0.5~2，默认 1
  format?: "wav" | "mp3";      // 默认 wav
}

/** 自定义云端 TTS 合成请求（渲染端 → 主进程 IPC payload）。 */
export interface CustomCloudSynthesizeRequest {
  endpointUrl: string;          // 用户自建云端 TTS endpoint
  apiKey?: string;              // 可选；为空时不发送 Authorization
  voiceId?: string;             // 可选音色 ID，透传给用户云端网关
  text: string;                 // 待合成文本
  speed?: number;               // 0.5~2，默认 1
  volume?: number;              // 0~1，默认 1
  format?: "wav" | "mp3";       // 默认 mp3
  timeoutMs?: number;           // 默认 30000
}

/** 小米 MiMo TTS 合成请求（渲染端 → 主进程 IPC payload）。 */
export interface MimoSynthesizeRequest {
  apiKey: string;               // 小米 MiMo API Key，走 api-key header
  text: string;                 // 待合成文本
  voiceAudioPath?: string;      // 昔涟克隆参考音频路径，合成时转 data URL
  stylePrompt?: string;         // 可选风格提示，作为 user message
}

/** TTS 合成返回（主进程 → 渲染端 IPC 返回）。minimax 和 gptsovits 共用。 */
export interface TtsSynthesizeResult {
  base64: string;              // 音频字节 base64
  cacheKey: string;            // 缓存 key（用于回听）
  cached: boolean;             // 是否命中缓存
  format: "wav" | "mp3";       // 实际返回的音频格式
}
