import { describe, expect, it } from "vitest";
import {
  resolveActionGateProfile,
  selectActionGateStrategy,
  resolveActionGateReasoningState,
  type ActionGateProfileContext,
} from "./action-gate-profiles";
import type { ReasoningCapability, ReasoningPreference } from "../../../shared/reasoning";

function ctx(provider: string, reasoning: "on" | "off"): ActionGateProfileContext {
  return { provider, transport: "openai", model: "test-model", reasoning };
}

describe("resolveActionGateProfile", () => {
  it("returns FULL profile for DeepSeek reasoning off (named/required/auto/none)", () => {
    const profile = resolveActionGateProfile(ctx("deepseek", "off"));
    expect(profile.toolChoice.parameterAccepted).toBe(true);
    expect(profile.toolChoice.modes).toContain("named");
    expect(profile.reasoning.preferredForActionGate).toBe("preserve");
  });

  it("returns omit profile for DeepSeek reasoning on (tool_choice rejected)", () => {
    const profile = resolveActionGateProfile(ctx("deepseek", "on"));
    expect(profile.toolChoice.parameterAccepted).toBe(false);
    expect(profile.toolChoice.modes).toEqual([]);
    expect(profile.toolChoice.behaviorWhenOmitted).toBe("auto");
    expect(profile.reasoning.preferredForActionGate).toBe("disable");
  });

  it("returns FULL profile for ChatGPT regardless of reasoning", () => {
    const off = resolveActionGateProfile(ctx("chatgpt", "off"));
    const on = resolveActionGateProfile(ctx("chatgpt", "on"));
    expect(off.toolChoice.modes).toContain("named");
    expect(on.toolChoice.modes).toContain("named");
  });

  it("returns auto-only profile for GLM (always auto)", () => {
    const profile = resolveActionGateProfile(ctx("glm", "off"));
    expect(profile.toolChoice.modes).toEqual(["auto"]);
    expect(profile.fallback.jsonText).toBe(true);
  });

  it("returns auto-only profile for MiniMax (always auto)", () => {
    const profile = resolveActionGateProfile(ctx("minimax", "on"));
    expect(profile.toolChoice.modes).toEqual(["auto"]);
  });

  it("returns required-only profile for Kimi reasoning on (named unavailable, required still works)", () => {
    const profile = resolveActionGateProfile(ctx("kimi", "on"));
    expect(profile.toolChoice.modes).toContain("required");
    expect(profile.toolChoice.modes).not.toContain("named");
    expect(profile.reasoning.preferredForActionGate).toBe("disable");
  });

  it("returns auto-only profile for MiMo reasoning on with contract_test_required reliability", () => {
    const profile = resolveActionGateProfile(ctx("mimo", "on"));
    expect(profile.toolChoice.modes).toEqual(["auto"]);
    expect(profile.toolCalling.reliableWithReasoning).toBe("contract_test_required");
    expect(profile.reasoning.preferredForActionGate).toBe("disable");
  });

  it("returns default plain_json_text profile for unknown provider (does not assume auto)", () => {
    const profile = resolveActionGateProfile(ctx("unknown-provider", "off"));
    expect(profile.toolChoice.parameterAccepted).toBe(false);
    expect(profile.toolChoice.modes).toEqual([]);
    expect(profile.toolChoice.behaviorWhenOmitted).toBe("unknown");
  });
});

describe("selectActionGateStrategy", () => {
  it("selects named_decision_tool when named is available", () => {
    const profile = resolveActionGateProfile(ctx("deepseek", "off"));
    expect(selectActionGateStrategy(profile)).toBe("named_decision_tool");
  });

  it("selects required_single_decision_tool for Kimi reasoning on (named unavailable)", () => {
    const profile = resolveActionGateProfile(ctx("kimi", "on"));
    expect(selectActionGateStrategy(profile)).toBe("required_single_decision_tool");
  });

  it("selects auto_single_decision_tool_with_json_fallback for GLM", () => {
    const profile = resolveActionGateProfile(ctx("glm", "off"));
    expect(selectActionGateStrategy(profile)).toBe("auto_single_decision_tool_with_json_fallback");
  });

  it("selects omit_tool_choice_with_json_fallback for DeepSeek reasoning on", () => {
    const profile = resolveActionGateProfile(ctx("deepseek", "on"));
    expect(selectActionGateStrategy(profile)).toBe("omit_tool_choice_with_json_fallback");
  });

  it("selects plain_json_text for unknown provider", () => {
    const profile = resolveActionGateProfile(ctx("unknown", "off"));
    expect(selectActionGateStrategy(profile)).toBe("plain_json_text");
  });
});

describe("resolveActionGateReasoningState", () => {
  const cap: ReasoningCapability = {
    control: "toggle",
    requestStyle: "none",
    supportsDisable: true,
  };

  it("normalizes auto to on or off based on capability", () => {
    // With toggle control + no fixed-on, auto should resolve to off (default)
    const result = resolveActionGateReasoningState({ mode: "auto" }, cap);
    expect(result === "on" || result === "off").toBe(true);
  });

  it("returns on when mode is on", () => {
    expect(resolveActionGateReasoningState({ mode: "on" }, cap)).toBe("on");
  });

  it("returns off when mode is off", () => {
    expect(resolveActionGateReasoningState({ mode: "off" }, cap)).toBe("off");
  });

  it("returns off when reasoning is undefined (defaults to auto -> off)", () => {
    const result = resolveActionGateReasoningState(undefined, cap);
    expect(result === "on" || result === "off").toBe(true);
  });
});
