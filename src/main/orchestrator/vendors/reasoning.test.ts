import { describe, expect, test } from "vitest";
import { applyReasoningPreference } from "./reasoning";
import type { ReasoningCapability } from "../../../shared/reasoning";

const ctx = { hasTools: false, providerId: "test", model: "test-model" };
const ctxWithTools = { hasTools: true, providerId: "test", model: "test-model" };

const noneCap: ReasoningCapability = {
  control: "none",
  requestStyle: "none",
  supportsDisable: false,
};

const dynamicCap: ReasoningCapability = {
  control: "dynamic",
  requestStyle: "none",
  supportsDisable: false,
};

const fixedOnThinkingCap: ReasoningCapability = {
  control: "fixed-on",
  requestStyle: "thinking-type",
  supportsDisable: false,
};

const fixedOnNoneCap: ReasoningCapability = {
  control: "fixed-on",
  requestStyle: "none",
  supportsDisable: false,
};

const fixedOnAdaptiveCap: ReasoningCapability = {
  control: "fixed-on",
  requestStyle: "anthropic-adaptive",
  supportsDisable: false,
};

const toggleQwenCap: ReasoningCapability = {
  control: "toggle",
  requestStyle: "qwen-enable-thinking",
  supportsDisable: true,
};

const toggleThinkingKeepCap: ReasoningCapability = {
  control: "toggle",
  requestStyle: "thinking-type",
  supportsDisable: true,
  keepOnTools: true,
};

const toggleThinkingNoKeepCap: ReasoningCapability = {
  control: "toggle",
  requestStyle: "thinking-type",
  supportsDisable: true,
  keepOnTools: false,
};

const toggleAdaptiveCap: ReasoningCapability = {
  control: "toggle",
  requestStyle: "anthropic-adaptive",
  supportsDisable: true,
};

const effortDisableCap: ReasoningCapability = {
  control: "effort",
  supportedEfforts: ["high", "max"],
  defaultEffort: "high",
  requestStyle: "openai-effort",
  supportsDisable: true,
};

const effortNoDisableCap: ReasoningCapability = {
  control: "effort",
  supportedEfforts: ["high", "max"],
  defaultEffort: "high",
  requestStyle: "openai-effort",
  supportsDisable: false,
};

const toggleEffortAnthropicCap: ReasoningCapability = {
  control: "toggle-effort",
  supportedEfforts: ["low", "medium", "high"],
  defaultEffort: "high",
  requestStyle: "anthropic-adaptive",
  supportsDisable: true,
};

describe("applyReasoningPreference — auto 路径", () => {
  test("auto + 任何 control → 不增加字段", () => {
    const body = { model: "x", messages: [] };
    expect(applyReasoningPreference(body, { mode: "auto" }, noneCap, ctx)).toEqual(body);
    expect(applyReasoningPreference(body, { mode: "auto" }, toggleQwenCap, ctx)).toEqual(body);
    expect(applyReasoningPreference(body, { mode: "auto" }, toggleAdaptiveCap, ctx)).toEqual(body);
  });

  test("不修改入参（snapshot）", () => {
    const body = { model: "x", messages: [] };
    const snapshot = { ...body };
    applyReasoningPreference(body, { mode: "on" }, toggleAdaptiveCap, ctx);
    expect(body).toEqual(snapshot);
  });
});

describe("applyReasoningPreference — none / dynamic", () => {
  test("none + 任何 mode → body 不变", () => {
    const body = { messages: [] };
    expect(applyReasoningPreference(body, { mode: "on" }, noneCap, ctx)).toEqual(body);
    expect(applyReasoningPreference(body, { mode: "off" }, noneCap, ctx)).toEqual(body);
  });

  test("dynamic + 任何 mode → body 不变", () => {
    const body = { messages: [] };
    expect(applyReasoningPreference(body, { mode: "on" }, dynamicCap, ctx)).toEqual(body);
    expect(applyReasoningPreference(body, { mode: "off" }, dynamicCap, ctx)).toEqual(body);
  });
});

