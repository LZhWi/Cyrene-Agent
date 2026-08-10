// 屏幕分析 — 调视觉模型理解截图，返回"用户在做什么"的摘要。
// 复用 vision-captioner 的 captionImage，用屏幕专用 prompt。

import { captionImage, type VisionConfig, type VisionImage } from "../orchestrator/vision-captioner";
import { captureScreen, type ScreenCapture } from "./capture";
import { observationStore, type ScreenObservation } from "./observation-store";

const LOG_PREFIX = "[ScreenMonitor/VLM]";

/** 屏幕分析的 VLM 输出 token 上限（见 analyzeScreen 注释）。 */
const SCREEN_ANALYSIS_MAX_TOKENS = 2048;

// 聚焦路径独立 token 上限：答案要写整体观感+具体内容（用户要求正文至少 200 字不被
// 掐断），thinking 模型的思考又计入同一预算——实测 2048 时正文 159 字处被 API
// 句中截断。4096 给「思考 + 完整正文」留足余量；周期三行路径保持 2048。
const FOCUSED_ANALYSIS_MAX_TOKENS = 4096;

// 结构化输出三行：类型类目（主判定）+ 与上次比较的连续性自判（次判定）+ 一句完整概括。
// 类型类目描述"为什么在用电脑"（工作/学习/日常/娱乐），比"用什么软件"更贴近
// 主动消息关心的变化；连续性自判由 VLM 对照上次摘要完成——实测字符/语义
// 相似度对 60 字摘要都不可分（切换组与连续组重叠），故不用本地相似度做次判定。
const SCREEN_ANALYSIS_PROMPT_PREFIX = `请理解这张屏幕截图，判断用户当前的活动场景。
严格按以下三行格式输出，每行直接以"类型：""与上次比较：""概括："标签开头，不要加行号或其他前缀，不要输出其他内容：
类型：<从"工作、学习、日常、娱乐"中选一个>
与上次比较：<从"延续、切换"中选一个>
概括：<用一句完整的中文概括用户正在做什么、关注什么（不超过60字，必须写完整句子）>
"与上次比较"判定依据：对照下方"上次观测时的用户状态"，若仍在进行同一件事则输出"延续"，若已转去做不同的事则输出"切换"；若无上次记录则输出"延续"。
如果画面中可能含有账号、密码、验证码、身份证号、手机号、家庭住址、付款码等敏感信息，不要转写具体内容，只需模糊化描述。`;

/** 组装带上次观测对照的完整 prompt。prevSummary 为空表示首次观测。 */
function buildAnalysisPrompt(prevSummary: string): string {
  const prevFlat = prevSummary.replace(/\s*\n\s*/g, " ").trim();
  const prevLine = prevFlat ? prevFlat : "（无记录，首次观测）";
  return SCREEN_ANALYSIS_PROMPT_PREFIX + "\n上次观测时的用户状态：" + prevLine;
}

// 部分模型（glm-4.6v-flash 实测）会把格式说明里的"第X行："行号原样复读到输出里：
// 连续性行因 ^与上次比较 失配判 null（同类目时漏判切换），行号还会漏进注入内容
// 并被 formatActivityLine 误选为概括行。入库前统一剥行号前缀，让下游解析/展示/
// 注入对模型复读无感（prompt 模板已不带行号，此为换模型时的保险层）。
function stripLineNoPrefixes(summary: string): string {
  return summary
    .split(/\r?\n/)
    .map((line) => line.replace(/^第[一二三]行\s*[:：]?\s*/, ""))
    .join("\n");
}

