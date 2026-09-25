import { desktopCapturer, nativeImage, screen } from "electron";
import type { PluginScreenObservationService } from "../../plugins/api";
import { loadVisionConfig } from "../settings/model-settings";
import {
  captionImage,
  captionImageWithRetryAndFallback,
  type VisionAnalyze,
  type VisionConfig,
  type VisionImage,
} from "../orchestrator/vision-captioner";
import {
  bitmapsNoChange,
  maskNormalizedRegions,
  type NormalizedScreenRegion,
} from "./screen-observation-diff";

const CACHE_REUSE_MS = 30_000;
const RECENT_COUNT = 5;
const MAX_FOCUS_CHARS = 2_000;
const MAX_PREVIOUS_SUMMARY_CHARS = 4_000;
const COMPARE_WIDTH = 64;
const SCREEN_ANALYSIS_MAX_TOKENS = 2_048;
const FOCUSED_ANALYSIS_MAX_TOKENS = 4_096;

export interface ScreenObservationServiceDeps {
  capture?: (signal: AbortSignal, focused?: boolean) => Promise<VisionImage>;
  analyze?: VisionAnalyze;
  loadConfig?: () => VisionConfig | null;
  toComparableBitmap?: (image: VisionImage) => Buffer | null;
  imagesNoChange?: (left: Buffer, right: Buffer) => boolean;
  getExcludedRegions?: () => NormalizedScreenRegion[];
  onSnapshotFinished?: () => void;
  now?: () => number;
}

let latestConsecutiveNoChangeCount: number | null = null;

/** 仅暴露周期观察的连续无变化次数；手动观察不会改写这一基线。 */
export function getScreenObservationNoChangeCount(): number | null {
  return latestConsecutiveNoChangeCount;
}

async function captureMainScreen(signal: AbortSignal, focused = false): Promise<VisionImage> {
  if (signal.aborted) throw new Error("屏幕观察已取消");
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 2048, height: 2048 },
  });
  if (signal.aborted) throw new Error("屏幕观察已取消");
  const primaryDisplayId = String(screen.getPrimaryDisplay().id);
  const source = sources.find((candidate) => candidate.display_id === primaryDisplayId) ?? sources[0];
  if (!source || source.thumbnail.isEmpty()) throw new Error("没有可用的屏幕画面");
  return { base64: source.thumbnail.toJPEG(focused ? 90 : 85).toString("base64"), mime: "image/jpeg" };
}

function observationPrompt(focus: string, previousSummary = ""): string {
  if (focus) {
    return `请仔细看这张屏幕截图，用中文回答问题。
你的回答要具体到让提问者不看截图也能了解ta想了解的相关内容：先描述画面整体观感（画面中主体是什么、整体看上去像什么、主要色调、组成），再回答问题的具体内容，清晰可读的文字与图案照实转写；不要只回答"是/不是/能看到"。
如果"问题"是名词或话题而不是问句，按"描述画面中该对象的具体内容"处理。
如果问题所问的信息在画面中看不到或看不清，明确说"从画面上看不出来"，不要猜测或编造。
如果画面中可能含有账号、密码、验证码、身份证号、手机号、家庭住址、付款码等敏感信息，不要转写具体内容，只需模糊化描述。
问题：${focus}`;
  }
  const previous = previousSummary.replace(/\s*\n\s*/g, " ").trim() || "（无记录，首次观测）";
  return `请理解这张屏幕截图，判断用户当前的活动场景。
严格按以下三行格式输出，每行直接以"类型：""与上次比较：""概括："标签开头，不要加行号或其他前缀，不要输出其他内容：
类型：<从"工作、学习、日常、娱乐"中选一个>
与上次比较：<从"延续、切换"中选一个>
概括：<用一句完整的中文概括用户正在做什么、关注什么（不超过60字，必须写完整句子）>
"与上次比较"判定依据：对照下方"上次观测时的用户状态"，若仍在进行同一件事则输出"延续"，若已转去做不同的事则输出"切换"；若无上次记录则输出"延续"。
如果画面中可能含有账号、密码、验证码、身份证号、手机号、家庭住址、付款码等敏感信息，不要转写具体内容，只需模糊化描述。
上次观测时的用户状态：${previous}`;
}

function stripLineNoPrefixes(summary: string): string {
  return summary
    .split(/\r?\n/)
    .map((line) => line.replace(/^第[一二三]行\s*[:：]?\s*/, ""))
    .join("\n");
}

function stripVisionWrappers(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .replace(/<\/?answer>/gi, "")
    .trim();
}

interface StoredObservation {
  at: number;
  text: string;
  noChange?: boolean;
  noChangeSince?: number;
}

