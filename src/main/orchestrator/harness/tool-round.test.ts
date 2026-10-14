import { describe, expect, it, vi } from "vitest";
import { runToolRound } from "./tool-round";
import type { HarnessRun } from "./cyrene-harness";
import type { ToolDefinition } from "../tools/registry/tool-registry";

function fixture(checkPermission: () => Promise<boolean>, onStarted?: () => void) {
  const lifecycle: string[] = [];
  const controller = new AbortController();
  const execute = vi.fn(async () => { lifecycle.push("execute"); return "done"; });
  const tool: ToolDefinition = { id: "send_email", name: "Send", description: "test", enabled: true,
    effectKind: "external_side_effect", inputSchema: { type: "object", properties: {} }, execute };
  const state = { todoItems: [], uncertainEffects: [] };
  const run = {
    input: { tools: [tool], signal: controller.signal, onToolLifecycle: (event: { status: string }) => {
      lifecycle.push(event.status);
      if (event.status === "started") onStarted?.();
    } },
    state, messages: [], toolOutputs: [], toolCallStartedAt: new Map(), config: { maxParallelToolCalls: 1 },
    streamController: { flushProgressBufferAsProgress: () => "" },
    toolDispatchContext: { state, tools: [tool], checkPermission, deferOutputPersistence: true },
  } as unknown as HarnessRun;
  return { run, execute, lifecycle, controller };
}
const call = { id: "test", name: "send_email", arguments: "{}" };

describe("tool-round execution accounting", () => {
  it("records planned during permission, started only immediately before execution", async () => {
    const h = fixture(async () => { expect(h.lifecycle).toEqual(["planned"]); return true; });
    await runToolRound(h.run, [call]);
    expect(h.lifecycle).toEqual(["planned", "started", "execute", "committed"]);
  });
  it("does not record started on denial or failed start persistence", async () => {
    const denied = fixture(async () => false);
    await runToolRound(denied.run, [call]);
    expect(denied.lifecycle).toEqual(["planned", "committed"]);
    expect(denied.execute).not.toHaveBeenCalled();
    const failed = fixture(async () => true, () => { throw new Error("disk failure"); });
    await expect(runToolRound(failed.run, [call])).rejects.toThrow("disk failure");
    expect(failed.execute).not.toHaveBeenCalled();
  });
  it("does not execute late after cancellation while permission is pending", async () => {
    let grant!: (allowed: boolean) => void;
    const h = fixture(() => new Promise((resolve) => { grant = resolve; }));
    const pending = runToolRound(h.run, [call]);
    await Promise.resolve();
    h.controller.abort();
    expect(await pending).toBe("cancelled");
    grant(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.lifecycle).toEqual(["planned", "not_executed"]);
    expect(h.execute).not.toHaveBeenCalled();
  });
});
