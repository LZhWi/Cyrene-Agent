const CHANNEL_DIFF_THRESHOLD = 24;
const NO_CHANGE_PIXEL_RATIO = 0.02;

export interface NormalizedScreenRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 在比较副本中清空宿主自身的动态窗口区域，避免桌宠待机动画制造假变化。 */
export function maskNormalizedRegions(
  bitmap: Buffer,
  bitmapWidth: number,
  regions: NormalizedScreenRegion[],
): Buffer {
  if (bitmapWidth <= 0 || bitmap.length % (bitmapWidth * 4) !== 0 || regions.length === 0) return Buffer.from(bitmap);
  const output = Buffer.from(bitmap);
  const bitmapHeight = bitmap.length / (bitmapWidth * 4);
  for (const region of regions) {
    const left = Math.max(0, Math.floor(region.x * bitmapWidth));
    const top = Math.max(0, Math.floor(region.y * bitmapHeight));
    const right = Math.min(bitmapWidth, Math.ceil((region.x + region.width) * bitmapWidth));
    const bottom = Math.min(bitmapHeight, Math.ceil((region.y + region.height) * bitmapHeight));
    for (let y = top; y < bottom; y += 1) {
      output.fill(0, (y * bitmapWidth + left) * 4, (y * bitmapWidth + right) * 4);
    }
  }
  return output;
}

/** 对缩采样后的 RGBA 位图做低成本比较；任务栏时钟等小范围变化不会触发视觉模型。 */
export function bitmapsNoChange(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length || left.length === 0 || left.length % 4 !== 0) return false;
  const pixels = left.length / 4;
  let changed = 0;
  for (let index = 0; index < left.length; index += 4) {
    if (
      Math.abs(left[index] - right[index]) > CHANNEL_DIFF_THRESHOLD
      || Math.abs(left[index + 1] - right[index + 1]) > CHANNEL_DIFF_THRESHOLD
      || Math.abs(left[index + 2] - right[index + 2]) > CHANNEL_DIFF_THRESHOLD
    ) {
      changed += 1;
      if (changed / pixels > NO_CHANGE_PIXEL_RATIO) return false;
    }
  }
  return true;
}