describe("applyReasoningPreference — fixed-on 归一化（用户修订 #3）", () => {
  test("fixed-on + thinking-type + off → effective=on，注入 { type: 'enabled' }", () => {
    const body = {};
    const result = applyReasoningPreference(body, { mode: "off" }, fixedOnThinkingCap, ctx);
    expect(result).toEqual({ thinking: { type: "enabled" } });
  });

  test("fixed-on + requestStyle=none + off → body 不变（K2.7-Code 路径）", () => {
    const body = { messages: [] };
    expect(applyReasoningPreference(body, { mode: "off" }, fixedOnNoneCap, ctx)).toEqual(body);
  });

  test("fixed-on + anthropic-adaptive + auto → 注入 { type: 'adaptive' }", () => {
    const body = {};
    const result = applyReasoningPreference(body, { mode: "auto" }, fixedOnAdaptiveCap, ctx);
    expect(result).toEqual({ thinking: { type: "adaptive" } });
  });

  test("fixed-on + on → 注入启用字段", () => {
    const body = {};
    const result = applyReasoningPreference(body, { mode: "on" }, fixedOnAdaptiveCap, ctx);
    expect(result).toEqual({ thinking: { type: "adaptive" } });
  });
});

describe("applyReasoningPreference — toggle", () => {
  test("qwen + on → enable_thinking: true", () => {
    expect(applyReasoningPreference({}, { mode: "on" }, toggleQwenCap, ctx))
      .toEqual({ enable_thinking: true });
  });

  test("qwen + off → enable_thinking: false", () => {
    expect(applyReasoningPreference({}, { mode: "off" }, toggleQwenCap, ctx))
      .toEqual({ enable_thinking: false });
  });

  test("thinking-type + on → { type: 'enabled' }", () => {
    expect(applyReasoningPreference({}, { mode: "on" }, toggleThinkingNoKeepCap, ctx))
      .toEqual({ thinking: { type: "enabled" } });
  });

  test("thinking-type + on + keepOnTools=true + hasTools → { type: 'enabled', keep: 'all' }（K2.6 路径）", () => {
    expect(applyReasoningPreference({}, { mode: "on" }, toggleThinkingKeepCap, ctxWithTools))
      .toEqual({ thinking: { type: "enabled", keep: "all" } });
  });

  test("thinking-type + on + keepOnTools=false + hasTools → 无 keep（K2.5 路径）", () => {
    expect(applyReasoningPreference({}, { mode: "on" }, toggleThinkingNoKeepCap, ctxWithTools))
      .toEqual({ thinking: { type: "enabled" } });
  });

  test("thinking-type + off → { type: 'disabled' }", () => {
    expect(applyReasoningPreference({}, { mode: "off" }, toggleThinkingNoKeepCap, ctx))
      .toEqual({ thinking: { type: "disabled" } });
  });

  test("anthropic-adaptive（MiniMax-M3）+ on → { type: 'adaptive' }（不是 enabled）", () => {
    expect(applyReasoningPreference({}, { mode: "on" }, toggleAdaptiveCap, ctx))
      .toEqual({ thinking: { type: "adaptive" } });
  });

  test("anthropic-adaptive（MiniMax-M3）+ off → { type: 'disabled' }", () => {
    expect(applyReasoningPreference({}, { mode: "off" }, toggleAdaptiveCap, ctx))
      .toEqual({ thinking: { type: "disabled" } });
  });
});

