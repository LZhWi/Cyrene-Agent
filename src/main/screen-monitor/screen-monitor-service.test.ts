// screen-monitor-service 测试 — 意图类目解析、两级低变化判定与像素级无变化路径（判定核心）。
// import 链会经 capture.ts 触碰 electron，先 mock 掉。

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

vi.mock("electron", () => ({
  desktopCapturer: { getSources: vi.fn(async () => []) },
}));

// mock 截图：服务现在先截图再像素对比，测试提供假截图避免触碰真实 electron
vi.mock("./capture", () => ({
  captureScreen: vi.fn(async () => ({ base64: "Zm9v", mime: "image/jpeg", width: 1024, height: 576 })),
}));

// mock 像素对比：时间线测试需要控制每次 tick 是否像素级无变化
const diffMocks = vi.hoisted(() => ({
  bitmapsNoChange: vi.fn(() => false),
  smallBitmapFromBase64: vi.fn(() => Buffer.from([1, 2, 3, 4])),
}));
vi.mock("./screen-diff", () => diffMocks);

// mock VLM 分析：时间线测试需要控制每次观测的成败与内容
const vlmMocks = vi.hoisted(() => ({
  captureAndAnalyze: vi.fn(),
}));
vi.mock("./vlm-analyzer", () => vlmMocks);

import {
  parseIntentCategory,
  parseContinuityVerdict,
  toDisplaySummary,
  formatActivityLine,
  INTENT_CATEGORIES,
  decideLowChange,
  noChangeNote,
  screenMonitorService,
} from "./screen-monitor-service";
import { observationStore, ScreenObservationStore, LOW_CHANGE_SIMILARITY_THRESHOLD } from "./observation-store";

describe("parseIntentCategory", () => {
  it("解析标准三行格式的第一行意图", () => {
    expect(parseIntentCategory("类型：工作\n与上次比较：延续\n用户正在编写项目代码。")).toBe("工作");
  });

  it("兼容半角冒号", () => {
    expect(parseIntentCategory("类型: 娱乐\n与上次比较: 切换\n用户在看视频")).toBe("娱乐");
  });

  it("类目后带补充说明时剥括号归一", () => {
    expect(parseIntentCategory("类型：工作（写代码）\n与上次比较：延续\n用户在编辑器中工作")).toBe("工作");
  });

  it("枚举外类目按原文返回（仍可做等值比较）", () => {
    expect(parseIntentCategory("类型：休息\n与上次比较：切换\n用户在闭眼养神")).toBe("休息");
  });

  it("无意图前缀（旧格式自由摘要）返回 null，走相似度兜底", () => {
    expect(parseIntentCategory("用户现在在使用代码编辑器查看文档…")).toBeNull();
  });

  it("类型行为空返回 null", () => {
    expect(parseIntentCategory("类型：\n用户在摸鱼")).toBeNull();
    expect(parseIntentCategory("类型:   \n")).toBeNull();
  });

  it("所有标准类目都能被识别", () => {
    for (const cat of INTENT_CATEGORIES) {
      expect(parseIntentCategory(`类型：${cat}\n说明`)).toBe(cat);
    }
  });

  it("否定表述不会被误归一（非工作 ≠ 工作）", () => {
    expect(parseIntentCategory("类型：非工作\n用户在休息")).toBe("非工作");
  });

  it("兼容上一版\"意图：\"前缀的缓存观测", () => {
    expect(parseIntentCategory("意图：工作\n与上次比较：延续\n用户在写代码。")).toBe("工作");
  });
});

