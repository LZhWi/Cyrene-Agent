import { describe, expect, it, vi } from "vitest";
import { createScreenObservationService, getScreenObservationNoChangeCount } from "./screen-observation-service";

vi.mock("electron", () => ({
  desktopCapturer: { getSources: vi.fn() },
  nativeImage: { createFromDataURL: vi.fn() },
  screen: { getPrimaryDisplay: vi.fn(() => ({ id: 1 })) },
}));

const config = { baseUrl: "https://example.invalid/v1", apiKey: "test", model: "vision-test" };

describe("插件屏幕观察服务", () => {
  it("只在周期快照成功结束后通知补建，失败和手动观察均不通知", async () => {
    const onSnapshotFinished = vi.fn();
    const analyze = vi.fn(async () => "类型：工作\n与上次比较：延续\n概括：用户正在阅读文档。");
    const service = createScreenObservationService({
      capture: async () => ({ base64: "image", mime: "image/jpeg" }),
      analyze,
      loadConfig: () => config,
      toComparableBitmap: () => Buffer.from([0, 0, 0, 255]),
      imagesNoChange: () => true,
      onSnapshotFinished,
    });
    await service.observe();
    expect(onSnapshotFinished).not.toHaveBeenCalled();
    await service.observeSnapshot();
    await service.observeSnapshot();
    expect(onSnapshotFinished).toHaveBeenCalledTimes(2);
    analyze.mockResolvedValueOnce("[错误] 模型不可用");
    const failed = createScreenObservationService({
      capture: async () => ({ base64: "image", mime: "image/jpeg" }),
      analyze,
      loadConfig: () => config,
      onSnapshotFinished,
    });
    await expect(failed.observeSnapshot()).rejects.toThrow("模型不可用");
    expect(onSnapshotFinished).toHaveBeenCalledTimes(2);
    const controller = new AbortController();
    const cancelled = createScreenObservationService({
      capture: async () => ({ base64: "image", mime: "image/jpeg" }),
      analyze: async () => { controller.abort(); return "类型：工作\n与上次比较：延续\n概括：用户正在阅读文档。"; },
      loadConfig: () => config,
      onSnapshotFinished,
    });
    await expect(cancelled.observeSnapshot({ signal: controller.signal })).rejects.toThrow("已取消");
    expect(onSnapshotFinished).toHaveBeenCalledTimes(2);
  });

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
    expect(capture).toHaveBeenLastCalledWith(expect.any(AbortSignal), true);
    expect(analyze).toHaveBeenLastCalledWith(
      expect.anything(), expect.stringContaining("问题：窗口标题是什么"), config, expect.any(AbortSignal), 4096,
    );
  });

  it("手动通用观察缓存到期后始终重新调用视觉模型", async () => {
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
    const repeated = await service.observe();
    expect(repeated).toContain("持续编辑代码");
    expect(repeated).not.toContain("可能不在使用电脑或正在休息");
    expect(capture).toHaveBeenCalledTimes(2);
    expect(analyze).toHaveBeenCalledTimes(2);
    now += 20_000;
    expect(await service.observe()).toBe(repeated);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("手动观察不改写周期基线，桌宠排除区变化仍由周期比较忽略", async () => {
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
    expect((await service.observeSnapshot()).noChange).toBe(false);
    now += 31_000;
    expect(await service.observe()).toContain("用户正在阅读文档");
    expect(analyze).toHaveBeenCalledTimes(2);
    expect((await service.observeSnapshot()).noChange).toBe(true);
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it("周期观察使用本地三行提示、2048 token，并清理 thinking 包裹", async () => {
    const analyze = vi.fn(async () => (
      "<think>内部推理</think><answer>类型：工作\n与上次比较：延续\n概括：用户正在编辑代码。</answer>"
    ));
    const service = createScreenObservationService({
      capture: async () => ({ base64: "image", mime: "image/jpeg" }),
      analyze,
      loadConfig: () => config,
      toComparableBitmap: () => Buffer.from([0, 0, 0, 255]),
    });
    const result = await service.observeSnapshot({ previousSummary: "类型：工作，内容：用户正在阅读文档。" });
    expect(result).toEqual({
      text: "类型：工作\n与上次比较：延续\n概括：用户正在编辑代码。",
      noChange: false,
    });
    expect(analyze).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("上次观测时的用户状态：类型：工作，内容：用户正在阅读文档。"),
      config,
      expect.any(AbortSignal),
      2048,
    );
  });

  it("周期快照把排除区后的像素无变化显式返回给插件", async () => {
    let frame = 0;
    const analyze = vi.fn(async () => "类型：工作\n与上次比较：延续\n概括：用户正在阅读文档。");
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
    });
    expect((await service.observeSnapshot()).noChange).toBe(false);
    expect(await service.observeSnapshot()).toEqual({
      text: "类型：工作\n与上次比较：延续\n概括：用户正在阅读文档。",
      noChange: true,
    });
    expect(analyze).toHaveBeenCalledOnce();
    expect(getScreenObservationNoChangeCount()).toBe(1);
    service.markPeriodicUnavailable?.();
    expect(getScreenObservationNoChangeCount()).toBeNull();
  });

  it("无视觉配置时不截图；取消和超长问题均拒绝", async () => {
    const capture = vi.fn();
    const service = createScreenObservationService({ capture, loadConfig: () => null });
    expect(await service.observe()).toContain("未配置视觉模型");
    expect(await service.observeSnapshot()).toEqual({
      text: "[错误] 未配置视觉模型，无法分析当前屏幕。",
      noChange: false,
    });
    expect(capture).not.toHaveBeenCalled();
    await expect(service.observe({ focus: "x".repeat(2_001) })).rejects.toThrow("2000");
    const controller = new AbortController(); controller.abort();
    await expect(service.observe({ signal: controller.signal })).rejects.toThrow("取消");
  });
});