describe("applyReasoningPreference — effort / supportsDisable（用户修订 #1）", () => {
  test("effort + on + effort 在 supportedEfforts → reasoning_effort 字段", () => {
    expect(applyReasoningPreference({}, { mode: "on", effort: "max" }, effortDisableCap, ctx))
      .toEqual({ reasoning_effort: "max" });
  });

  test("effort + on + effort 不在 supportedEfforts（已被 resolveEffectiveReasoning 退回 defaultEffort）→ reasoning_effort 用 defaultEffort", () => {
    // 模拟 resolveEffectiveReasoning 已把 'max' 退回 'high' 后的 preference
    expect(applyReasoningPreference({}, { mode: "on", effort: "high" }, effortDisableCap, ctx))
      .toEqual({ reasoning_effort: "high" });
  });

  test("effort + off + supportsDisable=true → reasoning_effort: 'none'", () => {
    expect(applyReasoningPreference({}, { mode: "off" }, effortDisableCap, ctx))
      .toEqual({ reasoning_effort: "none" });
  });

  test("effort + off + supportsDisable=false → body 不变（OpenAI GPT-5.6 路径）", () => {
    expect(applyReasoningPreference({}, { mode: "off" }, effortNoDisableCap, ctx))
      .toEqual({});
  });
});

describe("applyReasoningPreference — toggle-effort", () => {
  test("anthropic-adaptive + on → output_config.effort 合并已有 output_config", () => {
    const body = { output_config: { other_field: "keep_me" } };
    // cap.supportedEfforts = [low, medium, high]，high 在列里
    expect(applyReasoningPreference(body, { mode: "on", effort: "high" }, toggleEffortAnthropicCap, ctx))
      .toEqual({
        output_config: { other_field: "keep_me", effort: "high" },
        thinking: { type: "adaptive" },
      });
  });

  test("anthropic-adaptive + on + effort 不在 supportedEfforts → 安全网退回 defaultEffort", () => {
    const body = {};
    // xhigh 不在 [low, medium, high] 内
    expect(applyReasoningPreference(body, { mode: "on", effort: "xhigh" }, toggleEffortAnthropicCap, ctx))
      .toEqual({
        output_config: { effort: "high" },
        thinking: { type: "adaptive" },
      });
  });

  test("anthropic-adaptive + on + 无 output_config → 直接设 effort", () => {
    expect(applyReasoningPreference({}, { mode: "on", effort: "high" }, toggleEffortAnthropicCap, ctx))
      .toEqual({
        output_config: { effort: "high" },
        thinking: { type: "adaptive" },
      });
  });

  test("anthropic-adaptive + off → thinking.type=disabled，不发 effort", () => {
    expect(applyReasoningPreference({}, { mode: "off" }, toggleEffortAnthropicCap, ctx))
      .toEqual({ thinking: { type: "disabled" } });
  });

  test("thinking-type + on → thinking.enabled + reasoning_effort", () => {
    const cap: ReasoningCapability = {
      control: "toggle-effort",
      supportedEfforts: ["high", "max"],
      defaultEffort: "high",
      requestStyle: "thinking-type",
      supportsDisable: true,
    };
    expect(applyReasoningPreference({}, { mode: "on", effort: "max" }, cap, ctx))
      .toEqual({
        thinking: { type: "enabled" },
        reasoning_effort: "max",
      });
  });
});

describe("applyReasoningPreference — 已有字段合并", () => {
  test("anthropic output_config 已有字段不被覆盖", () => {
    const body = {
      output_config: { format: "json", effort: "old" },
    };
    const result = applyReasoningPreference(
      body,
      { mode: "on", effort: "high" },
      toggleEffortAnthropicCap,
      ctx,
    );
    expect((result.output_config as Record<string, unknown>).format).toBe("json");
    expect((result.output_config as Record<string, unknown>).effort).toBe("high");
  });

  test("已有 body 字段保留", () => {
    const body = { model: "x", messages: [{ role: "user", content: "hi" }] };
    const result = applyReasoningPreference(body, { mode: "on" }, toggleAdaptiveCap, ctx);
    expect(result.model).toBe("x");
    expect(result.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(result.thinking).toEqual({ type: "adaptive" });
  });
});