// 屏幕截图 — 用 Electron desktopCapturer 截屏，返回 base64。
// 不需要原生模块（mss），Electron 内置 API 够用。

import { desktopCapturer } from "electron";

const LOG_PREFIX = "[ScreenMonitor/Capture]";

// 默认 2048 宽：周期观察也要读联系人/标题级小字——实测 2560 宽屏下 QQ 标题栏
// 联系人名在 1024 宽只剩 ~7px，低于 VLM 可读下限，模型按字形轮廓编造了错名。
// 2048 是上限而非原生分辨率——避免将来接 4K 屏时截图膨胀逼近 API 载荷限制。
// 质量 85：小字比 q80 更可读，体积比聚焦路径的 q90 收敛（免费档 429 压力）。
const DEFAULT_MAX_WIDTH = 2048;
const DEFAULT_QUALITY = 85;

export interface ScreenCapture {
  base64: string;
  mime: string;
  width: number;
  height: number;
}

/**
 * 截取主屏幕，返回 JPEG base64。
 * maxWidth 控制缩放宽度（节省 token），quality 控制 JPEG 质量。
 */
export async function captureScreen(
  maxWidth: number = DEFAULT_MAX_WIDTH,
  quality: number = DEFAULT_QUALITY,
): Promise<ScreenCapture> {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: maxWidth, height: maxWidth },
  });

  if (sources.length === 0) {
    throw new Error("无可用屏幕源");
  }

  // sources[0] 是主屏幕
  const source = sources[0];
  const thumbnail = source.thumbnail;
  const size = thumbnail.getSize();

  console.log(LOG_PREFIX, "截图完成:", size.width + "x" + size.height);

  return {
    base64: thumbnail.toJPEG(quality).toString("base64"),
    mime: "image/jpeg",
    width: size.width,
    height: size.height,
  };
}