describe("parseContinuityVerdict", () => {
  it("精确解析延续/切换", () => {
    expect(parseContinuityVerdict("类型：工作\n与上次比较：延续\n概括")).toBe("延续");
    expect(parseContinuityVerdict("类型：工作\n与上次比较：切换\n概括")).toBe("切换");
  });

  it("兼容半角冒号与轻微变体", () => {
    expect(parseContinuityVerdict("类型：工作\n与上次比较: 切换了\n概括")).toBe("切换");
    expect(parseContinuityVerdict("类型：工作\n与上次比较：仍延续\n概括")).toBe("延续");
  });

  it("否定表述不误判", () => {
    expect(parseContinuityVerdict("类型：工作\n与上次比较：没有切换，仍在延续\n概括")).toBe("延续");
  });

  it("无对照行（旧两行格式/格式异常）返回 null", () => {
    expect(parseContinuityVerdict("类型：工作\n用户在写代码。")).toBeNull();
    expect(parseContinuityVerdict("场景：编码\n用户在写代码。")).toBeNull();
  });
});

describe("toDisplaySummary", () => {
  it("去掉对照行保留意图行和概括行", () => {
    const s = "类型：工作\n与上次比较：延续\n用户在编写屏幕监控模块。";
    expect(toDisplaySummary(s)).toBe("类型：工作\n用户在编写屏幕监控模块。");
  });

  it("旧格式（无对照行）原样保留", () => {
    const s = "用户现在在使用代码编辑器查看文档…";
    expect(toDisplaySummary(s)).toBe(s);
  });
});

describe("formatActivityLine（提交给 LLM 的统一格式）", () => {
  it("三行摘要格式化为\"类型：……，内容：……\"", () => {
    const s = "类型：工作\n与上次比较：延续\n用户在调试屏幕监控模块的超时问题。";
    expect(formatActivityLine(s)).toBe("类型：工作，内容：用户在调试屏幕监控模块的超时问题。");
  });

  it("旧格式自由摘要回落压平原文", () => {
    const s = "用户现在在使用代码编辑器查看文档…";
    expect(formatActivityLine(s)).toBe(s);
  });

  it("只有类型行无概括行时回落压平", () => {
    expect(formatActivityLine("类型：工作")).toBe("类型：工作");
  });

  it("旧前缀\"意图：\"观测也能归一为新格式", () => {
    const s = "意图：学习\n与上次比较：延续\n用户在教育网站学习线性代数。";
    expect(formatActivityLine(s)).toBe("类型：学习，内容：用户在教育网站学习线性代数。");
  });

  it("新格式概括行带\"概括：\"标签时剥掉前缀", () => {
    const s = "类型：工作\n与上次比较：延续\n概括：用户正在查看项目文档并参与相关讨论。";
    expect(formatActivityLine(s)).toBe("类型：工作，内容：用户正在查看项目文档并参与相关讨论。");
  });

  it("概括标签兼容半角冒号", () => {
    const s = "类型: 日常\n与上次比较: 延续\n概括: 用户在整理桌面文件。";
    expect(formatActivityLine(s)).toBe("类型：日常，内容：用户在整理桌面文件。");
  });
});

