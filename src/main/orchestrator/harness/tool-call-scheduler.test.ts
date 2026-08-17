import { describe, expect, it } from "vitest";
import type { ToolCall } from "../vendors/types";
import type { ToolDefinition } from "../tool-registry";
import { classifyToolExecutionMode, scheduleToolCalls } from "./tool-call-scheduler";

function call(name: string): ToolCall {
  return { id: `${name}-call`, name, arguments: "{}" };
}

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    id: "read_file",
    name: "Read file",
    description: "read",
    enabled: true,
    inputSchema: { type: "object", properties: {} },
    effectKind: "read",
    execute: async () => "ok",
    ...overrides,
  };
}

describe("classifyToolExecutionMode", () => {
  it("requires an explicit safe declaration for an ordinary read tool", () => {
    expect(classifyToolExecutionMode(call("read_file"), [tool()])).toBe("exclusive");
    expect(classifyToolExecutionMode(call("read_file"), [tool({ isConcurrencySafe: () => true })])).toBe("parallel");
  });

  it("fails closed for mutation, checker failure, and Harness control tools", () => {
    expect(classifyToolExecutionMode(call("read_file"), [tool({ effectKind: "mutation", isConcurrencySafe: () => true })]))
      .toBe("exclusive");
    expect(classifyToolExecutionMode(call("read_file"), [tool({ effectKind: "unknown", isConcurrencySafe: () => true })]))
      .toBe("exclusive");
    expect(classifyToolExecutionMode(call("read_file"), [tool({ isConcurrencySafe: () => { throw new Error("bad classifier"); } })]))
      .toBe("exclusive");
    expect(classifyToolExecutionMode(call("update_todo"), [])).toBe("exclusive");
    expect(classifyToolExecutionMode(call("task"), [])).toBe("exclusive");
  });

  it("allows only the read_tool_result builtin to join the safe pool", () => {
    expect(classifyToolExecutionMode(call("read_tool_result"), [])).toBe("parallel");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("scheduleToolCalls", () => {
  it("exposes original call indexes while commits wait for the earliest result", async () => {
    const calls = [call("a"), call("b"), call("c")];
    const gates = calls.map(() => deferred<string>());
    const completed: number[] = [];
    const committed: number[] = [];

    const scheduled = scheduleToolCalls({
      calls,
      maxParallel: 3,
      classify: () => "parallel",
      execute: async (execution) => {
        const value = await gates[execution.toolCallIndex].promise;
        completed.push(execution.toolCallIndex);
        return value;
      },
      commit: async (execution) => {
        committed.push(execution.toolCallIndex);
        return "continue";
      },
      notExecuted: async () => "not-executed",
    });

    await Promise.resolve();
    gates[1].resolve("b");
    gates[2].resolve("c");
    await expect.poll(() => completed).toEqual([1, 2]);
    expect(committed).toEqual([]);
    gates[0].resolve("a");
    await scheduled;

    expect(committed).toEqual([0, 1, 2]);
  });

  it("keeps active safe calls within the configured rolling-pool limit", async () => {
    const calls = [call("a"), call("b"), call("c")];
    const gates = calls.map(() => deferred<string>());
    let active = 0;
    let maximumActive = 0;
    const started: string[] = [];
    const committed: string[] = [];

    const scheduled = scheduleToolCalls({
      calls,
      maxParallel: 2,
      classify: () => "parallel",
      execute: async (execution) => {
        const { call: toolCall, toolCallIndex: index } = execution;
        started.push(toolCall.name);
        active++;
        maximumActive = Math.max(maximumActive, active);
        const result = await gates[index].promise;
        active--;
        return result;
      },
      commit: async ({ call: toolCall }) => { committed.push(toolCall.name); return "continue"; },
      notExecuted: async () => "not-executed",
    });

    await Promise.resolve();
    expect(started).toEqual(["a", "b"]);
    gates[1].resolve("b");
    await expect.poll(() => started).toEqual(["a", "b", "c"]);
    gates[2].resolve("c");
    gates[0].resolve("a");
    await scheduled;

    expect(maximumActive).toBe(2);
    expect(committed).toEqual(["a", "b", "c"]);
  });

  it("drains a parallel group before it starts an exclusive barrier", async () => {
    const calls = [call("a"), call("b"), call("c")];
    const a = deferred<string>();
    const b = deferred<string>();
    const trace: string[] = [];

    const scheduled = scheduleToolCalls({
      calls,
      maxParallel: 2,
      classify: (toolCall) => toolCall.name === "c" ? "exclusive" : "parallel",
      execute: async ({ call: toolCall }) => {
        trace.push(`start:${toolCall.name}`);
        if (toolCall.name === "a") return a.promise;
        if (toolCall.name === "b") return b.promise;
        return "c";
      },
      commit: async () => "continue",
      notExecuted: async () => "not-executed",
    });

    await Promise.resolve();
    expect(trace).toEqual(["start:a", "start:b"]);
    b.resolve("b");
    await Promise.resolve();
    await Promise.resolve();
    expect(trace).toEqual(["start:a", "start:b"]);
    a.resolve("a");
    await scheduled;

    expect(trace).toEqual(["start:a", "start:b", "start:c"]);
  });

  it("does not dispatch calls after cancellation and records them as not executed", async () => {
    const controller = new AbortController();
    controller.abort();
    const executed: string[] = [];
    const skipped: string[] = [];

    const result = await scheduleToolCalls({
      calls: [call("a"), call("b")],
      maxParallel: 4,
      signal: controller.signal,
      classify: () => "parallel",
      execute: async ({ call: toolCall }) => { executed.push(toolCall.name); return toolCall.name; },
      commit: async () => "continue",
      notExecuted: async ({ call: toolCall }, reason) => {
        skipped.push(`${toolCall.name}:${reason}`);
        return reason;
      },
    });

    expect(result).toEqual({ cancelled: true, halted: false });
    expect(executed).toEqual([]);
    expect(skipped).toEqual(["a:aborted_before_dispatch", "b:aborted_before_dispatch"]);
  });
});
