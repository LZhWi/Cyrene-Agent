// 截图像素级对比 — 判断相邻两次截图"完全不变或几乎完全不变"。
//
// 用途：屏幕监控的"无变化"三级判定（在类目/连续性两级低变化判定之前）——
// 像素级无变化直接跳过 VLM 调用复用上次摘要（省 token），并在给 LLM 的内容里
// 标注无变化时长，辅助推断用户可能不在电脑前。
//
// 实现：nativeImage 缩到 64 宽再逐像素比（2304 像素，开销可忽略）。
// 任务栏时钟、光标闪烁等微小局部变化由阈值吸收，不会打断"无变化"判定；
// 真正的内容变化（滚动、切页、换窗口）远超阈值。

import { nativeImage } from "electron";

const LOG_PREFIX = "[ScreenMonitor/Diff]";

/** 缩采样宽度：够捕捉内容级变化，又让逐像素比较开销可忽略（64×36=2304 像素）。 */
const COMPARE_WIDTH = 64;

/** 单通道容差：低于此差值不算像素变化（吸收 JPEG 压缩噪声与时钟/光标的微小闪动）。 */
const CHANNEL_DIFF_THRESHOLD = 24;

/** 变化像素占比阈值：≤2% 判无变化。时钟区约占 0.2%，真正的内容变化通常 >10%。 */
const NO_CHANGE_PIXEL_RATIO = 0.02;

/**
 * 对比两块同尺寸 RGBA 位图（nativeImage.toBitmap() 输出），判是否"几乎完全不变"。
 * 纯函数，便于测试。长度不一致（分辨率变化）返回 false，交回 VLM 判定。
 */
export function bitmapsNoChange(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length || a.length === 0 || a.length % 4 !== 0) return false;
  const pixels = a.length / 4;
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    // 任一 RGB 通道超容差即算该像素变化（忽略 alpha 通道）
    if (
      Math.abs(a[i] - b[i]) > CHANNEL_DIFF_THRESHOLD ||
      Math.abs(a[i + 1] - b[i + 1]) > CHANNEL_DIFF_THRESHOLD ||
      Math.abs(a[i + 2] - b[i + 2]) > CHANNEL_DIFF_THRESHOLD
    ) {
      changed++;
    }
  }
  return changed / pixels <= NO_CHANGE_PIXEL_RATIO;
}

/**
 * JPEG base64 截图 → 缩采样 RGBA 位图（对比专用，不发往 VLM）。
 * 解码/缩放失败返回 null：调用方按"无法对比"处理，走 VLM 路径（不阻塞观测）。
 */
export function smallBitmapFromBase64(base64: string): Buffer | null {
  try {
    const img = nativeImage.createFromDataURL("data:image/jpeg;base64," + base64);
    if (img.isEmpty()) return null;
    return img.resize({ width: COMPARE_WIDTH }).toBitmap();
  } catch (err) {
    console.warn(LOG_PREFIX, "缩采样失败:", err instanceof Error ? err.message : String(err));
    return null;
  }
}
