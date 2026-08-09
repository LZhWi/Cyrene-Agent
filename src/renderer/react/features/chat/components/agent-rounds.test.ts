import { describe, expect, it } from "vitest";
import type { ToolExecutionRecord } from "../../../../../shared/chat-types";
import {
  applyAgentRoundBoundary,
  createRoundProcessMessage,
  finishAgentRound,
  resolveAgentRoundTitle,
  startAgentRound,
} from "./agent-rounds";

function tool(
  id: string,
  name: string,
  status: ToolExecutionRecord["status"] = "success",
): ToolExecutionRecord {
  return { id, name, status, roundId: "round-0" };
}

describe("agent round presentation", () => {
  it("keeps terminal error text attached to the interrupted active round", () => {
    expect(createRoundProcessMessage("error-1", "模型请求失败", 3, "round-2")).toEqual({
      id: "error-1",
      content: "模型请求失败",
      afterToolCount: 3,
      roundId: "round-2",
    });
  });

  it("tracks the active round from ordered start and end events", () => {
    const started = applyAgentRoundBoundary({ rounds: [], activeRoundId: undefined }, "start", "round-0", 100);
    expect(started).toEqual({
      rounds: [{ id: "round-0", status: "running", startedAt: 100 }],
      activeRoundId: "round-0",
    });

    expect(applyAgentRoundBoundary(started, "end", "round-0", 250)).toEqual({
      rounds: [{ id: "round-0", status: "completed", startedAt: 100, completedAt: 250 }],
      activeRoundId: undefined,
    });
  });

  it("starts and finishes a stable model round", () => {
    const started = startAgentRound([], "round-0", 100);
    expect(started).toEqual([{ id: "round-0", status: "running", startedAt: 100 }]);

    expect(finishAgentRound(started, "round-0", 250)).toEqual([
      { id: "round-0", status: "completed", startedAt: 100, completedAt: 250 },
    ]);
  });

  it("uses the currently running tool as the live title", () => {
    const round = startAgentRound([], "round-0", 100)[0];
    expect(resolveAgentRoundTitle(round, [
      tool("a", "list_dir", "success"),
      tool("b", "read_file", "running"),
    ])).toBe("昔涟正在读取文件");
  });

  it("summarizes only truthful successful tool facts and reports failures", () => {
    const round = finishAgentRound(startAgentRound([], "round-0", 100), "round-0", 250)[0];
    expect(resolveAgentRoundTitle(round, [
      ...Array.from({ length: 5 }, (_, index) => tool(`dir-${index}`, "list_dir")),
      tool("read-1", "read_file"),
      tool("read-2", "read_file"),
      tool("read-failed", "read_file", "error"),
    ])).toBe("昔涟已完成 · 浏览 5 个目录 · 读取 2 个文件 · 1 项失败");
  });

  it("falls back to an operation count for tools without a semantic summary", () => {
    const round = finishAgentRound(startAgentRound([], "round-0", 100), "round-0", 250)[0];
    expect(resolveAgentRoundTitle(round, [
      tool("a", "custom_a"),
      tool("b", "custom_b"),
    ])).toBe("昔涟已完成 · 完成 2 项操作");
  });

  it("keeps an interrupted round honest instead of claiming completion", () => {
    const round = startAgentRound([], "round-0", 100)[0];
    expect(resolveAgentRoundTitle(round, [tool("a", "read_file", "error")], true))
      .toBe("昔涟已中断 · 1 项失败");
  });
});
