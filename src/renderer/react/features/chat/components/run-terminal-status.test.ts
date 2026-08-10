/**
 * Task 3 / C2 失败测试：renderer 侧 RUN_FINISHED 终态分类。
 *
 * 验收不变量（plan §Task 3 Renderer 行为修订）：
 * - success → runStage.kind = "completed"
 * - cancelled → runStage.kind = "cancelled"，保留已有部分输出，不生成"任务已完成"
 * - timeout → runStage.kind = "timeout"，不伪装成功
 * - runtime_error → runStage.kind = "failed"（走 RUN_ERROR，但防御性处理）
 * - 缺失 result.status → 默认 "completed"（向后兼容）
 *
 * ChatPage.tsx 当前把所有 RUN_FINISHED 当 completed，这些测试应当失败。
 */

import { describe, expect, it } from "vitest";
import { resolveRunFinishedStage, resolveTerminalContent } from "./run-presentation";

describe("resolveRunFinishedStage (Task 3 renderer)", () => {
  it("maps success → completed", () => {
    expect(resolveRunFinishedStage({ status: "success" })).toEqual({ kind: "completed" });
  });

  it("maps cancelled → cancelled (NOT completed)", () => {
    const stage = resolveRunFinishedStage({ status: "cancelled" });
    expect(stage.kind).toBe("cancelled");
    expect(stage.kind).not.toBe("completed");
  });

  it("maps timeout → timeout (NOT completed)", () => {
    const stage = resolveRunFinishedStage({ status: "timeout" });
    expect(stage.kind).toBe("timeout");
    expect(stage.kind).not.toBe("completed");
  });

  it("maps runtime_error → failed (defensive; normally goes through RUN_ERROR)", () => {
    const stage = resolveRunFinishedStage({ status: "runtime_error" });
    expect(stage.kind).toBe("failed");
  });

  it("defaults to completed when result.status is missing (backward compat)", () => {
    expect(resolveRunFinishedStage(undefined)).toEqual({ kind: "completed" });
    expect(resolveRunFinishedStage({})).toEqual({ kind: "completed" });
  });
});

describe("resolveTerminalContent (Task 3 renderer)", () => {
  it("returns existing streamContent for success when non-empty", () => {
    expect(resolveTerminalContent("部分回复", "success")).toBe("部分回复");
  });

  it("defaults to '任务已完成。' for success when streamContent is empty", () => {
    expect(resolveTerminalContent("", "success")).toBe("任务已完成。");
    expect(resolveTerminalContent("   ", "success")).toBe("任务已完成。");
  });

  it("preserves partial streamContent for cancelled (no '任务已完成。' fallback)", () => {
    expect(resolveTerminalContent("部分回复", "cancelled")).toBe("部分回复");
  });

  it("returns empty string for cancelled when no partial content (NOT '任务已完成。')", () => {
    expect(resolveTerminalContent("", "cancelled")).toBe("");
    expect(resolveTerminalContent("   ", "cancelled")).toBe("");
  });

  it("preserves partial streamContent for timeout", () => {
    expect(resolveTerminalContent("部分回复", "timeout")).toBe("部分回复");
  });

  it("returns empty string for timeout when no partial content (NOT '任务已完成。')", () => {
    expect(resolveTerminalContent("", "timeout")).toBe("");
    expect(resolveTerminalContent("   ", "timeout")).toBe("");
  });
});