// 聚焦提问 prompt：LLM 指定关注点、VLM 照截图回答，与周期观测的三行结构化
// prompt 完全独立。聚焦答案为自由格式、不写观测缓存（见 captureAndAnalyzeFocused
// 注释），故无需"与上次比较"对照行；诚实约束（看不到就明说、不编造）是聚焦路径
// 的行为底线，隐私模糊化规则与周期版同款。
// 修订史：一版只约束直接回答+诚实，名词焦点被当确认题；二版加提问驱动转写与
// 具体度标准；三版补外观特征条。四轮实测发现规则清单越长 flash 模型越进「机械
// 合规」模式——逐条凑结构词汇（网格/色块）、不看整体，而同模型短 prompt 的周期
// 路径反而认出「动漫角色的眼睛部分」；故瘦身为自然语言、把「整体观感」置于
// 回答顺序首位。是否句诱发确认式收尾的问题改在工具描述层引导开放式提问（见
// screen-monitor-tool.ts 的 focus 描述）。
/** 组装聚焦提问 prompt。focus 已由调用方 trim 非空；imageNoun 区分屏幕观察
 * 聚焦路径（屏幕截图，默认保持用户定稿措辞）与用户发图追问 ask_attached_image
 * （图片）。focus 旁的行为底线（诚实/隐私/名词焦点）两路径共用。 */
function buildFocusedPrompt(focus: string, imageNoun = "屏幕截图"): string {
  const shortNoun = imageNoun === "屏幕截图" ? "截图" : "图片";
  return `请仔细看这张${imageNoun}，用中文回答问题。
你的回答要具体到让提问者不看${shortNoun}也能了解ta想了解的相关内容：先描述画面整体观感（画面中主体是什么、整体看上去像什么、主要色调、组成），再回答问题的具体内容，清晰可读的文字与图案照实转写；不要只回答"是/不是/能看到"。
如果"问题"是名词或话题而不是问句，按"描述画面中该对象的具体内容"处理。
如果问题所问的信息在画面中看不到或看不清，明确说"从画面上看不出来"，不要猜测或编造。
如果画面中可能含有账号、密码、验证码、身份证号、手机号、家庭住址、付款码等敏感信息，不要转写具体内容，只需模糊化描述。` + "\n问题：" + focus;
}

// 聚焦路径要读屏幕上的小字（标题、色号、数字等），1024 宽下这类细节只有
// 4px 左右、任何 VLM 都读不动，故单独提高截图分辨率与 JPEG 质量；周期观测
// 只做粗粒度归类，保持 1024/q80 控制延迟与免费档速率压力。2048 是上限而非
// 原生分辨率——避免将来接 4K 屏时截图膨胀逼近 API 载荷限制。
const FOCUSED_CAPTURE_MAX_WIDTH = 2048;
const FOCUSED_CAPTURE_QUALITY = 90;

// 主视觉模型（如 glm-4.6v-flash，细节能力更强）免费档会偶尔过载拒连（429，
// 毫秒级返回）。用户实测：失败后 10 秒内持续重试通常能连上，且接受延迟——
// 故连接层瞬败先对主模型每秒重试一次、最多 10 次；重试耗尽仍拒连再回落
// 4.1v 保「弱但现在到」。超时不重试不回落（单次已耗 30s）、内容错误不重试
// （重试用不了）、主模型即 4.1v 时不重试不回落（同模型无意义，周期路径
// 另有 2 分钟快重试兜底）。
const VISION_FALLBACK_MODEL = "glm-4.1v-thinking-flash";
const OVERLOAD_RETRY_INTERVAL_MS = 1_000;
const OVERLOAD_RETRY_MAX = 10;

/** 连接层瞬败判定：过载拒连（429/5xx）与网络异常值得重试/回落；超时/内容错误不值。 */
function isRetryableConnectionError(errorText: string): boolean {
  if (errorText.includes("请求超时") || errorText.includes("未返回有效内容")) return false;
  return /HTTP (429|5\d\d)/.test(errorText) || errorText.includes("请求异常");
}