describe("decideLowChange（模拟实际观测场景）", () => {
  it("首次观测无对比对象返回 null", () => {
    expect(decideLowChange("", null, "类型：工作\n与上次比较：延续\n用户在写代码。")).toBeNull();
  });

  it("意图不同判有变化——用户的原始诉求场景：浏览器里学习→娱乐", () => {
    const prev = "类型：学习\n与上次比较：延续\n用户在在线教育网站学习线性代数课程。";
    const next = "类型：娱乐\n与上次比较：切换\n用户在门户网站浏览娱乐新闻和视频推荐。";
    const decision = decideLowChange(prev, "学习", next);
    expect(decision?.lowChange).toBe(false);
    expect(decision?.verdict).toContain("学习 → 娱乐");
  });

  it("意图相同且 VLM 判延续 → 低变化", () => {
    const prev = "类型：工作\n与上次比较：延续\n用户在调试屏幕监控模块。";
    const next = "类型：工作\n与上次比较：延续\n用户在修复视觉模型调用的超时问题。";
    expect(decideLowChange(prev, "工作", next)?.lowChange).toBe(true);
  });

  it("意图相同但 VLM 判切换 → 有变化（同类目内容切换被次标准捕捉）", () => {
    const prev = "类型：工作\n与上次比较：延续\n用户在撰写屏幕监控的设计文档。";
    const next = "类型：工作\n与上次比较：切换\n用户在核对差旅报销的发票信息。";
    const decision = decideLowChange(prev, "工作", next);
    expect(decision?.lowChange).toBe(false);
    expect(decision?.verdict).toContain("切换");
  });

  it("意图相同但对照行缺失 → 保守判低变化", () => {
    const prev = "类型：娱乐\n与上次比较：延续\n用户在看视频。";
    const next = "类型：娱乐\n用户在看另一部视频。"; // VLM 漏输出对照行
    expect(decideLowChange(prev, "娱乐", next)?.lowChange).toBe(true);
  });

  it("旧两行格式（无意图）回落相似度：高度重复判低变化", () => {
    const prev = "用户现在在使用代码编辑器查看技术文档页面…";
    const next = "用户现在在使用代码编辑器查看技术文档页面…";
    expect(decideLowChange(prev, null, next)?.lowChange).toBe(true);
  });

  it("旧两行格式（无意图）回落相似度：内容差异大判有变化", () => {
    const prev = "用户现在在使用代码编辑器查看技术文档页面…";
    const next = "用户在视频网站观看游戏直播并与弹幕互动…";
    expect(decideLowChange(prev, null, next)?.lowChange).toBe(false);
  });

  it("阈值常量落在实测的可分区间（不同场景 0.28~0.31 < 阈值 < 同场景 0.50）", () => {
    expect(LOW_CHANGE_SIMILARITY_THRESHOLD).toBeGreaterThan(0.31);
    expect(LOW_CHANGE_SIMILARITY_THRESHOLD).toBeLessThan(0.5);
  });
});

describe("observation-store 并发乱序（模拟工具与周期观测同时到达）", () => {
  it("晚到的旧观测不会盖掉新观测", () => {
    const store = new ScreenObservationStore();
    const now = Date.now();
    // 新观测先到，旧观测（截图更慢）后到
    store.add({ timestamp: now, summary: "类型：工作\n与上次比较：延续\n新观测", source: "periodic" });
    store.add({ timestamp: now - 20_000, summary: "类型：娱乐\n与上次比较：切换\n旧观测", source: "tool" });
    expect(store.getLatest()?.summary).toContain("新观测");
    // getRecent 时序也要正确（旧在前新在后）
    const recent = store.getRecent(2);
    expect(recent[0].summary).toContain("旧观测");
    expect(recent[1].summary).toContain("新观测");
  });
});

describe("ensureRunningIfEnabled 自愈拉起（模拟配置失效→恢复全链路）", () => {
  const fakeConfig = { baseUrl: "http://test", apiKey: "k", model: "vlm" };

  afterEach(() => {
    screenMonitorService.stop();
  });

  it("配置失效停转后，配置恢复时在下次 proactive 使用点自愈拉起", () => {
    screenMonitorService.setConfigGetter(() => fakeConfig);
    screenMonitorService.start();
    expect(screenMonitorService.isRunning()).toBe(true);
    // 模拟 tick 里配置失效（用户换掉视觉模型）导致停转
    screenMonitorService.stop();
    expect(screenMonitorService.isRunning()).toBe(false);
    // 用户配回视觉模型，下次 proactive 注入时自检拉起
    screenMonitorService.ensureRunningIfEnabled(true, fakeConfig);
    expect(screenMonitorService.isRunning()).toBe(true);
  });

  it("开关关闭时不拉起", () => {
    screenMonitorService.ensureRunningIfEnabled(false, fakeConfig);
    expect(screenMonitorService.isRunning()).toBe(false);
  });

  it("视觉配置缺失时不拉起", () => {
    screenMonitorService.ensureRunningIfEnabled(true, null);
    expect(screenMonitorService.isRunning()).toBe(false);
  });

  it("已在运行时重复调用安全（不重复起 timer）", () => {
    screenMonitorService.setConfigGetter(() => fakeConfig);
    screenMonitorService.start();
    screenMonitorService.ensureRunningIfEnabled(true, fakeConfig);
    screenMonitorService.ensureRunningIfEnabled(true, fakeConfig);
    expect(screenMonitorService.isRunning()).toBe(true);
  });
});

