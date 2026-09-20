import { desktopCapturer, nativeImage, screen } from "electron";
import type { PluginScreenObservationService } from "../../plugins/api";
import { loadVisionConfig } from "../settings/model-settings";
import { captionImage, type VisionConfig, type VisionImage } from "../orchestrator/vision-captioner";
import {
  bitmapsNoChange,
  maskNormalizedRegions,
  type NormalizedScreenRegion,
} from "./screen-observation-diff";

const CACHE_REUSE_MS = 30_000;
const MAX_FOCUS_CHARS = 2_000;
const COMPARE_WIDTH = 64;

export interface ScreenObservationServiceDeps {
  capture?: (signal: AbortSignal) => Promise<VisionImage>;
  analyze?: (image: VisionImage, prompt: string, config: VisionConfig, signal: AbortSignal) => Promise<string>;
  loadConfig?: () => VisionConfig | null;
  toComparableBitmap?: (image: VisionImage) => Buffer | null;
  imagesNoChange?: (left: Buffer, right: Buffer) => boolean;
  getExcludedRegions?: () => NormalizedScreenRegion[];
  now?: () => number;
}

async function captureMainScreen(signal: AbortSignal): Promise<VisionImage> {
  if (signal.aborted) throw new Error("屏幕观察已取消");
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 2048, height: 2048 },
  });
  if (signal.aborted) throw new Error("屏幕观察已取消");
  const primaryDisplayId = String(screen.getPrimaryDisplay().id);
  const source = sources.find((candidate) => candidate.display_id === primaryDisplayId) ?? sources[0];
  if (!source || source.thumbnail.isEmpty()) throw new Error("没有可用的屏幕画面");
  return { base64: source.thumbnail.toJPEG(85).toString("base64"), mime: "image/jpeg" };
}

function observationPrompt(focus: string): string {
  const privacy = "不要转写密码、验证码、身份证号、手机号、住址、付款码或其他敏感凭据；只做模糊描述。看不清时必须明确说明，不得猜测。";
  if (focus) {
    return `请查看当前屏幕并用中文回答这个问题：${focus}\n先说明画面整体场景，再回答具体问题。${privacy}`;
  }
  return `请用简洁中文说明用户当前正在屏幕上做什么、关注什么，并指出可确认的主要应用或内容。${privacy}`;
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
 * 通用观察在 30 秒内复用摘要；超过缓存期会先做宿主内像素比较，画面未变化时
 * 继续复用摘要而不调用视觉模型。带 focus 的问题始终重新截图，避免答非所问。
 */
export function createScreenObservationService(deps: ScreenObservationServiceDeps = {}): PluginScreenObservationService {
  const capture = deps.capture ?? captureMainScreen;
  const analyze = deps.analyze ?? ((image, prompt, config, signal) => captionImage(image, prompt, config, signal));
  const getConfig = deps.loadConfig ?? loadVisionConfig;
  const toComparableBitmap = deps.toComparableBitmap ?? comparableBitmap;
  const imagesNoChange = deps.imagesNoChange ?? bitmapsNoChange;
  const getExcludedRegions = deps.getExcludedRegions ?? (() => []);
  const now = deps.now ?? Date.now;
  let cached: { at: number; text: string; bitmap: Buffer | null; excludedRegions: NormalizedScreenRegion[] } | undefined;

  return {
    async observe(input = {}) {
      const focus = typeof input.focus === "string" ? input.focus.trim() : "";
      if (focus.length > MAX_FOCUS_CHARS) throw new Error("屏幕观察问题不能超过 2000 个字符");
      const signal = input.signal ?? new AbortController().signal;
      if (signal.aborted) throw new Error("屏幕观察已取消");
      if (!focus && cached && now() - cached.at < CACHE_REUSE_MS) return cached.text;
      const config = getConfig();
      if (!config) return "[错误] 未配置视觉模型，无法分析当前屏幕。";
      const image = await capture(signal);
      const bitmap = !focus ? toComparableBitmap(image) : null;
      const excludedRegions = !focus ? getExcludedRegions() : [];
      if (!focus && cached?.bitmap && bitmap) {
        const regions = [...cached.excludedRegions, ...excludedRegions];
        const previous = maskNormalizedRegions(cached.bitmap, COMPARE_WIDTH, regions);
        const current = maskNormalizedRegions(bitmap, COMPARE_WIDTH, regions);
        if (imagesNoChange(previous, current)) {
          cached = { at: now(), text: cached.text, bitmap, excludedRegions };
          return cached.text;
        }
      }
      const text = await analyze(image, observationPrompt(focus), config, signal);
      if (signal.aborted) throw new Error("屏幕观察已取消");
      if (!focus && text && !text.startsWith("[错误")) cached = { at: now(), text, bitmap, excludedRegions };
      return text;
    },
  };
}