function parseIntentCategory(summary: string): string | null {
  const firstLine = summary.split(/\r?\n/)[0]?.trim() ?? "";
  const match = firstLine.match(/^(?:类型|意图)\s*[:：]\s*(.+)$/);
  if (!match) return null;
  const raw = match[1].trim();
  if (!raw) return null;
  return raw.replace(/[（(][^（）()]*[）)]/g, "").trim() || raw;
}

function parseContinuityVerdict(summary: string): "延续" | "切换" | null {
  const secondLine = summary.split(/\r?\n/)[1]?.trim() ?? "";
  const match = secondLine.match(/^与上次比较\s*[:：]\s*(.+)$/);
  if (!match) return null;
  const raw = match[1].trim();
  if (raw === "延续" || raw === "切换") return raw;
  if (/切换/.test(raw) && /没|未|无|不/.test(raw)) return "延续";
  if (/切换/.test(raw)) return "切换";
  if (/延续|继续|仍在|还是|照旧/.test(raw)) return "延续";
  return null;
}

function formatActivityLine(summary: string): string {
  const lines = summary.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const category = parseIntentCategory(summary);
  const rawContent = lines.find((line) => (
    !/^(?:类型|意图)\s*[:：]/.test(line) && !/^与上次比较\s*[:：]/.test(line)
  ));
  const content = rawContent?.replace(/^概括\s*[:：]\s*/, "").trim();
  return category && content ? `类型：${category}，内容：${content}` : lines.join(" ");
}