describe("失败快重试（模拟网络抖动后的完整时间线）", () => {
  const fakeConfig = { baseUrl: "http://test", apiKey: "k", model: "vlm" };
  const obs = (summary: string) => ({ timestamp: Date.now(), summary, source: "periodic" as const });

  beforeEach(() => {
    vi.useFakeTimers();
    screenMonitorService.resetForTests();
    vlmMocks.captureAndAnalyze.mockReset();
    screenMonitorService.setConfigGetter(() => fakeConfig);
  });

  afterEach(() => {
    screenMonitorService.stop();
    vi.useRealTimers();
  });

  it("失败后 2 分钟快重试，恢复后同意图延续降为低频", async () => {
    // 第 1 次网络抖动失败；之后稳定返回同意图延续摘要
    vlmMocks.captureAndAnalyze
      .mockRejectedValueOnce(new Error("网络抖动"))
      .mockResolvedValue(obs("类型：工作\n与上次比较：延续\n用户在写代码。"));

    screenMonitorService.start();

    // t=3min：首次观测失败
    await vi.advanceTimersByTimeAsync(180_000);
    expect(vlmMocks.captureAndAnalyze).toHaveBeenCalledTimes(1);

    // 重试在失败后 2 分钟（t=5min）触发；全速 3 分钟则要到 t=6min。
    // t=4min59s：快重试点未到，仍未重试
    await vi.advanceTimersByTimeAsync(119_000);
    expect(vlmMocks.captureAndAnalyze).toHaveBeenCalledTimes(1);

    // t=5min（失败后 2 分钟）：快重试成功
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vlmMocks.captureAndAnalyze).toHaveBeenCalledTimes(2);

    // 恢复后按全速 3 分钟排程（第一次成功无对比对象，不降频）
    await vi.advanceTimersByTimeAsync(180_000);
    expect(vlmMocks.captureAndAnalyze).toHaveBeenCalledTimes(3);

    // 第三次成功与第二次同意图且延续 → 降为低频 8 分钟
    await vi.advanceTimersByTimeAsync(180_000 + 3 * 60 * 1000);
    expect(vlmMocks.captureAndAnalyze).toHaveBeenCalledTimes(3); // 未到 8 分钟不触发
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(vlmMocks.captureAndAnalyze).toHaveBeenCalledTimes(4);
  });

  it("连续失败持续快重试，不会退回长间隔", async () => {
    vlmMocks.captureAndAnalyze.mockRejectedValue(new Error("持续故障"));
    screenMonitorService.start();

    for (let i = 1; i <= 3; i++) {
      await vi.advanceTimersByTimeAsync(i === 1 ? 180_000 : 120_000);
      expect(vlmMocks.captureAndAnalyze).toHaveBeenCalledTimes(i);
    }
  });
});

describe("noChangeNote（提供给 LLM 的无变化标注）", () => {
  it("无变化观测按连续段时长标注", () => {
    const since = 1_000_000;
    const obs = { timestamp: since + 24 * 60_000, summary: "类型：工作", source: "periodic" as const, noChange: true, noChangeSince: since };
    expect(noChangeNote(obs, since + 24 * 60_000)).toBe("（屏幕内容在 24 分钟内没有发生变化，推测用户可能不在使用电脑或正在休息）");
  });

  it("时长不足一分钟至少记 1 分钟", () => {
    const since = 1_000_000;
    const obs = { timestamp: since + 10_000, summary: "类型：工作", source: "periodic" as const, noChange: true, noChangeSince: since };
    expect(noChangeNote(obs, since + 10_000)).toContain("在 1 分钟内没有发生变化");
  });

  it("普通观测返回空串", () => {
    expect(noChangeNote({ timestamp: 1, summary: "类型：工作", source: "periodic" })).toBe("");
  });

  it("无变化但缺连续段起点返回空串", () => {
    expect(noChangeNote({ timestamp: 1, summary: "类型：工作", source: "periodic", noChange: true })).toBe("");
  });
});

