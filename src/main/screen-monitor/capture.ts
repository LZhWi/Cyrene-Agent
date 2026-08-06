// 屏幕截图 — 用 Electron desktopCapturer 截屏，返回 base64。
// 不需要原生模块（mss），Electron 内置 API 够用。

import { desktopCapturer } from "electron";

const LOG_PREFIX = "[ScreenMonitor/Capture]";

const DEFAULT_MAX_WIDTH = 1024;
const DEFAULT_QUALITY = 80;

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
