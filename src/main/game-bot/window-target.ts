import { nativeImage } from "electron";
import { getWindows, screen as nutScreen, Region } from "@nut-tree-fork/nut-js";
import type { ImgData } from "./vlm-locator";
import { isExecutableRunning } from "./process-tools";

export interface RatioPoint {
  x: number;
  y: number;
}

export interface RatioRegion extends RatioPoint {
  width: number;
  height: number;
}

export interface WindowTarget {
  title: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface WindowCapture extends ImgData {
  width: number;
  height: number;
  screenRegion: WindowTarget;
}

export function resolveRatioPoint(target: WindowTarget, point: RatioPoint): { x: number; y: number } {
  return {
    x: target.left + Math.round(target.width * Math.max(0, Math.min(1, point.x))),
    y: target.top + Math.round(target.height * Math.max(0, Math.min(1, point.y))),
  };
}

export function resolveRatioRegion(target: WindowTarget, region?: RatioRegion): WindowTarget {
  if (!region) return target;
  const left = target.left + Math.round(target.width * Math.max(0, Math.min(1, region.x)));
  const top = target.top + Math.round(target.height * Math.max(0, Math.min(1, region.y)));
  const maxWidth = Math.max(1, target.left + target.width - left);
  const maxHeight = Math.max(1, target.top + target.height - top);
  return {
    title: target.title,
    left,
    top,
    width: Math.min(maxWidth, Math.max(1, Math.round(target.width * region.width))),
    height: Math.min(maxHeight, Math.max(1, Math.round(target.height * region.height))),
  };
}

export async function findWindowTarget(titleKeyword: string): Promise<WindowTarget | null> {
  const keyword = titleKeyword.trim().toLowerCase();
  if (!keyword) return null;
  const windows = await getWindows();
  for (const win of windows) {
    const title = await win.getTitle().catch(() => "");
    if (!title.toLowerCase().includes(keyword)) continue;
    const region = await win.getRegion();
    if (region.width <= 0 || region.height <= 0) continue;
    await win.focus().catch(() => false);
    return { title, left: region.left, top: region.top, width: region.width, height: region.height };
  }
  return null;
}

/**
 * 本地独占/无边框全屏目标：先确认 exe 进程存在，再优先聚焦覆盖主屏的窗口。
 * 某些独占全屏窗口不暴露标题，因此最后回退到 nut-js 的主显示器硬件区域。
 */
export async function findFullscreenTarget(exe: string): Promise<WindowTarget | null> {
  if (!await isExecutableRunning(exe)) return null;
  const width = await nutScreen.width();
  const height = await nutScreen.height();
  const candidates: Array<{ win: Awaited<ReturnType<typeof getWindows>>[number]; target: WindowTarget }> = [];
  for (const win of await getWindows()) {
    const region = await win.getRegion().catch(() => null);
    if (!region || region.width < width * 0.8 || region.height < height * 0.8) continue;
    const title = await win.getTitle().catch(() => "");
    candidates.push({
      win,
      target: { title: title || "本地全屏游戏", left: region.left, top: region.top, width: region.width, height: region.height },
    });
  }
  candidates.sort((a, b) => b.target.width * b.target.height - a.target.width * a.target.height);
  if (candidates[0]) {
    await candidates[0].win.focus().catch(() => false);
    return candidates[0].target;
  }
  return { title: "本地全屏游戏", left: 0, top: 0, width, height };
}

export async function captureWindowTarget(target: WindowTarget, region?: RatioRegion): Promise<WindowCapture> {
  const resolved = resolveRatioRegion(target, region);
  const image = await nutScreen.grabRegion(new Region(resolved.left, resolved.top, resolved.width, resolved.height));
  if (image.channels !== 4) throw new Error("窗口截图不是 4 通道图像");
  const bitmap = image.byteWidth === image.width * 4
    ? image.data
    : Buffer.concat(Array.from({ length: image.height }, (_, row) =>
        image.data.subarray(row * image.byteWidth, row * image.byteWidth + image.width * 4)));
  const png = nativeImage.createFromBitmap(bitmap, { width: image.width, height: image.height }).toPNG();
  if (png.length === 0) throw new Error("窗口截图编码失败");
  return {
    base64: png.toString("base64"),
    mime: "image/png",
    width: image.width,
    height: image.height,
    screenRegion: resolved,
  };
}
