import { describe, expect, it, vi } from "vitest";
import { ToolExecutionError } from "./tool-execution-error";
import { executeToolDefinition } from "./tool-executor";
import type { ToolDefinition } from "./tool-registry";

function fakeTool(execute: ToolDefinition["execute"]): ToolDefinition {
  return {
    id: "fake",
    name: "Fake",
    description: "fake tool",
    enabled: true,
    inputSchema: { type: "object", properties: {} },
    execute,
  };
}

describe("executeToolDefinition", () => {
  it("normalizes a normal return as succeeded", async () => {
    const outcome = await executeToolDefinition(fakeTool(vi.fn(async () => "ok")), {});
    expect(outcome).toMatchObject({ status: "succeeded", output: "ok", terminal: true, retryable: false });
  });

  it("always passes ToolContext so every tool can observe the run signal", async () => {
    const execute = vi.fn(async () => "ok");
    const signal = new AbortController().signal;
    await executeToolDefinition(fakeTool(execute), {}, { userQuery: "", signal });
    expect(execute).toHaveBeenCalledWith({}, expect.objectContaining({ signal }));
  });

  it("preserves typed failure facts", async () => {
    const error = new ToolExecutionError("E_REMOTE_TIMEOUT", "unknown outcome", "timeout", false, "unknown");
    const outcome = await executeToolDefinition(fakeTool(vi.fn(async () => { throw error; })), {});
    expect(outcome).toMatchObject({
      status: "failed",
      errorCode: "E_REMOTE_TIMEOUT",
      category: "timeout",
      retryable: false,
      effectState: "unknown",
      output: "unknown outcome",
    });
  });

  it("keeps compatibility with legacy JSON success:false", async () => {
    const output = JSON.stringify({ success: false, error: "bad input", errorCode: "E_BAD", retryable: true });
    const outcome = await executeToolDefinition(fakeTool(vi.fn(async () => output)), {});
    expect(outcome).toMatchObject({ status: "failed", errorCode: "E_BAD", output: "bad input", retryable: true });
  });

  it("only treats leading legacy error markers as failure", async () => {
    const marked = await executeToolDefinition(fakeTool(vi.fn(async () => "[错误] failed")), {});
    const rejected = await executeToolDefinition(fakeTool(vi.fn(async () => "[拒绝] denied")), {});
    const ordinary = await executeToolDefinition(fakeTool(vi.fn(async () => "error rates are documented")), {});

    expect(marked.status).toBe("failed");
    expect(rejected).toMatchObject({ status: "failed", category: "permission_denied" });
    expect(ordinary.status).toBe("succeeded");
  });

  it("rethrows AbortError instead of converting cancellation to a tool failure", async () => {
    const error = new Error("cancelled");
    error.name = "AbortError";
    await expect(executeToolDefinition(fakeTool(vi.fn(async () => { throw error; })), {}))
      .rejects.toMatchObject({ name: "AbortError" });
  });
});
