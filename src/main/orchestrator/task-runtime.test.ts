import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskSessionStore } from "../tasks/task-session-store";
import { createTaskExecutor } from "./task-runtime";
import type { ToolDefinition } from "./tool-registry";

const roots: string[] = [];

function createStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-task-runtime-"));
  roots.push(root);
  return new TaskSessionStore(root, {
    createId: () => "task-1",
    createChildRunId: () => "child-run-1",
  });
}

function tool(id: string): ToolDefinition {
  return { id, name: id, description: id, enabled: true, inputSchema: { type: "object", properties: {} }, execute: async () => "ok" };
}

const parent = {
  parentConversationId: "conversation-1",
  parentRunId: "parent-run-1",
  mode: "code" as const,
  systemPrompt: "parent persona must not be copied",
  vendorConfig: { provider: "fake", model: "fake" } as never,
  tools: [tool("read_file"), tool("task"), tool("ask_user")],
  resolvedWorkspaceRoot: "E:\\project",
  checkPermission: vi.fn(async () => true),
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("TaskRuntime", () => {
  it("creates an isolated child Harness run and persists its final result", async () => {
    const store = createStore();
    const runHarness = vi.fn(async (input: any) => ({
      finalAnswer: "检查完成。",
      finalState: { todoItems: [], uncertainEffects: [] },
      terminated: false,
      rounds: 1,
      terminal: { status: "success" as const, externalEffectsMayContinue: false },
    }));
    const execute = createTaskExecutor({ parent, store, runHarness });

    const result = await execute({
      description: "检查取消链路",
      prompt: "检查取消传播并报告证据。",
      subagentType: "general",
    });

    expect(result).toEqual({ taskId: "task-1", status: "completed", text: "检查完成。" });
    expect(runHarness).toHaveBeenCalledWith(expect.objectContaining({
      messages: [{ role: "user", content: "检查取消传播并报告证据。" }],
      tools: [expect.objectContaining({ id: "read_file" })],
      toolContext: expect.objectContaining({
        runId: "child-run-1",
        resolvedWorkspaceRoot: "E:\\project",
      }),
    }));
    expect(store.get("task-1")).toMatchObject({ status: "completed", resultText: "检查完成。" });
  });

  it("rejects a resume request whose task belongs to another parent conversation", async () => {
    const store = createStore();
    const foreign = store.create({
      parentConversationId: "other-conversation",
      parentRunId: "other-run",
      description: "已有任务",
      prompt: "先前内容",
      subagentType: "general",
      mode: "code",
    });
    const execute = createTaskExecutor({ parent, store, runHarness: vi.fn() as never });

    await expect(execute({
      description: "继续已有任务",
      prompt: "继续。",
      subagentType: "general",
      taskId: foreign.id,
    })).rejects.toThrow("TASK_PARENT_MISMATCH");
  });

  it("restores the private Todo notebook when resuming the same task", async () => {
    const store = createStore();
    const task = store.create({
      parentConversationId: "conversation-1",
      parentRunId: "parent-run-0",
      description: "检查取消链路",
      prompt: "检查取消传播。",
      subagentType: "general",
      mode: "code",
      resolvedWorkspaceRoot: "E:\\project",
    });
    store.checkpoint(task.id, {
      status: "completed",
      todoItems: [{ id: "inspect", content: "检查取消链路", status: "in_progress" }],
    });
    const runHarness = vi.fn(async () => ({
      finalAnswer: "继续完成。",
      finalState: { todoItems: [], uncertainEffects: [] },
      terminated: false,
      rounds: 1,
      terminal: { status: "success" as const, externalEffectsMayContinue: false },
    }));
    const execute = createTaskExecutor({ parent, store, runHarness });

    await execute({
      description: "继续检查取消链路",
      prompt: "继续。",
      subagentType: "general",
      taskId: task.id,
    });

    expect(runHarness).toHaveBeenCalledWith(expect.objectContaining({
      initialState: {
        todoItems: [{ id: "inspect", content: "检查取消链路", status: "in_progress" }],
        uncertainEffects: [],
      },
    }));
  });

  it("persists the final Todo notebook even when no intermediate checkpoint arrives", async () => {
    const store = createStore();
    const runHarness = vi.fn(async () => ({
      finalAnswer: "检查完成。",
      finalState: {
        todoItems: [{ id: "report", content: "整理检查结果", status: "completed" as const }],
        uncertainEffects: [],
      },
      terminated: false,
      rounds: 1,
      terminal: { status: "success" as const, externalEffectsMayContinue: false },
    }));
    const execute = createTaskExecutor({ parent, store, runHarness });

    const result = await execute({
      description: "检查取消链路",
      prompt: "检查取消传播并报告证据。",
      subagentType: "general",
    });

    expect(store.get(result.taskId)?.todoItems).toEqual([
      { id: "report", content: "整理检查结果", status: "completed" },
    ]);
  });
});
