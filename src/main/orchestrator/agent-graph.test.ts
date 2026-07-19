import { describe, expect, it, vi } from "vitest";
import { runAgentGraph, type ActionDecision } from "./agent-graph";
import type { ToolCallResult } from "./types";

function succeeded(toolId: string): ToolCallResult {
  return { toolId, args: {}, output: JSON.stringify({ ok: true }), status: "succeeded" };
}

describe("runAgentGraph", () => {
  it("routes act through the tool node and returns to decision before Soul", async () => {
    const decisions: ActionDecision[] = [
      { decision: "act", capability: "music.play_track", objective: "播放已选择歌曲", targetRefs: ["ctx_song_1"] },
      { decision: "respond", reason: "播放请求已经成功发送" },
    ];
    const decide = vi.fn(async () => decisions.shift()!);
    const execute = vi.fn(async () => [succeeded("music_play_track")]);
    const respond = vi.fn(async (state) => {
      expect(state.toolResults).toHaveLength(1);
      return "已处理";
    });

    const result = await runAgentGraph({
      originalQuery: "播放第一首",
      contextualizedQuery: "播放当前日推第一首",
      citaContextBlock: "[CITA_CONTEXT]",
      messages: [{ role: "user", content: "播放第一首" }],
      availableCapabilities: ["music.play_track"],
    }, { decide, execute, respond });

    expect(decide).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("已处理");
    expect(result.toolResults).toHaveLength(1);
    expect(result.iterationCount).toBe(1);
  });

  it("routes ask_user directly to Soul without executing a tool", async () => {
    const execute = vi.fn();

    const result = await runAgentGraph({
      originalQuery: "播放左转灯",
      contextualizedQuery: "播放左转灯，但存在多个版本",
      citaContextBlock: "[CITA_CONTEXT]",
      messages: [{ role: "user", content: "播放左转灯" }],
      availableCapabilities: ["music.search", "music.play_track"],
    }, {
      decide: async () => ({
        decision: "ask_user",
        reason: "存在多个版本",
        missingInformation: ["歌曲版本"],
      }),
      execute,
      respond: async () => "你想听哪个版本？",
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.reply).toBe("你想听哪个版本？");
  });

  it("stops an endless act loop at the configured iteration limit", async () => {
    await expect(runAgentGraph({
      originalQuery: "继续尝试",
      contextualizedQuery: "继续尝试",
      citaContextBlock: "",
      messages: [{ role: "user", content: "继续尝试" }],
      availableCapabilities: ["music.play_track"],
    }, {
      decide: async () => ({ decision: "act", capability: "music.play_track", objective: "重试", targetRefs: [] }),
      execute: async () => [succeeded("music_play_track")],
      respond: async () => "不会到这里",
      maxIterations: 2,
    })).rejects.toThrow("E_AGENT_GRAPH_ITERATION_LIMIT");
  });

  it("uses its own iteration guard before LangGraph's recursion guard", async () => {
    await expect(runAgentGraph({
      originalQuery: "继续尝试",
      contextualizedQuery: "继续尝试",
      citaContextBlock: "",
      messages: [{ role: "user", content: "继续尝试" }],
      availableCapabilities: ["music.play_track"],
    }, {
      decide: async () => ({ decision: "act", capability: "music.play_track", objective: "重试", targetRefs: [] }),
      execute: async () => [succeeded("music_play_track")],
      respond: async () => "不会到这里",
      maxIterations: 12,
    })).rejects.toThrow("E_AGENT_GRAPH_ITERATION_LIMIT");
  });
});
