// vision-captioner —— 唯一接触多模态协议的地方。
// 通用视觉服务：给图片+用户问题→调视觉模型→返回文本。
// 不关心图片来源（read_image 只是调用者之一），不碰文件系统。
// 永远走 OpenAI 兼容 image_url 格式，不分 transport。
//
// 判断全交给视觉模型：不本地判断"具体vs泛泛"，把用户原话+图片一起发，
// 用框架指令让视觉模型自己理解任务。

import { resolveTimeoutPolicy } from "../runtime-policy";

/** 视觉模型配置（OpenAI 兼容）。 */
export interface VisionConfig {
  baseUrl: string;  // 如 https://api.openai.com/v1
  apiKey: string;
  model: string;    // 如 gpt-4o / glm-5v-turbo / qwen-vl-max
}

/** 图片来源二选一：本地数据（纯 base64）或公网 URL（厂商服务器自行拉取）。 */
export type VisionImage =
  | { base64: string; mime: string }  // 本地文件读出的数据，mime 如 "image/png"
  | { url: string };                  // 公网图片地址，http(s) 开头

const VISION_TIMEOUT_MS = resolveTimeoutPolicy({ stage: "vision-caption" }).totalMs;
const VISION_FALLBACK_MODEL = "glm-4.1v-thinking-flash";
const OVERLOAD_RETRY_INTERVAL_MS = 1_000;
const OVERLOAD_RETRY_MAX = 10;

export const VISION_RETRY_POLICY = {
  fallbackModel: VISION_FALLBACK_MODEL,
  retryIntervalMs: OVERLOAD_RETRY_INTERVAL_MS,
  retryMax: OVERLOAD_RETRY_MAX,
} as const;

export type VisionAnalyze = (
  image: VisionImage,
  userQuery: string,
  config: VisionConfig,
  externalSignal: AbortSignal | undefined,
  maxTokens: number,
) => Promise<string>;

/**
 * 构造框架指令。判断全交给视觉模型——它本身是语言模型，
 * 理解"几只猫"是要数数、"有没有错别字"是 OCR，比本地正则/分类都准。
 * 指令含简洁约束，防止长文本回灌撑爆主模型上下文（连续看多图时尤其关键）。
 */
function buildInstruction(userQuery: string): string {
  if (userQuery && userQuery.trim()) {
    return (
      "你是图片分析助手。用户给你一张图，用户的问题如下：\n" +
      '"' + userQuery + '"\n' +
      "请基于图片直接回答用户的问题。回答务必简洁，直接针对问题给出结论，不要过度展开无关细节。"
    );
  }
  return (
    "你是图片分析助手。用户给你一张图，但没有提出具体问题。\n" +
    "请客观描述这张图片：主要物体、场景、可见文字和重要细节，不要无依据猜测。描述控制在 200 字以内。"
  );
}

/**
 * 调视觉模型分析图片。
 * @param image 图片数据
 * @param userQuery 用户当前问题；空串表示无明确问题（走通用描述）
 * @param config 视觉模型配置
 * @returns 视觉模型的文本回答；失败返回 [错误·...] 字符串
 */
export async function captionImage(
  image: VisionImage,
  userQuery: string,
  config: VisionConfig,
  externalSignal?: AbortSignal,
  maxTokens = 512,
): Promise<string> {
  const instruction = buildInstruction(userQuery);
  // base64 本地数据拼 data URL；公网 URL 原样直传，厂商服务器自行拉图
  const imageUrl = "url" in image ? image.url : "data:" + image.mime + ";base64," + image.base64;

  // 永远 OpenAI 兼容格式：image_url content block
  const body = {
    model: config.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: instruction },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
    // 不传 temperature：不同模型约束不同（如 Kimi k2.6 只允许 1），
    // 传固定值会在某些模型上报错。让各家用自己的默认值，可用性优先于确定性。
    // 确定性由 buildInstruction 里的"简洁/直接"指令约束保证。
    // 视觉描述用不到 4096 默认值，512 够用且防回灌撑爆主模型上下文。
    // 只传 max_tokens（最通用）。不传 max_completion_tokens——火山不允许两者同时设，
    // MiniMax 虽标 max_tokens 弃用但仍兼容（弃用≠删除）。
    max_tokens: maxTokens,
    stream: false,
  };

  const url = buildChatCompletionsUrl(config.baseUrl);

  // 进度信号（实现要求，非可选）：调用期间界面可能"卡住"30s，必须留日志
  console.log("[Vision] 调用视觉模型:", config.model, "url=" + url, "query.len=" + userQuery.length);
  const startMs = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "POST",
      signal: externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + config.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error("[Vision] 请求失败 HTTP " + resp.status, errText.slice(0, 200));
      return "[错误·运行时] 视觉模型请求失败：HTTP " + resp.status + " " + errText.slice(0, 200);
    }

    const data = await resp.json() as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text) {
      console.error("[Vision] 视觉模型未返回有效内容");
      return "[错误·运行时] 视觉模型未返回有效内容";
    }

    console.log("[Vision] 完成，耗时=" + (Date.now() - startMs) + "ms，返回长度=" + text.length);
    return text;
  } catch (err) {
    if (externalSignal?.aborted) {
      console.error("[Vision] 请求已取消");
      return "[错误·运行时] 视觉模型请求已取消";
    }
    if (err instanceof Error && err.name === "AbortError") {
      console.error("[Vision] 请求超时");
      return "[错误·运行时] 视觉模型请求超时";
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Vision] 请求异常:", msg);
    return "[错误·运行时] 视觉模型请求异常：" + msg;
  } finally {
    clearTimeout(timer);
  }
}

function isRetryableConnectionError(errorText: string): boolean {
  if (errorText.includes("请求超时") || errorText.includes("未返回有效内容")) return false;
  return /HTTP (429|5\d\d)/.test(errorText) || errorText.includes("请求异常");
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("视觉模型请求已取消"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("视觉模型请求已取消"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 统一视觉韧性策略：429/5xx/网络异常每秒重试，最多 10 次；仍失败时在
 * 同一端点和凭据下将模型名替换为 glm-4.1v-thinking-flash 再调用一次。
 * 超时、空内容、主动取消不重试；当前已经是兜底模型时也不重复降级。
 */
export async function captionImageWithRetryAndFallback(
  image: VisionImage,
  userQuery: string,
  config: VisionConfig,
  externalSignal?: AbortSignal,
  maxTokens = 512,
  analyze: VisionAnalyze = captionImage,
): Promise<string> {
  const canFallback = config.model !== VISION_FALLBACK_MODEL;
  let result = await analyze(image, userQuery, config, externalSignal, maxTokens);
  for (
    let attempt = 0;
    canFallback && attempt < OVERLOAD_RETRY_MAX && result.startsWith("[错误") && isRetryableConnectionError(result);
    attempt += 1
  ) {
    await waitForRetry(OVERLOAD_RETRY_INTERVAL_MS, externalSignal);
    result = await analyze(image, userQuery, config, externalSignal, maxTokens);
  }
  if (canFallback && result.startsWith("[错误") && isRetryableConnectionError(result)) {
    return analyze(image, userQuery, { ...config, model: VISION_FALLBACK_MODEL }, externalSignal, maxTokens);
  }
  return result;
}

/** 拼接 baseUrl + /chat/completions，兼容用户填的带或不带尾斜杠。 */
function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return trimmed + "/chat/completions";
}
