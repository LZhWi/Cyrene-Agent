// 屏幕分析 — 调视觉模型理解截图，返回"用户在做什么"的摘要。
// 复用 vision-captioner 的 captionImage，用屏幕专用 prompt。

import { captionImage, type VisionConfig, type VisionImage } from "../orchestrator/vision-captioner";
import { captureScreen, type ScreenCapture } from "./capture";
import { observationStore, type ScreenObservation } from "./observation-store";

const LOG_PREFIX = "[ScreenMonitor/VLM]";

const SCREEN_ANALYSIS_PROMPT = `请理解这张屏幕截图，并总结用户当前正在做什么、关注什么、所处的场景状态。
重点关注：正在使用的程序或网页、可见文字主题、当前操作焦点、可能的意图或上下文。
请输出一段适合后续摘要参考的简洁中文描述，偏向"用户现在在做什么"而不是逐项念图。
不要输出过多琐碎 UI 细节，不要机械罗列控件。
如果画面中可能含有账号、密码、验证码、身份证号、手机号、家庭住址、付款码等敏感信息，不要转写具体内容，只需模糊化描述。`;

/**
 * 调 VLM 分析截图，返回文本摘要。
 * captionImage 内部已处理超时（VISION_TIMEOUT_MS=30s）和错误格式。
 */
export async function analyzeScreen(
  capture: ScreenCapture,
  config: VisionConfig,
): Promise<string> {
  const image: VisionImage = {
    base64: capture.base64,
    mime: capture.mime,
  };

  const result = await captionImage(image, SCREEN_ANALYSIS_PROMPT, config);
  if (result.startsWith("[错误")) {
    console.warn(LOG_PREFIX, "VLM 分析失败:", result.slice(0, 100));
  }
  return result;
}

/**
 * 截图 + VLM 分析一步完成，结果写入观测缓存。
 * source 标记本次观测的来源（periodic/tool/trigger）。
 */
export async function captureAndAnalyze(
  config: VisionConfig,
  source: ScreenObservation["source"] = "tool",
): Promise<ScreenObservation> {
  const capture = await captureScreen();
  const summary = await analyzeScreen(capture, config);

  const observation: ScreenObservation = {
    timestamp: Date.now(),
    summary,
    source,
  };

  observationStore.add(observation);
  console.log(LOG_PREFIX, "观测已记录（来源:" + source + "）:", summary.slice(0, 80));
  return observation;
}
