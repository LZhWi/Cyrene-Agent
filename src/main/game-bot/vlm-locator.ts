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
    max_tokens: 1024,
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
      const t = await resp.text().catch(() => "");
      console.error("[GameBot] VLM 请求失败 HTTP", resp.status, t.slice(0, 200));
      return "";
    }
    const data = await resp.json() as { choices?: Array<{ message?: { content?: string | null } }> };
    return data.choices?.[0]?.message?.content ?? "";
  } catch (err) {
    console.error("[GameBot] VLM 请求异常:", err instanceof Error ? err.message : err);
    return "";
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
