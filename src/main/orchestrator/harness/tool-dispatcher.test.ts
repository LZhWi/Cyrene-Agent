import { describe, expect, it, vi } from "vitest";
import { ExecutionLedger } from "../execution-ledger";
import { ToolExecutionError } from "../tool-execution-error";
import type { ToolDefinition } from "../tool-registry";
import type { AgentState } from "./types";
import { dispatchToolCall } from "./tool-dispatcher";
import { authorizeUncertainEffectRepeat } from "./uncertain-effect-guard";

function state(): AgentState {
  return { todoItems: [], uncertainEffects: [] };
}

function tool(
  execute: ToolDefinition["execute"],
  effectKind: ToolDefinition["effectKind"] = "read",
): ToolDefinition {
  return {
    id: "send_email",
    name: "Send Email",
    description: "send",
    enabled: true,
    inputSchema: { type: "object", properties: {} },
    effectKind,
    execute,
  };
}

function call(id: string, args: Record<string, unknown> = { to: "a@example.com" }) {
  return { id, name: "send_email", arguments: JSON.stringify(args) };
}

describe("dispatchToolCall truthful execution", () => {
  it("preserves typed error facts in the failure observation", async () => {
    const result = await dispatchToolCall(call("call-1"), {
      state: state(),
      tools: [tool(vi.fn(async () => {
        throw new ToolExecutionError("E_TIMEOUT", "unknown", "timeout", false, "unknown");
      }))],
      toolContext: { userQuery: "", runId: "run-1" },
    });

    expect(result).toMatchObject({ outcome: "failure", category: "timeout" });
    expect(result.rawResult).toMatchObject({
      status: "failed",
      errorCode: "E_TIMEOUT",
      category: "timeout",
      effectState: "unknown",
    });
  });

  it("rethrows AbortError", async () => {
    const error = new Error("cancelled");
    error.name = "AbortError";
    await expect(dispatchToolCall(call("call-1"), {
      state: state(),
      tools: [tool(vi.fn(async () => { throw error; }))],
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("replays only the same logical invocation", async () => {
    const execute = vi.fn(async () => "sent");
    const ledger = new ExecutionLedger();
    const current = state();
    const context = {
      state: current,
      tools: [tool(execute, "external_side_effect")],
      toolContext: { userQuery: "", runId: "run-1" },
      executionLedger: ledger,
    };

    const first = await dispatchToolCall(call("call-123"), context);
    const replay = await dispatchToolCall(call("call-123"), context);
    const newIntent = await dispatchToolCall(call("call-456"), context);

    expect(first.rawResult?.deduplicated).not.toBe(true);
    expect(replay.rawResult?.deduplicated).toBe(true);
    expect(newIntent.rawResult?.deduplicated).not.toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("separately guards an unresolved non-idempotent unknown effect", async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(new ToolExecutionError("E_TIMEOUT", "unknown", "timeout", false, "unknown"))
      .mockResolvedValueOnce("sent after approval");
    const current = state();
    const context = {
      state: current,
      tools: [tool(execute, "external_side_effect")],
      toolContext: { userQuery: "", runId: "run-1" },
      executionLedger: new ExecutionLedger(),
    };

    const unknown = await dispatchToolCall(call("call-old"), context);
    expect(unknown.outcome).toBe("unknown");
    expect(current.uncertainEffects).toHaveLength(1);

    const blocked = await dispatchToolCall(call("call-new"), context);
    expect(blocked).toMatchObject({ outcome: "not_executed", category: "runtime_safety" });
    expect(blocked.message).toContain(current.uncertainEffects[0].id);
    expect(execute).toHaveBeenCalledTimes(1);

    expect(authorizeUncertainEffectRepeat(current, current.uncertainEffects[0].id)).toBe(true);
    const allowed = await dispatchToolCall(call("call-approved"), context);
    expect(allowed.outcome).toBe("success");
    expect(current.uncertainEffects).toHaveLength(0);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not guard a different request fingerprint", async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(new ToolExecutionError("E_TIMEOUT", "unknown", "timeout", false, "unknown"))
      .mockResolvedValueOnce("sent elsewhere");
    const current = state();
    const context = {
      state: current,
      tools: [tool(execute, "external_side_effect")],
      toolContext: { userQuery: "", runId: "run-1" },
    };
    await dispatchToolCall(call("call-old"), context);
    const result = await dispatchToolCall(call("call-new", { to: "b@example.com" }), context);
    expect(result.outcome).toBe("success");
  });
});
