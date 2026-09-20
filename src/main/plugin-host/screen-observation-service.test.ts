import { describe, expect, it, vi } from "vitest";
import { createScreenObservationService } from "./screen-observation-service";

vi.mock("electron", () => ({
  desktopCapturer: { getSources: vi.fn() },
  nativeImage: { createFromDataURL: vi.fn() },
  screen: { getPrimaryDisplay: vi.fn(() => ({ id: 1 })) },
}));

const config = { baseUrl: "https://example.invalid/v1", apiKey: "test", model: "vision-test" };

describe("插件屏幕观察服务", () => {
  it("只返回视觉摘要，通用观察 30 秒内复用且聚焦问题重新截图", async () => {
    let now = 1_000;
    const capture = vi.fn(async () => ({ base64: "image", mime: "image/jpeg" } as const));
    const analyze = vi.fn(async (_image, prompt: string) => prompt.includes("窗口标题") ? "聚焦结果" : "通用结果");
    const service = createScreenObservationService({
      capture,
      analyze,
      loadConfig: () => config,
      toComparableBitmap: () => Buffer.from([0, 0, 0, 255]),
      imagesNoChange: () => false,
      now: () => now,
    });

    expect(await service.observe()).toBe("通用结果");
    now += 20_000;
    expect(await service.observe()).toBe("通用结果");
    expect(capture).toHaveBeenCalledOnce();
    expect(await service.observe({ focus: "窗口标题是什么" })).toBe("聚焦结果");
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("缓存到期后画面未变化时跳过视觉模型并刷新摘要时间", async () => {
    let now = 1_000;
    const capture = vi.fn(async () => ({ base64: `image-${now}`, mime: "image/jpeg" } as const));
    const analyze = vi.fn(async () => "持续编辑代码");
    const service = createScreenObservationService({
      capture,
      analyze,
      loadConfig: () => config,
      toComparableBitmap: () => Buffer.from([1, 2, 3, 255]),
      imagesNoChange: () => true,
      now: () => now,
    });

    expect(await service.observe()).toBe("持续编辑代码");
    now += 31_000;
    expect(await service.observe()).toBe("持续编辑代码");
    expect(capture).toHaveBeenCalledTimes(2);
    expect(analyze).toHaveBeenCalledOnce();
    now += 20_000;
    expect(await service.observe()).toBe("持续编辑代码");
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("桌宠排除区内的动画变化不会触发重复视觉分析", async () => {
    let now = 1_000;
    let frame = 0;
    const analyze = vi.fn(async () => "用户正在阅读文档");
    const service = createScreenObservationService({
      capture: async () => ({ base64: `image-${frame}`, mime: "image/jpeg" }),
      analyze,
      loadConfig: () => config,
      toComparableBitmap: () => {
        const bitmap = Buffer.alloc(64 * 4, 0);
        bitmap.fill(frame++ === 0 ? 50 : 200, 0, 8 * 4);
        return bitmap;
      },
      getExcludedRegions: () => [{ x: 0, y: 0, width: 8 / 64, height: 1 }],
      now: () => now,
    });
    expect(await service.observe()).toBe("用户正在阅读文档");
    now += 31_000;
    expect(await service.observe()).toBe("用户正在阅读文档");
    expect(analyze).toHaveBeenCalledOnce();
  });

  it("无视觉配置时不截图；取消和超长问题均拒绝", async () => {
    const capture = vi.fn();
    const service = createScreenObservationService({ capture, loadConfig: () => null });
    expect(await service.observe()).toContain("未配置视觉模型");
    expect(capture).not.toHaveBeenCalled();
    await expect(service.observe({ focus: "x".repeat(2_001) })).rejects.toThrow("2000");
    const controller = new AbortController(); controller.abort();
    await expect(service.observe({ signal: controller.signal })).rejects.toThrow("取消");
  });
});
