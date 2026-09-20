import { describe, expect, it } from "vitest";
import { bitmapsNoChange, maskNormalizedRegions } from "./screen-observation-diff";

describe("屏幕观察像素比较", () => {
  it("接受轻微通道噪声，拒绝明显内容变化", () => {
    const base = Buffer.alloc(100 * 4, 0);
    const noise = Buffer.from(base);
    noise[0] = 20;
    expect(bitmapsNoChange(base, noise)).toBe(true);

    const changed = Buffer.from(base);
    for (let index = 0; index < 3 * 4; index += 4) changed[index] = 255;
    expect(bitmapsNoChange(base, changed)).toBe(false);
  });

  it("尺寸不一致或空位图不复用", () => {
    expect(bitmapsNoChange(Buffer.alloc(0), Buffer.alloc(0))).toBe(false);
    expect(bitmapsNoChange(Buffer.alloc(4), Buffer.alloc(8))).toBe(false);
  });

  it("比较前只清空声明的宿主动态区域", () => {
    const bitmap = Buffer.alloc(10 * 4, 255);
    const masked = maskNormalizedRegions(bitmap, 10, [{ x: 0.2, y: 0, width: 0.3, height: 1 }]);
    expect([...masked.subarray(0, 2 * 4)]).toEqual([...bitmap.subarray(0, 2 * 4)]);
    expect([...masked.subarray(2 * 4, 5 * 4)]).toEqual([...Buffer.alloc(3 * 4)]);
    expect([...masked.subarray(5 * 4)]).toEqual([...bitmap.subarray(5 * 4)]);
  });
});
