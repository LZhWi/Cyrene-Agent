// screen-diff 测试 — 像素级无变化判定（纯函数阈值行为 + nativeImage 解码容错）。

import { describe, it, expect, vi } from "vitest";

// mock electron 的 nativeImage：smallBitmapFromBase64 走解码+缩放链路
const electronMocks = vi.hoisted(() => ({
  createFromDataURL: vi.fn(),
}));
vi.mock("electron", () => ({
  nativeImage: { createFromDataURL: electronMocks.createFromDataURL },
}));

import { bitmapsNoChange, smallBitmapFromBase64 } from "./screen-diff";

/** 生成 pixels 个 RGBA 像素、每通道均为 value 的位图。 */
const buf = (value: number, pixels = 100): Buffer => Buffer.alloc(pixels * 4, value);

describe("bitmapsNoChange（像素级无变化判定）", () => {
  it("完全相同判无变化", () => {
    expect(bitmapsNoChange(buf(100), buf(100))).toBe(true);
  });

  it("微小局部变化（≤2% 像素）判无变化——吸收时钟/光标的闪动", () => {
    const b = buf(100);
    b[0] = 255; // 1/100 = 1% 像素突变
    expect(bitmapsNoChange(buf(100), b)).toBe(true);
  });

  it("大面积变化判有变化——滚动/切页/换窗口不被吞掉", () => {
    const b = buf(100);
    for (let i = 0; i < 20; i++) b[i * 4] = 255; // 20/100 = 20% 像素突变
    expect(bitmapsNoChange(buf(100), b)).toBe(false);
  });

  it("通道容差内（≤24）的均匀漂移判无变化——吸收 JPEG 压缩噪声", () => {
    expect(bitmapsNoChange(buf(100), buf(120))).toBe(true);
  });

  it("超出通道容差（>24）的均匀漂移判有变化", () => {
    expect(bitmapsNoChange(buf(100), buf(130))).toBe(false);
  });

  it("任一 RGB 通道变化都算像素变化", () => {
    const a = Buffer.alloc(8); // 2 像素
    const b = Buffer.alloc(8);
    a[5] = 0; b[5] = 200; // 第 2 像素的 G 通道
    expect(bitmapsNoChange(a, b)).toBe(false); // 1/2 = 50% > 2%
  });

  it("长度不一致（分辨率变化）与空位图返回 false，交回 VLM 判定", () => {
    expect(bitmapsNoChange(buf(100, 50), buf(100, 60))).toBe(false);
    expect(bitmapsNoChange(Buffer.alloc(0), Buffer.alloc(0))).toBe(false);
  });
});

describe("smallBitmapFromBase64（解码容错）", () => {
  it("正常解码返回缩采样位图", () => {
    const bitmap = Buffer.from([1, 2, 3, 4]);
    electronMocks.createFromDataURL.mockReturnValueOnce({
      isEmpty: () => false,
      resize: () => ({ toBitmap: () => bitmap }),
    });
    expect(smallBitmapFromBase64("Zm9v")).toBe(bitmap);
    expect(electronMocks.createFromDataURL).toHaveBeenCalledWith("data:image/jpeg;base64,Zm9v");
  });

  it("空图解码返回 null（调用方按无法对比处理）", () => {
    electronMocks.createFromDataURL.mockReturnValueOnce({ isEmpty: () => true });
    expect(smallBitmapFromBase64("Zm9v")).toBeNull();
  });

  it("解码抛异常返回 null，不阻塞观测链路", () => {
    electronMocks.createFromDataURL.mockImplementationOnce(() => {
      throw new Error("解码失败");
    });
    expect(smallBitmapFromBase64("Zm9v")).toBeNull();
  });
});