function textSimilarity(left: string, right: string): number {
  const a = new Set(left), b = new Set(right);
  let intersection = 0;
  for (const character of a) if (b.has(character)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function lowChangeComparedWith(previous: string, current: string): boolean {
  const previousIntent = parseIntentCategory(previous);
  const currentIntent = parseIntentCategory(current);
  if (previousIntent && currentIntent) {
    if (previousIntent !== currentIntent) return false;
    return parseContinuityVerdict(current) !== "切换";
  }
  return textSimilarity(previous, current) > 0.45;
}

function noChangeNote(observation: StoredObservation, now: number): string {
  if (!observation.noChange || !observation.noChangeSince) return "";
  const minutes = Math.max(1, Math.round((now - observation.noChangeSince) / 60_000));
  return `（屏幕内容在 ${minutes} 分钟内没有发生变化，推测用户可能不在使用电脑或正在休息）`;
}

function comparableBitmap(image: VisionImage): Buffer | null {
  try {
    if (!("base64" in image)) return null;
    const decoded = nativeImage.createFromDataURL(`data:${image.mime};base64,${image.base64}`);
    if (decoded.isEmpty()) return null;
    return decoded.resize({ width: COMPARE_WIDTH }).toBitmap();
  } catch {
    return null;
  }
}

/**
 * 受限的屏幕观察宿主服务：只向插件返回视觉摘要，不返回截图或文件路径。
 * 手动通用观察在 30 秒内复用摘要，超过缓存期始终重新调用视觉模型；周期观察
 * 独立维护像素比较基线。带 focus 的问题始终重新截图，避免答非所问。
 */
export function createScreenObservationService(deps: ScreenObservationServiceDeps = {}): PluginScreenObservationService {
  latestConsecutiveNoChangeCount = null;
  const capture = deps.capture ?? captureMainScreen;
  const analyze = deps.analyze ?? ((image, prompt, config, signal, maxTokens) => captionImage(image, prompt, config, signal, maxTokens));
  const getConfig = deps.loadConfig ?? loadVisionConfig;
  const toComparableBitmap = deps.toComparableBitmap ?? comparableBitmap;
  const imagesNoChange = deps.imagesNoChange ?? bitmapsNoChange;
  const getExcludedRegions = deps.getExcludedRegions ?? (() => []);
  const now = deps.now ?? Date.now;
  let periodicBaseline: { text: string; bitmap: Buffer | null; excludedRegions: NormalizedScreenRegion[] } | undefined;
  const observations: StoredObservation[] = [];

  const addObservation = (observation: StoredObservation): void => {
    observations.push(observation);
    observations.sort((left, right) => left.at - right.at);
    if (observations.length > 50) observations.shift();
    const cutoff = now() - 2 * 60 * 60 * 1000;
    while (observations[0] && observations[0].at <= cutoff) observations.shift();
  };

  const formatRecent = (): string => {
    const recent = observations.slice(-RECENT_COUNT);
    if (recent.length === 0) return "";
    if (recent.length === 1) return formatActivityLine(recent[0].text) + noChangeNote(recent[0], now());
    const spanMin = Math.round((recent[recent.length - 1].at - recent[0].at) / 60_000);
    const spanText = spanMin > 0 ? `过去 ${spanMin} 分钟` : "当前";
    const lines = recent.map((observation, index) => {
      const time = new Date(observation.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
      let line = `[${time}] ${formatActivityLine(observation.text)}`;
      if (index > 0) {
        line += lowChangeComparedWith(recent[index - 1].text, observation.text)
          ? "（与上次观测一致）"
          : "（较上次观测有变化）";
      }
      if (index === recent.length - 1) line += noChangeNote(observation, now());
      return line;
    });
    return `近期屏幕活动（${spanText}）：\n${lines.join("\n")}`;
  };

  const analyzeWithRetry = async (
    image: VisionImage,
    prompt: string,
    config: VisionConfig,
    signal: AbortSignal,
    maxTokens: number,
  ): Promise<string> => stripVisionWrappers(await captionImageWithRetryAndFallback(
    image,
    prompt,
    config,
    signal,
    maxTokens,
    analyze,
  ));

  const observeSnapshot = async (input: { previousSummary?: string; signal?: AbortSignal } = {}) => {
    const previousSummary = typeof input.previousSummary === "string" ? input.previousSummary.trim() : "";
    if (previousSummary.length > MAX_PREVIOUS_SUMMARY_CHARS) throw new Error("上次屏幕摘要不能超过 4000 个字符");
    const signal = input.signal ?? new AbortController().signal;
    if (signal.aborted) throw new Error("屏幕观察已取消");
    const config = getConfig();
    if (!config) return { text: "[错误] 未配置视觉模型，无法分析当前屏幕。", noChange: false };
    const image = await capture(signal, false);
    if (signal.aborted) throw new Error("屏幕观察已取消");
    const bitmap = toComparableBitmap(image);
    const excludedRegions = getExcludedRegions();
    if (periodicBaseline?.bitmap && bitmap) {
      const regions = [...periodicBaseline.excludedRegions, ...excludedRegions];
      const previous = maskNormalizedRegions(periodicBaseline.bitmap, COMPARE_WIDTH, regions);
      const current = maskNormalizedRegions(bitmap, COMPARE_WIDTH, regions);
      if (imagesNoChange(previous, current)) {
        const at = now();
        const previousObservation = observations[observations.length - 1];
        periodicBaseline = { text: periodicBaseline.text, bitmap, excludedRegions };
        latestConsecutiveNoChangeCount = (latestConsecutiveNoChangeCount ?? 0) + 1;
        addObservation({
          at,
          text: periodicBaseline.text,
          noChange: true,
          noChangeSince: previousObservation?.noChangeSince ?? previousObservation?.at ?? at,
        });
        deps.onSnapshotFinished?.();
        return { text: periodicBaseline.text, noChange: true };
      }
    }
    const raw = await analyzeWithRetry(
      image,
      observationPrompt("", previousSummary),
      config,
      signal,
      SCREEN_ANALYSIS_MAX_TOKENS,
    );
    if (signal.aborted) throw new Error("屏幕观察已取消");
    const text = raw.startsWith("[错误") ? raw : stripLineNoPrefixes(raw);
    if (text.startsWith("[错误")) throw new Error(text);
    if (text) {
      const at = now();
      periodicBaseline = { text, bitmap, excludedRegions };
      latestConsecutiveNoChangeCount = 0;
      addObservation({ at, text });
      deps.onSnapshotFinished?.();
    }
    return { text, noChange: false };
  };

  return {
    async observe(input = {}) {
      const focus = typeof input.focus === "string" ? input.focus.trim() : "";
      if (focus.length > MAX_FOCUS_CHARS) throw new Error("屏幕观察问题不能超过 2000 个字符");
      const signal = input.signal ?? new AbortController().signal;
      if (signal.aborted) throw new Error("屏幕观察已取消");
      const latest = observations[observations.length - 1];
      if (!focus && latest && now() - latest.at < CACHE_REUSE_MS) return formatRecent() || formatActivityLine(latest.text);
      const config = getConfig();
      if (!config) return "[错误] 未配置视觉模型，无法分析当前屏幕。";
      const image = await capture(signal, Boolean(focus));
      const raw = await analyzeWithRetry(
        image,
        observationPrompt(focus, latest?.text),
        config,
        signal,
        focus ? FOCUSED_ANALYSIS_MAX_TOKENS : SCREEN_ANALYSIS_MAX_TOKENS,
      );
      if (raw.startsWith("[错误")) return `[错误] 屏幕观察失败：${raw}`;
      const text = focus ? raw : stripLineNoPrefixes(raw);
      if (signal.aborted) throw new Error("屏幕观察已取消");
      if (!focus && text) {
        const at = now();
        addObservation({ at, text });
        return formatRecent();
      }
      return text;
    },
    observeSnapshot,
    markPeriodicUnavailable() {
      latestConsecutiveNoChangeCount = null;
    },
  };
}
