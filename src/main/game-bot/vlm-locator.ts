// vlm-locator —— 视觉定位调用（OpenAI 兼容多图协议）。
// 复用 vision-captioner 的协议形态，但 prompt 改为要求返回坐标/判断 JSON，且支持多图。
// 不复用 vision-captioner 模块本身（它写死单图+通用描述），本模块是 game-bot 定位专用。

import { parseClickCoord, parseBoolAnswer, parseMatchIndex } from "./coords";

export interface VlmConfig {
  baseUrl: string;  // 如 https://api.siliconflow.cn/v1
  apiKey: string;
  model: string;    // 如 Qwen/Qwen3-VL-8B-Instruct
}

/** 图片数据（不含 data: 前缀的纯 base64 + mime）。 */
export interface ImgData {
  base64: string;
  mime: string;
}

export interface OcrTextItem {
  text: string;
  confidence: number;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface OcrResult {
  rawText: string;
  items: OcrTextItem[];
}

const VLM_TIMEOUT_MS = 30_000;

/** 拼接 baseUrl + /chat/completions，兼容带或不带尾斜杠。 */
function chatUrl(baseUrl: string): string {
  const t = baseUrl.trim().replace(/\/+$/, "");
  if (t.endsWith("/chat/completions")) return t;
  return t + "/chat/completions";
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** 发一次多图 chat 请求，返回助手文本。失败返回空串。 */
async function chat(config: VlmConfig, instruction: string, images: ImgData[]): Promise<string> {
  const content: ContentBlock[] = [{ type: "text", text: instruction }];
  for (const img of images) {
    content.push({ type: "image_url", image_url: { url: "data:" + img.mime + ";base64," + img.base64 } });
  }
  const body = {
    model: config.model,
    messages: [{ role: "user", content }],
    // 1024 而非 512：thinking 模型思考 token 计入同一预算，
    // 太小会把 JSON 正文挤掉导致坐标/判断解析失败。
    max_tokens: 4096,
    stream: false,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VLM_TIMEOUT_MS);
  try {
    const resp = await fetch(chatUrl(config.baseUrl), {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.apiKey },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const detail = (await resp.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
      throw new Error(`VLM 请求失败（HTTP ${resp.status}）${detail ? "：" + detail : ""}`);
    }
    const data = await resp.json() as {
      choices?: Array<{
        finish_reason?: string | null;
        message?: { content?: string | Array<{ type?: string; text?: string }> | null; reasoning_content?: string | null };
      }>;
    };
    const choice = data.choices?.[0];
    const rawContent = choice?.message?.content;
    const content = typeof rawContent === "string"
      ? rawContent
      : Array.isArray(rawContent)
        ? rawContent.map((part) => typeof part?.text === "string" ? part.text : "").join("")
        : "";
    if (content.trim()) return content;
    if (choice?.finish_reason === "length") {
      throw new Error("VLM 输出达到 token 上限，尚未生成最终 JSON；请重试或改用非 Thinking 视觉模型");
    }
    const reasoningLength = choice?.message?.reasoning_content?.length ?? 0;
    throw new Error(reasoningLength > 0
      ? `VLM 只返回了思考过程（${reasoningLength} 字符），没有最终 JSON`
      : "VLM 响应中没有可用文本");
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (error.name === "AbortError") throw new Error(`VLM 请求超时（${VLM_TIMEOUT_MS / 1000} 秒）`);
    console.error("[GameBot] VLM 请求异常:", error.message);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 定位点击：参考小图（目标元素）+ 当前截图 → 返回目标在当前截图的屏幕坐标。
 * images 顺序：先参考图后当前截图。screenW/H 用于归一化转像素。
 * 未找到或失败返回 null。
 */
export async function locate(
  config: VlmConfig,
  screenImg: ImgData,
  refImgs: ImgData[],
  targetDesc: string,
  screenW: number,
  screenH: number,
): Promise<{ x: number; y: number } | null> {
  const instruction =
    "以下是参考图（要找的目标元素）和当前游戏屏幕截图。" +
    (targetDesc ? "目标描述：" + targetDesc + "。" : "") +
    "请在当前截图中找到与参考图相同或相似的目标元素，返回其中心位置。" +
    "坐标系为 0-1000 归一化（左上 0,0，右下 1000,1000）。" +
    "只返回 JSON：{\"x\":<0-1000>,\"y\":<0-1000>}，不要任何其他文字。";
  // 顺序：参考图在前，当前截图最后
  const text = await chat(config, instruction, [...refImgs, screenImg]);
  if (!text) return null;
  return parseClickCoord(text, screenW, screenH);
}

/** 状态判断：当前截图（可选参考图）+ 问题 → 布尔。无法判断返回 null。 */
export async function check(
  config: VlmConfig,
  screenImg: ImgData,
  ask: string,
  refImg?: ImgData,
): Promise<boolean | null> {
  const instruction =
    ask + "\n只返回 JSON：{\"answer\":true} 或 {\"answer\":false}，不要任何其他文字。";
  const imgs = refImg ? [refImg, screenImg] : [screenImg];
  const text = await chat(config, instruction, imgs);
  if (!text) return null;
  return parseBoolAnswer(text);
}

/** 多图比对：当前截图 + 多张参考图 → 匹配的参考图序号（0-based）。无法判断返回 null。 */
export async function compare(
  config: VlmConfig,
  screenImg: ImgData,
  refImgs: ImgData[],
  ask: string,
): Promise<number | null> {
  const instruction =
    ask + "\n参考图按顺序编号 0,1,2...。请找出与当前截图匹配的参考图序号。" +
    "只返回 JSON：{\"match\":<序号>}，不要任何其他文字。";
  const text = await chat(config, instruction, [...refImgs, screenImg]);
  if (!text) return null;
  return parseMatchIndex(text, refImgs.length);
}

/**
 * 用当前 VLM 提取文字及文字框。框坐标统一为 0-1000 窗口归一化坐标，
 * 供本地 OCR sidecar 未配置时的兼容路径使用。
 */
export function parseRecognizedText(text: string): OcrResult | null {
  const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/```/gi, "").trim();
  const itemsKey = cleaned.indexOf('"items"');
  const topLevelArray = itemsKey < 0 && cleaned.indexOf("[") >= 0;
  const start = itemsKey >= 0
    ? cleaned.lastIndexOf("{", itemsKey)
    : topLevelArray ? cleaned.indexOf("[") : cleaned.indexOf("{");
  const end = topLevelArray ? cleaned.lastIndexOf("]") : cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { items?: unknown } | unknown[];
    const rawItems = Array.isArray(parsed) ? parsed : parsed.items;
    if (!Array.isArray(rawItems)) return null;
    const items: OcrTextItem[] = [];
    for (const raw of rawItems) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const value = typeof item.text === "string" ? item.text.trim() : "";
      const x = Number(item.x);
      const y = Number(item.y);
      const width = Number(item.width);
      const height = Number(item.height);
      if (!value || ![x, y, width, height].every(Number.isFinite)) continue;
      const normalizedX = Math.max(0, Math.min(1000, x));
      const normalizedY = Math.max(0, Math.min(1000, y));
      items.push({
        text: value,
        confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0)),
        bounds: {
          x: normalizedX,
          y: normalizedY,
          width: Math.max(0, Math.min(1000 - normalizedX, width)),
          height: Math.max(0, Math.min(1000 - normalizedY, height)),
        },
      });
    }
    return { rawText: items.map((item) => item.text).join("\n"), items };
  } catch {
    return null;
  }
}

export async function recognizeText(config: VlmConfig, image: ImgData): Promise<OcrResult | null> {
  const instruction =
    "识别这张游戏窗口截图中的所有可见中文和数字，并给出每段文字的边界框。" +
    "坐标为 0-1000 归一化坐标。只返回 JSON：" +
    '{"items":[{"text":"文字","confidence":0.95,"x":0,"y":0,"width":100,"height":30}]}。' +
    "不要 Markdown，不要解释。";
  const text = await chat(config, instruction, [image]);
  const parsed = parseRecognizedText(text);
  if (parsed) return parsed;
  const preview = text.replace(/\s+/g, " ").slice(0, 160);
  throw new Error(`VLM 返回内容不是有效的 OCR JSON${preview ? "：" + preview : ""}`);
}
