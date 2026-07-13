// 推理控件 UI 渲染测试（§11.4 F）。
// 测试纯函数 computeReasoningView：返回 UI 应展示的状态。
// renderReasoningControls 是 DOM 应用层，浏览器内由 settings.ts 调用，本文件不重复测。

import { describe, expect, test } from "vitest";
import { computeReasoningView } from "./reasoning-controls";
import type { ReasoningPreference } from "../../shared/reasoning";

describe("computeReasoningView — fixed-on 控件形态（用户第二轮修订 #3）", () => {
  test("kimi-k2.7-code → modeRow 与 effortRow 隐藏，fixedOnRow 显示", () => {
    const v = computeReasoningView("kimi", "kimi-k2.7-code", { mode: "on" });
    expect(v.capabilityControl).toBe("fixed-on");
    expect(v.modeRowHidden).toBe(true);
    expect(v.effortRowHidden).toBe(true);
    expect(v.fixedOnRowHidden).toBe(false);
    expect(v.statusText).toBe("");
    expect(v.effortButtons).toEqual([]);
  });

  test("kimi-k2.7-code + saved=off → effective 仍为 on（fixed-on 归一化）", () => {
    const v = computeReasoningView("kimi", "kimi-k2.7-code", { mode: "off" });
    expect(v.capabilityControl).toBe("fixed-on");
    expect(v.activeMode).toBe("on");
    expect(v.modeRowHidden).toBe(true);
    expect(v.fixedOnRowHidden).toBe(false);
  });
});

describe("computeReasoningView — dynamic（火山）控件形态", () => {
  test("ark-code-latest → 控件整体禁用，文案提示", () => {
    const v = computeReasoningView("volcengine", "ark-code-latest", { mode: "on" });
    expect(v.capabilityControl).toBe("dynamic");
    expect(v.modeRowHidden).toBe(false);
    expect(v.effortRowHidden).toBe(true);
    expect(v.modeDisabled).toEqual({ auto: true, off: true, on: true });
    expect(v.statusText).toContain("跟随火山动态路由");
  });
});

describe("computeReasoningView — none（未配置）", () => {
  test("未知 provider → 只允许 auto，文案提示", () => {
    const v = computeReasoningView("unknown", "anything", { mode: "on" });
    expect(v.capabilityControl).toBe("none");
    expect(v.effortRowHidden).toBe(true);
    expect(v.statusText).toContain("未配置推理控制");
    expect(v.modeDisabled).toEqual({ auto: false, off: true, on: true });
    expect(v.activeMode).toBe("auto"); // resolveEffectiveReasoning 归一化为 auto
  });
});

describe("computeReasoningView — toggle / effort / toggle-effort", () => {
  test("mimo mimo-v2.5-pro + on → mode=on 高亮，effort 行隐藏（无 supportedEfforts）", () => {
    const v = computeReasoningView("mimo", "mimo-v2.5-pro", { mode: "on" });
    expect(v.capabilityControl).toBe("toggle");
    expect(v.activeMode).toBe("on");
    expect(v.effortRowHidden).toBe(true);
    expect(v.effortButtons).toEqual([]);
  });

  test("deepseek deepseek-v4-pro + {on, max} → mode=on 高亮，effort 行显示 high+max 两个按钮", () => {
    const v = computeReasoningView("deepseek", "deepseek-v4-pro", { mode: "on", effort: "max" });
    expect(v.capabilityControl).toBe("toggle-effort");
    expect(v.activeMode).toBe("on");
    expect(v.effortRowHidden).toBe(false);
    expect(v.effortButtons.map(e => e.label)).toEqual(["高", "最强"]);
    expect(v.effortButtons.find(e => e.effort === "max")?.active).toBe(true);
  });

  test("ChatGPT gpt-5.6 + {on, high} → effort 行显示 [低, 中, 高, 极高, 最强]（不含 minimal）", () => {
    const v = computeReasoningView("chatgpt", "gpt-5.6", { mode: "on", effort: "high" });
    expect(v.effortButtons.map(e => e.label)).toEqual(["低", "中", "高", "极高", "最强"]);
    expect(v.effortButtons.find(e => e.effort === "high")?.active).toBe(true);
  });

  test("saved.effort 不被支持 → 高亮 defaultEffort，状态文案显示实际档位", () => {
    const v = computeReasoningView("deepseek", "deepseek-v4-pro", { mode: "on", effort: "low" });
    // effort: "low" 不在 [high, max] 内 → 退回 defaultEffort "high"
    expect(v.effortButtons.find(e => e.effort === "high")?.active).toBe(true);
    expect(v.statusText).toContain("你之前选的 low 不被该模型支持");
    expect(v.statusText).toContain("当前实际档位：high");
  });

  test("resolved saved 与 effective 同步：saved.effort 在 supportedEfforts → 不显示降级提示", () => {
    const v = computeReasoningView("deepseek", "deepseek-v4-pro", { mode: "on", effort: "high" });
    expect(v.effortButtons.find(e => e.effort === "high")?.active).toBe(true);
    expect(v.statusText).not.toContain("不被该模型支持");
  });
});

describe("computeReasoningView — 切模型自动重渲染（saved 不动）", () => {
  test("saved 始终不被覆盖：saved.effort=high，切到不支持 high 的模型，effective 退回 default 但 saved 仍是 high", () => {
    const saved: ReasoningPreference = { mode: "on", effort: "high" };
    const v1 = computeReasoningView("deepseek", "deepseek-v4-pro", saved);
    expect(v1.effortButtons.find(e => e.effort === "high")?.active).toBe(true);

    // 切到 GLM-5.2 (toggle-effort, [high, max], default=high) —— high 还在列，effective 仍是 high
    const v2 = computeReasoningView("glm", "glm-5.2", saved);
    expect(v2.effortButtons.find(e => e.effort === "high")?.active).toBe(true);

    // saved 永远是 high（用户修订 #5：不覆盖）
    expect(saved).toEqual({ mode: "on", effort: "high" });
  });

  test("从 gpt-5.6（effort 5 档）切到 mimo-v2.5-pro（无 effort）→ effort 行隐藏", () => {
    const v1 = computeReasoningView("chatgpt", "gpt-5.6", { mode: "on", effort: "high" });
    expect(v1.effortButtons.length).toBeGreaterThan(0);

    const v2 = computeReasoningView("mimo", "mimo-v2.5-pro", { mode: "on", effort: "high" });
    expect(v2.effortRowHidden).toBe(true);
    expect(v2.effortButtons).toEqual([]);
  });
});

describe("computeReasoningView — supportsDisable=false 的体现", () => {
  test("MiniMax M3 → mode 按钮都可点（off 不被禁用，因为它是 toggle 而非 effort）", () => {
    const v = computeReasoningView("minimax", "MiniMax-M3", { mode: "on" });
    expect(v.capabilityControl).toBe("toggle");
    expect(v.modeDisabled).toEqual({ auto: false, off: false, on: false });
  });

  test("MiniMax-M2.7 → fixed-on，三按钮隐藏", () => {
    const v = computeReasoningView("minimax", "MiniMax-M2.7", { mode: "off" });
    expect(v.capabilityControl).toBe("fixed-on");
    expect(v.modeRowHidden).toBe(true);
  });
});