/** captionImage + 过载重试 + 回落：连接层瞬败先每秒重试主模型（10 秒窗），耗尽换 VISION_FALLBACK_MODEL 再调一次。 */
async function captionWithRetryAndFallback(
  image: VisionImage,
  prompt: string,
  config: VisionConfig,
  maxTokens: number,
): Promise<string> {
  const canFallback = config.model !== VISION_FALLBACK_MODEL;
  let result = await captionImage(image, prompt, config, maxTokens);
  for (
    let attempt = 0;
    canFallback && attempt < OVERLOAD_RETRY_MAX &&
    result.startsWith("[错误") && isRetryableConnectionError(result);
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, OVERLOAD_RETRY_INTERVAL_MS));
    console.log(LOG_PREFIX, "过载重试 " + (attempt + 1) + "/" + OVERLOAD_RETRY_MAX + ":", config.model);
    result = await captionImage(image, prompt, config, maxTokens);
  }
  if (canFallback && result.startsWith("[错误") && isRetryableConnectionError(result)) {
    console.warn(LOG_PREFIX, "重试耗尽，回落", VISION_FALLBACK_MODEL);
    return captionImage(image, prompt, { ...config, model: VISION_FALLBACK_MODEL }, maxTokens);
  }
  return result;
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
  const result = await captionWithRetryAndFallback(image, buildAnalysisPrompt(prevSummary), config, SCREEN_ANALYSIS_MAX_TOKENS);
  if (result.startsWith("[错误")) {
    console.warn(LOG_PREFIX, "VLM 分析失败:", result.slice(0, 100));
    return result;
  }
  return stripLineNoPrefixes(result);
}

/**
 * 截图 + VLM 分析一步完成，结果写入观测缓存。
 * source 标记本次观测的来源（periodic/tool/trigger）。
 * 分析失败（错误串）时抛异常而非写入缓存——错误串若进缓存会污染
 * proactive 注入和连续性对照；抛出后由服务侧快重试、工具侧兜底文案接管。
 * @param prevSummary 上次观测摘要；不传时取观测缓存最新一条（工具按需调用路径），
 *                    显式传空串表示无对照（服务首启路径）。
 * @param preCapture 已完成的截图（服务侧像素对比路径传入，避免一次 tick 截两遍屏）；
 *                   不传时内部自行截图。
 */
export async function captureAndAnalyze(
  config: VisionConfig,
  source: ScreenObservation["source"] = "tool",
  prevSummary?: string,
  preCapture?: ScreenCapture,
): Promise<ScreenObservation> {
  const prev = prevSummary !== undefined ? prevSummary : (observationStore.getLatest()?.summary ?? "");
  const capture = preCapture ?? (await captureScreen());
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

/**
 * 聚焦分析：VLM 针对 LLM 指定的关注点照截图回答（自由短答）。
 * 不做连续性对照（提问模式不需要"与上次比较"）。
 */
export async function analyzeScreenFocused(
  capture: ScreenCapture,
  config: VisionConfig,
  focus: string,
  imageNoun = "屏幕截图",
): Promise<string> {
  const image: VisionImage = {
    base64: capture.base64,
    mime: capture.mime,
  };
  const result = await captionWithRetryAndFallback(image, buildFocusedPrompt(focus, imageNoun), config, FOCUSED_ANALYSIS_MAX_TOKENS);
  if (result.startsWith("[错误")) {
    console.warn(LOG_PREFIX, "VLM 聚焦分析失败:", result.slice(0, 100));
  }
  return result;
}

/**
 * 截图 + 聚焦分析一步完成。**不写入观测缓存**——自由格式答案不符合三行格式
 * 契约，入缓存会污染意图类目解析、低变化判定与 proactive 注入；聚焦问答是旁路，
 * 答案只返回给调用工具。失败（错误串）抛异常，与 captureAndAnalyze 一致，
 * 由工具侧 catch 返回兜底文案。
 */
export async function captureAndAnalyzeFocused(
  config: VisionConfig,
  focus: string,
): Promise<string> {
  const capture = await captureScreen(FOCUSED_CAPTURE_MAX_WIDTH, FOCUSED_CAPTURE_QUALITY);
  const answer = await analyzeScreenFocused(capture, config, focus);
  if (answer.startsWith("[错误")) {
    throw new Error(answer);
  }
  console.log(LOG_PREFIX, "聚焦观测完成（不写缓存）:", answer.slice(0, 200));
  return answer;
}
