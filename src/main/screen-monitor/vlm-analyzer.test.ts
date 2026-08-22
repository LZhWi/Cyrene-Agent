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

import { captureAndAnalyze, analyzeScreen, analyzeScreenFocused, captureAndAnalyzeFocused } from "./vlm-analyzer";
import { captureScreen } from "./capture";
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

  it("剥掉模型复读的「第X行：」行号前缀（4.6v 实测），下游解析不受影响", async () => {
    captionMocks.captionImage.mockResolvedValue("类型：工作\n第二行：与上次比较：切换\n第三行：概括：用户在代码编辑器中查看代码。");
    const summary = await analyzeScreen({ base64: "x", mime: "image/png", width: 1, height: 1 }, fakeConfig, "");
    expect(summary).toBe("类型：工作\n与上次比较：切换\n概括：用户在代码编辑器中查看代码。");
  });

  it("屏幕分析用 2048 token 上限（thinking 模型思考挤占预算，1024 会没正文）", async () => {
    captionMocks.captionImage.mockResolvedValue("类型：日常\n与上次比较：延续\n概括：用户在浏览网页。");
    await analyzeScreen({ base64: "x", mime: "image/png", width: 1, height: 1 }, fakeConfig, "");
    expect(captionMocks.captionImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      fakeConfig,
      2048,
      "vision-background",
    );
  });

  it("聚焦提问：prompt 带问题与诚实/隐私约束，答案不写观测缓存", async () => {
    captionMocks.captionImage.mockResolvedValue("用户在看线性代数视频，正讲到特征值一章。");
    const before = observationStore.getRecent(100).length;
    const answer = await captureAndAnalyzeFocused(fakeConfig, "用户在看什么视频？");
    expect(answer).toContain("特征值");
    // 聚焦路径显式 2048/q90（读小字），周期路径走默认 2048/q85
    expect(captureScreen).toHaveBeenLastCalledWith(2048, 90);
    const prompt = String(captionMocks.captionImage.mock.calls[0][1]);
    expect(prompt).toContain("问题：用户在看什么视频？");
    expect(prompt).toContain("从画面上看不出来"); // 诚实约束
    expect(prompt).toContain("敏感信息"); // 隐私模糊化
    expect(prompt).toContain("描述画面中该对象的具体内容"); // 名词焦点按描述处理
    expect(prompt).toContain("不要只回答"); // 禁止只确认存在
    expect(prompt).toContain("不看截图也能了解"); // 具体度标准
    expect(prompt).toContain("转写"); // 可读文字/数字转写指令
    expect(prompt).toContain("整体观感"); // 整体外观优先（四轮实测：长规则清单致机械合规）
    expect(prompt).not.toContain("回答要求："); // 瘦身后无规则清单编号
    expect(prompt).not.toContain("与上次比较"); // 聚焦路径无连续性对照
    // 自由格式答案不入缓存（防污染三行格式契约）
    expect(observationStore.getRecent(100).length).toBe(before);
  });

  it("聚焦路径用 4096 token 上限（思考挤占预算，2048 实测句中截断）", async () => {
    captionMocks.captionImage.mockResolvedValue("画面整体观感：测试答案。");
    await captureAndAnalyzeFocused(fakeConfig, "用户在看什么？");
    expect(captionMocks.captionImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      fakeConfig,
      4096,
      "vision-interactive",
    );
  });

  it("用户图片追问用「图片」名词（屏幕路径默认仍是屏幕截图）", async () => {
    captionMocks.captionImage.mockResolvedValue("图片是一幅粉色系的拼豆图纸。");
    await analyzeScreenFocused({ base64: "x", mime: "image/png", width: 1, height: 1 }, fakeConfig, "图纸内容是什么？", "图片");
    const prompt = String(captionMocks.captionImage.mock.calls[0][1]);
    expect(prompt).toContain("请仔细看这张图片");
    expect(prompt).toContain("不看图片也能了解");
    expect(prompt).not.toContain("屏幕截图");
  });

  it("聚焦提问：错误串直接抛出（工具侧兜底接管），不写缓存", async () => {
    captionMocks.captionImage.mockResolvedValue("[错误·运行时] 视觉模型未返回有效内容");
    const before = observationStore.getRecent(100).length;
    await expect(captureAndAnalyzeFocused(fakeConfig, "用户在做什么？")).rejects.toThrow("[错误");
    expect(observationStore.getRecent(100).length).toBe(before);
  });

  it("过载拒连每秒重试，10 秒内连上即用主模型答案（不碰回落）", async () => {
    vi.useFakeTimers();
    try {
      captionMocks.captionImage
        .mockResolvedValueOnce("[错误·运行时] 视觉模型请求失败：HTTP 429 too many requests")
        .mockResolvedValueOnce("[错误·运行时] 视觉模型请求失败：HTTP 429 too many requests")
        .mockResolvedValueOnce("类型：工作\n与上次比较：延续\n概括：用户在整理文件。");
      const pending = analyzeScreen(
        { base64: "x", mime: "image/png", width: 1, height: 1 },
        { ...fakeConfig, model: "glm-4.6v-flash" },
        "",
      );
      await vi.advanceTimersByTimeAsync(2_000);
      const summary = await pending;
      expect(summary).toContain("类型：工作");
      expect(captionMocks.captionImage).toHaveBeenCalledTimes(3);
      // 全程主模型，未碰回落
      for (const call of captionMocks.captionImage.mock.calls) {
        expect(call[2]).toMatchObject({ model: "glm-4.6v-flash" });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("重试 10 次仍拒连回落 4.1v（弱但现在到）", async () => {
    vi.useFakeTimers();
    try {
      captionMocks.captionImage.mockImplementation(async (_img: unknown, _prompt: unknown, cfg: { model: string }) =>
        cfg.model === "glm-4.1v-thinking-flash"
          ? "类型：日常\n与上次比较：延续\n概括：回落兜底。"
          : "[错误·运行时] 视觉模型请求失败：HTTP 429 too many requests",
      );
      const pending = analyzeScreen(
        { base64: "x", mime: "image/png", width: 1, height: 1 },
        { ...fakeConfig, model: "glm-4.6v-flash" },
        "",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      const summary = await pending;
      expect(summary).toContain("回落兜底");
      // 1 首次 + 10 重试 + 1 回落
      expect(captionMocks.captionImage).toHaveBeenCalledTimes(12);
    } finally {
      vi.useRealTimers();
    }
  });

  it("超时与内容错误不回落（延迟翻倍/换模型治不了）", async () => {
    captionMocks.captionImage.mockResolvedValue("[错误·运行时] 视觉模型请求超时");
    const summary = await analyzeScreen(
      { base64: "x", mime: "image/png", width: 1, height: 1 },
      { ...fakeConfig, model: "glm-4.6v-flash" },
      "",
    );
    expect(summary).toContain("请求超时");
    expect(captionMocks.captionImage).toHaveBeenCalledTimes(1);
  });

  it("主模型即 4.1v 时不回落（同模型无意义）", async () => {
    captionMocks.captionImage.mockResolvedValue("[错误·运行时] 视觉模型请求失败：HTTP 503");
    const summary = await analyzeScreen(
      { base64: "x", mime: "image/png", width: 1, height: 1 },
      { ...fakeConfig, model: "glm-4.1v-thinking-flash" },
      "",
    );
    expect(summary).toContain("HTTP 503");
    expect(captionMocks.captionImage).toHaveBeenCalledTimes(1);
  });
});
