// vlm-analyzer 测试 — 错误串不入观测缓存（防污染注入与连续性对照）、
// 屏幕分析单独放宽 maxTokens（thinking 模型思考挤占预算）。

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({
  desktopCapturer: { getSources: vi.fn(async () => []) },
}));

// mock 截图：避免测试依赖真实 desktopCapturer
vi.mock("./capture", () => ({
  captureScreen: vi.fn(async () => ({ base64: "aGVsbG8=", mime: "image/jpeg", width: 800, height: 600 })),
}));

// mock 视觉调用：控制返回内容验证入库/抛错行为
const captionMocks = vi.hoisted(() => ({
  captionImage: vi.fn(),
}));
vi.mock("../orchestrator/vision-captioner", () => captionMocks);

import { captureAndAnalyze, analyzeScreen } from "./vlm-analyzer";
import { observationStore } from "./observation-store";

const fakeConfig = { baseUrl: "https://example.com/v1", apiKey: "k", model: "test-vlm" };

describe("vlm-analyzer", () => {
  beforeEach(() => {
    captionMocks.captionImage.mockReset();
  });

  it("错误串不写入观测缓存，直接抛出（服务侧快重试/工具侧兜底接管）", async () => {
    captionMocks.captionImage.mockResolvedValue("[错误·运行时] 视觉模型未返回有效内容");
    const before = observationStore.getRecent(100).length;
    await expect(captureAndAnalyze(fakeConfig, "periodic", "")).rejects.toThrow("[错误");
    expect(observationStore.getRecent(100).length).toBe(before);
  });

  it("有效摘要正常写入观测缓存", async () => {
    captionMocks.captionImage.mockResolvedValue("类型：工作\n与上次比较：延续\n概括：用户在查看项目文档。");
    const obs = await captureAndAnalyze(fakeConfig, "periodic", "");
    expect(obs.summary).toContain("类型：工作");
    expect(observationStore.getLatest()?.summary).toBe(obs.summary);
  });

  it("屏幕分析用 2048 token 上限（thinking 模型思考挤占预算，1024 会没正文）", async () => {
    captionMocks.captionImage.mockResolvedValue("类型：日常\n与上次比较：延续\n概括：用户在浏览网页。");
    await analyzeScreen({ base64: "x", mime: "image/png", width: 1, height: 1 }, fakeConfig, "");
    expect(captionMocks.captionImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      fakeConfig,
      2048,
    );
  });
});
