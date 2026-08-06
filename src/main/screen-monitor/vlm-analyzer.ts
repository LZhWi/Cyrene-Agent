// 屏幕分析 — 调视觉模型理解截图，返回"用户在做什么"的摘要。
// 复用 vision-captioner 的 captionImage，用屏幕专用 prompt。

import { captionImage, type VisionConfig, type VisionImage } from "../orchestrator/vision-captioner";
import { captureScreen, type ScreenCapture } from "./capture";
import { observationStore, type ScreenObservation } from "./observation-store";

const LOG_PREFIX = "[ScreenMonitor/VLM]";

/** 屏幕分析的 VLM 输出 token 上限（见 analyzeScreen 注释）。 */
const SCREEN_ANALYSIS_MAX_TOKENS = 2048;

// 结构化输出三行：类型类目（主判定）+ 与上次比较的连续性自判（次判定）+ 一句完整概括。
// 类型类目描述"为什么在用电脑"（工作/学习/日常/娱乐），比"用什么软件"更贴近
// 主动消息关心的变化；连续性自判由 VLM 对照上次摘要完成——实测字符/语义
// 相似度对 60 字摘要都不可分（切换组与连续组重叠），故不用本地相似度做次判定。
const SCREEN_ANALYSIS_PROMPT_PREFIX = `请理解这张屏幕截图，判断用户当前的活动场景。
严格按以下三行格式输出，不要输出其他内容：
第一行：类型：<从"工作、学习、日常、娱乐"中选一个>
第二行：与上次比较：<从"延续、切换"中选一个>
第三行：概括：<用一句完整的中文概括用户正在做什么、关注什么（不超过60字，必须写完整句子）>
第二行判定依据：对照下方"上次观测时的用户状态"，若仍在进行同一件事则输出"延续"，若已转去做不同的事则输出"切换"；若无上次记录则输出"延续"。
如果画面中可能含有账号、密码、验证码、身份证号、手机号、家庭住址、付款码等敏感信息，不要转写具体内容，只需模糊化描述。`;

/** 组装带上次观测对照的完整 prompt。prevSummary 为空表示首次观测。 */
function buildAnalysisPrompt(prevSummary: string): string {
  const prevFlat = prevSummary.replace(/\s*\n\s*/g, " ").trim();
  const prevLine = prevFlat ? prevFlat : "（无记录，首次观测）";
  return SCREEN_ANALYSIS_PROMPT_PREFIX + "\n上次观测时的用户状态：" + prevLine;
}

/**
 * 调 VLM 分析截图，返回文本摘要。
 * captionImage 内部已处理超时（VISION_TIMEOUT_MS=30s）和错误格式。
 * @param prevSummary 上次观测摘要，供 VLM 做连续性对照；空串表示首次观测。
 */
export async function analyzeScreen(
  capture: ScreenCapture,
  config: VisionConfig,
  prevSummary = "",
): Promise<string> {
  const image: VisionImage = {
    base64: capture.base64,
    mime: capture.mime,
  };

  // thinking 模型的思考 token 计入同一预算，默认 1024 会被长思考挤没正文
  // （glm-4.1v-thinking-flash 实测思考单独就有 700+ 字），屏幕分析单独放宽上限。
  // 上限只影响"想太久"的个例，正常调用用量不变。
  const result = await captionImage(image, buildAnalysisPrompt(prevSummary), config, SCREEN_ANALYSIS_MAX_TOKENS);
  if (result.startsWith("[错误")) {
    console.warn(LOG_PREFIX, "VLM 分析失败:", result.slice(0, 100));
  }
  return result;
}

/**
 * 截图 + VLM 分析一步完成，结果写入观测缓存。
 * source 标记本次观测的来源（periodic/tool/trigger）。
 * 分析失败（错误串）时抛异常而非写入缓存——错误串若进缓存会污染
 * proactive 注入和连续性对照；抛出后由服务侧快重试、工具侧兜底文案接管。
 * @param prevSummary 上次观测摘要；不传时取观测缓存最新一条（工具按需调用路径），
 *                    显式传空串表示无对照（服务首启路径）。
 */
export async function captureAndAnalyze(
  config: VisionConfig,
  source: ScreenObservation["source"] = "tool",
  prevSummary?: string,
): Promise<ScreenObservation> {
  const prev = prevSummary !== undefined ? prevSummary : (observationStore.getLatest()?.summary ?? "");
  const capture = await captureScreen();
  const summary = await analyzeScreen(capture, config, prev);
  if (summary.startsWith("[错误")) {
    throw new Error(summary);
  }

  const observation: ScreenObservation = {
    timestamp: Date.now(),
    summary,
    source,
  };

  observationStore.add(observation);
  console.log(LOG_PREFIX, "观测已记录（来源:" + source + "）:", summary.slice(0, 80));
  return observation;
}
