import { describe, expect, it } from "vitest";
import {
  authorizeUncertainEffectRepeat,
  evaluateUncertainEffect,
} from "./uncertain-effect-guard";
import type { AgentState } from "./types";

function state(): AgentState {
  return {
    todoItems: [],
    uncertainEffects: [{
      id: "effect-1",
      toolCallId: "call-old",
      fingerprint: "same-effect",
      toolName: "send_email",
      message: "outcome unknown",
    }],
  };
}

describe("UncertainEffectGuard", () => {
  it("blocks only a related non-idempotent request", () => {
    expect(evaluateUncertainEffect(state(), "same-effect", "non_idempotent_side_effect"))
      .toMatchObject({ allowed: false, effect: { id: "effect-1" } });
    expect(evaluateUncertainEffect(state(), "different", "non_idempotent_side_effect"))
      .toEqual({ allowed: true });
    expect(evaluateUncertainEffect(state(), "same-effect", "read_only"))
      .toEqual({ allowed: true });
    expect(evaluateUncertainEffect(state(), "same-effect", "idempotent_mutation"))
      .toEqual({ allowed: true });
  });

  it("requires runtime-recorded user authorization and consumes it once", () => {
    const current = state();
    expect(authorizeUncertainEffectRepeat(current, "missing")).toBe(false);
    expect(authorizeUncertainEffectRepeat(current, "effect-1", 123)).toBe(true);

    expect(evaluateUncertainEffect(current, "same-effect", "non_idempotent_side_effect"))
      .toEqual({ allowed: true });
    expect(current.uncertainEffects).toHaveLength(0);
    expect(evaluateUncertainEffect(current, "same-effect", "non_idempotent_side_effect"))
      .toEqual({ allowed: true });
  });
});