describe("像素级无变化（跳过 VLM 复用摘要 + 无变化段延续）", () => {
  const fakeConfig = { baseUrl: "http://test", apiKey: "k", model: "vlm" };

  beforeEach(() => {
    vi.useFakeTimers();
    screenMonitorService.resetForTests();
    vlmMocks.captureAndAnalyze.mockReset();
    // 用 mockClear 而非 mockReset：保留工厂里的默认实现（判有变化）
    diffMocks.bitmapsNoChange.mockClear();
    diffMocks.bitmapsNoChange.mockReturnValue(false);
    observationStore.clear();
    screenMonitorService.setConfigGetter(() => fakeConfig);
  });

  afterEach(() => {
    screenMonitorService.stop();
    vi.useRealTimers();
  });

  it("无变化 tick 跳过 VLM、复用摘要，段起点从最后一次有内容确认的观测起算，降频后维持 8 分钟", async () => {
    const t0 = Date.now();
    // mock 整体替换后不会自动写缓存，模拟真实 captureAndAnalyze 的写入行为
    vlmMocks.captureAndAnalyze.mockImplementation(async () => {
      const obs = { timestamp: Date.now(), summary: "类型：工作\n与上次比较：延续\n用户在写代码。", source: "periodic" as const };
      observationStore.add(obs);
      return obs;
    });

    screenMonitorService.start();

    // t=3min：首次 tick 无对比位图 → 走 VLM（建立摘要基线，写入第 1 条观测）
    await vi.advanceTimersByTimeAsync(180_000);
    expect(vlmMocks.captureAndAnalyze).toHaveBeenCalledTimes(1);

    // 此后截图像素级无变化
    diffMocks.bitmapsNoChange.mockReturnValue(true);

    // t=6min：第二次 tick 无变化 → 跳过 VLM，记录一条无变化观测
    await vi.advanceTimersByTimeAsync(180_000);
    expect(vlmMocks.captureAndAnalyze).toHaveBeenCalledTimes(1);
    const first = observationStore.getLatest();
    expect(first?.noChange).toBe(true);
    expect(first?.summary).toContain("用户在写代码");
    expect(first?.noChangeSince).toBe(t0 + 180_000); // 从首 tick 观测（最后一次内容确认）起算
    expect(observationStore.getRecent(100).length).toBe(2);

    // 降频至 8 分钟：t=11min 未触发，t=14min 触发
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(observationStore.getRecent(100).length).toBe(2);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(vlmMocks.captureAndAnalyze).toHaveBeenCalledTimes(1); // 仍跳过 VLM
    const second = observationStore.getLatest();
    expect(second?.noChange).toBe(true);
    expect(second?.noChangeSince).toBe(t0 + 180_000); // 连续段延续不重置
    expect(observationStore.getRecent(100).length).toBe(3);
  });

  it("内容恢复变化：像素对比翻转为有变化，重新走 VLM", async () => {
    vlmMocks.captureAndAnalyze.mockImplementation(async () => {
      const obs = { timestamp: Date.now(), summary: "类型：工作\n与上次比较：延续\n用户在写代码。", source: "periodic" as const };
      observationStore.add(obs);
      return obs;
    });
    screenMonitorService.start();

    await vi.advanceTimersByTimeAsync(180_000); // 首次 VLM 建立基线
    diffMocks.bitmapsNoChange.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(180_000); // 无变化 → 降频
    expect(observationStore.getLatest()?.noChange).toBe(true);

    diffMocks.bitmapsNoChange.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(8 * 60_000); // 低频 tick，像素已有变化
    expect(vlmMocks.captureAndAnalyze).toHaveBeenCalledTimes(2); // VLM 重新启用
  });
});
