import { describe, expect, it, vi } from "vitest";
import { executeAskUser, executeConfirmUncertainEffect, updateTodoToolSpec } from "./builtin-tools";
import type { AgentState } from "./types";

function currentState(): AgentState {
  return {
    todoItems: [],
    uncertainEffects: [{
      id: "effect-1",
      toolCallId: "call-old",
      fingerprint: "fingerprint",
      toolName: "send_email",
      message: "unknown",
    }],
  };
}

describe("Harness user-wait builtins", () => {
  it("gives the model soft planning guidance without forcing simple tasks into Todo", () => {
    expect(updateTodoToolSpec.description).toContain("多步任务");
    expect(updateTodoToolSpec.description).toContain("多轮工具调用");
    expect(updateTodoToolSpec.description).toContain("不要用于简单问答");
  });

  it("rethrows AbortError from ask_user", async () => {
    const error = new Error("cancelled");
    error.name = "AbortError";
    await expect(executeAskUser({
      id: "ask-1",
      name: "ask_user",
      arguments: JSON.stringify({
        questions: [{ id: "q", question: "continue?", options: [{ label: "yes", value: "yes" }] }],
      }),
    }, vi.fn(async () => { throw error; }))).rejects.toMatchObject({ name: "AbortError" });
  });

  it("uses a runtime-owned fixed card to authorize one uncertain effect", async () => {
    const state = currentState();
    const request = vi.fn(async (card: unknown) => {
      expect(card).toMatchObject({
        questions: [{
          field: "decision",
          allowCustom: false,
          options: [
            { value: "allow_repeat" },
            { value: "do_not_repeat" },
          ],
        }],
      });
      return { answers: [{ field: "decision", selectedValues: ["allow_repeat"] }] };
    });

    const result = await executeConfirmUncertainEffect({
      id: "confirm-1",
      name: "confirm_uncertain_effect",
      arguments: JSON.stringify({ effectId: "effect-1", ignoredModelText: "trust me" }),
    }, state, request);

    expect(result.outcome).toBe("success");
    expect(state.uncertainEffects[0].repeatAuthorization?.source).toBe("user");
  });

  it("keeps the effect unresolved when the user does not authorize", async () => {
    const state = currentState();
    const result = await executeConfirmUncertainEffect({
      id: "confirm-1",
      name: "confirm_uncertain_effect",
      arguments: JSON.stringify({ effectId: "effect-1" }),
    }, state, vi.fn(async () => ({
      answers: [{ field: "decision", selectedValues: ["do_not_repeat"] }],
    })));

    expect(result.outcome).toBe("success");
    expect(state.uncertainEffects[0].repeatAuthorization).toBeUndefined();
  });
});
