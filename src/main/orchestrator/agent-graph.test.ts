import { describe, expect, it, vi } from "vitest";
import { runAgentGraph, type ActionDecision } from "./agent-graph";
import type { ToolCallResult } from "./types";

function succeeded(toolId: string): ToolCallResult {
  return { toolId, args: {}, output: JSON.stringify({ ok: true }), status: "succeeded", terminal: true, retryable: false };
}

function failed(toolId: string, retryable = false): ToolCallResult {
  return {
    toolId, args: {}, output: "fail", status: "failed",
    errorCode: "E_FAIL", terminal: true, retryable,
  };
}

function succeededNonTerminal(toolId: string): ToolCallResult {
  return { toolId, args: {}, output: JSON.stringify({ ok: true }), status: "succeeded", terminal: false, retryable: false };
}

describe("runAgentGraph", () => {
  it("routes a terminal act success directly to Soul without re-consulting decide", async () => {
    const decisions: ActionDecision[] = [
      { decision: "act", capability: "music.play_track", objective: "播放已选择歌曲", targetRefs: ["ctx_song_1"], afterSuccess: "respond" },
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

    // routeAfterTool 在工具成功后直接路由到 soul，decide 只调 1 次
    expect(decide).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("已处理");
    expect(result.toolResults).toHaveLength(1);
    expect(result.iterationCount).toBe(1);
  });

  it("collects an ask_user answer and re-enters decision routing without using Soul", async () => {
    const decisions: ActionDecision[] = [
      {
        decision: "ask_user",
        reason: "存在多个版本",
        missingFields: [{
          field: "version",
          reason: "歌曲版本不明确",
          required: true,
          typeHint: "single_select",
          candidateHints: ["Live 版", "录音室版"],
          allowCustom: true,
        }],
      },
      { decision: "respond", reason: "已获得用户选择" },
    ];
    const decide = vi.fn(async () => decisions.shift()!);
    const execute = vi.fn();
    const askUser = vi.fn(async () => ({
      requestId: "choice-1",
      answers: [{ field: "version", selectedValues: ["Live 版"] }],
    }));
    const respond = vi.fn(async (state) => {
      expect(state.clarificationAnswers).toEqual([{
        requestId: "choice-1",
        answers: [{ field: "version", selectedValues: ["Live 版"] }],
      }]);
      expect(state.messages.at(-1)).toEqual({ role: "user", content: "播放左转灯" });
      return "好的，按 Live 版继续。";
    });

    const result = await runAgentGraph({
      originalQuery: "播放左转灯",
      contextualizedQuery: "播放左转灯，但存在多个版本",
      citaContextBlock: "[CITA_CONTEXT]",
      messages: [{ role: "user", content: "播放左转灯" }],
      availableCapabilities: ["music.search", "music.play_track"],
    }, ({
      decide,
      execute,
      askUser,
      respond,
    } as Parameters<typeof runAgentGraph>[1]));

    expect(execute).not.toHaveBeenCalled();
    expect(askUser).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(result.reply).toBe("好的，按 Live 版继续。");
  });

  it("stops an endless act loop at the configured iteration limit", async () => {
    await expect(runAgentGraph({
      originalQuery: "继续尝试",
      contextualizedQuery: "继续尝试",
      citaContextBlock: "",
      messages: [{ role: "user", content: "继续尝试" }],
      availableCapabilities: ["music.play_track"],
    }, {
      decide: async () => ({ decision: "act", capability: "music.play_track", objective: "重试", targetRefs: [], afterSuccess: "replan" as const }),
      execute: async () => [succeeded("music_play_track")],
      respond: async () => "不会到这里",
      maxIterations: 2,
    })).rejects.toMatchObject({ code: "E_AGENT_GRAPH_ITERATION_LIMIT" });
  });

  it("uses its own iteration guard before LangGraph's recursion guard", async () => {
    await expect(runAgentGraph({
      originalQuery: "继续尝试",
      contextualizedQuery: "继续尝试",
      citaContextBlock: "",
      messages: [{ role: "user", content: "继续尝试" }],
      availableCapabilities: ["music.play_track"],
    }, {
      decide: async () => ({ decision: "act", capability: "music.play_track", objective: "重试", targetRefs: [], afterSuccess: "replan" as const }),
      execute: async () => [succeeded("music_play_track")],
      respond: async () => "不会到这里",
      maxIterations: 12,
    })).rejects.toMatchObject({ code: "E_AGENT_GRAPH_ITERATION_LIMIT" });
  });

  it("routes to Soul directly when a terminal act succeeds with afterSuccess=respond", async () => {
    const decide = vi.fn(async () => ({
      decision: "act" as const, capability: "music.play_track", objective: "播放",
      targetRefs: ["ctx_song_1"], afterSuccess: "respond" as const,
    }));
    const execute = vi.fn(async () => [succeeded("music_play_track")]);
    const respond = vi.fn(async () => "已发送播放请求。");

    const result = await runAgentGraph({
      originalQuery: "播放第四首",
      contextualizedQuery: "播放第四首",
      citaContextBlock: "",
      messages: [{ role: "user", content: "播放第四首" }],
      availableCapabilities: ["music.play_track"],
    }, { decide, execute, respond });

    // 单步任务：工具成功后 routeAfterTool 直接路由到 soul，decide 只调 1 次
    expect(decide).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("已发送播放请求。");
  });

  it("routes back to decide when afterSuccess=replan and the tool succeeded terminally", async () => {
    const decisions: ActionDecision[] = [
      { decision: "act", capability: "music.play_track", objective: "播放第一首", targetRefs: ["ctx_song_1"], afterSuccess: "replan" },
      { decision: "respond", reason: "完成" },
    ];
    const decide = vi.fn(async () => decisions.shift()!);
    const execute = vi.fn(async () => [succeeded("music_play_track")]);
    const respond = vi.fn(async () => "完成。");

    const result = await runAgentGraph({
      originalQuery: "播放第一首然后搜索",
      contextualizedQuery: "播放第一首然后搜索",
      citaContextBlock: "",
      messages: [{ role: "user", content: "播放第一首然后搜索" }],
      availableCapabilities: ["music.play_track"],
    }, { decide, execute, respond });

    // 多步任务：第一次 act+replan 成功后回 decide，第二次 decide 决定 respond
    expect(decide).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("完成。");
  });

  it("routes to Soul directly when a failed tool is not retryable", async () => {
    const decide = vi.fn(async () => ({
      decision: "act" as const, capability: "music.play_track", objective: "播放",
      targetRefs: ["ctx_song_1"], afterSuccess: "respond" as const,
    }));
    const execute = vi.fn(async () => [failed("music_play_track", false)]);
    const respond = vi.fn(async () => "播放失败，请稍后再试。");

    const result = await runAgentGraph({
      originalQuery: "播放第四首",
      contextualizedQuery: "播放第四首",
      citaContextBlock: "",
      messages: [{ role: "user", content: "播放第四首" }],
      availableCapabilities: ["music.play_track"],
    }, { decide, execute, respond });

    // 不可重试失败：直接进 soul，不回 decide
    expect(decide).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("播放失败，请稍后再试。");
  });

  it("routes back to decide when a failed tool is retryable", async () => {
    const decisions: ActionDecision[] = [
      { decision: "act", capability: "music.play_track", objective: "播放", targetRefs: ["ctx_song_1"], afterSuccess: "respond" },
      { decision: "respond", reason: "放弃重试" },
    ];
    const decide = vi.fn(async () => decisions.shift()!);
    const execute = vi.fn(async () => [failed("music_play_track", true)]);
    const respond = vi.fn(async () => "重试失败。");

    const result = await runAgentGraph({
      originalQuery: "播放第四首",
      contextualizedQuery: "播放第四首",
      citaContextBlock: "",
      messages: [{ role: "user", content: "播放第四首" }],
      availableCapabilities: ["music.play_track"],
    }, { decide, execute, respond });

    // 可重试失败：回 decide 让 LLM 决定重试还是放弃
    expect(decide).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("重试失败。");
  });

  it("routes back to decide when a succeeded tool is not terminal", async () => {
    const decisions: ActionDecision[] = [
      { decision: "act", capability: "music.play_track", objective: "开始监听", targetRefs: ["ctx_song_1"], afterSuccess: "respond" },
      { decision: "respond", reason: "完成" },
    ];
    const decide = vi.fn(async () => decisions.shift()!);
    const execute = vi.fn(async () => [succeededNonTerminal("music_play_track")]);
    const respond = vi.fn(async () => "完成。");

    const result = await runAgentGraph({
      originalQuery: "开始监听",
      contextualizedQuery: "开始监听",
      citaContextBlock: "",
      messages: [{ role: "user", content: "开始监听" }],
      availableCapabilities: ["music.play_track"],
    }, { decide, execute, respond });

    // terminal=false：回 decide，不直接进 soul
    expect(decide).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("完成。");
  });

  it("routes refresh_state failure to refresh, then back to decide for re-decision", async () => {
    const decisions: ActionDecision[] = [
      { decision: "failure", reason: "action_gate_failed", code: "TARGET_REF_INVALID", disposition: "refresh_state", toolExecuted: false },
      { decision: "respond", reason: "recovered" },
    ];
    const decide = vi.fn(async (state) => {
      // 第二次 decide 应该能看到上一次失败信息
      if (decide.mock.calls.length === 2) {
        expect(state.lastGateFailure).toEqual({ code: "TARGET_REF_INVALID", disposition: "refresh_state" });
      }
      return decisions.shift()!;
    });
    const execute = vi.fn();
    const respond = vi.fn(async () => "已恢复");

    const result = await runAgentGraph({
      originalQuery: "播放第三首",
      contextualizedQuery: "播放第三首",
      citaContextBlock: "",
      messages: [{ role: "user", content: "播放第三首" }],
      availableCapabilities: ["music.play_track"],
    }, { decide, execute, respond });

    expect(decide).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("已恢复");
    expect(result.refreshCount).toBe(1);
  });

  it("routes refresh_state to soul when refresh budget is exhausted", async () => {
    const decisions: ActionDecision[] = [
      { decision: "failure", reason: "action_gate_failed", code: "TARGET_REF_INVALID", disposition: "refresh_state", toolExecuted: false },
      { decision: "failure", reason: "action_gate_failed", code: "TARGET_REF_INVALID", disposition: "refresh_state", toolExecuted: false },
    ];
    const decide = vi.fn(async () => decisions.shift()!);
    const execute = vi.fn();
    const respond = vi.fn(async () => "失败");

    const result = await runAgentGraph({
      originalQuery: "播放第三首",
      contextualizedQuery: "播放第三首",
      citaContextBlock: "",
      messages: [{ role: "user", content: "播放第三首" }],
      availableCapabilities: ["music.play_track"],
    }, { decide, execute, respond, maxRefresh: 1 });

    // 第一次 failure -> refresh；第二次 failure -> refreshCount 已达上限 -> soul
    expect(decide).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe("失败");
    expect(result.refreshCount).toBe(1);
  });

  it("routes fail_closed directly to soul without refresh", async () => {
    const decide = vi.fn(async () => ({
      decision: "failure" as const,
      reason: "action_gate_failed" as const,
      code: "REPAIR_EXHAUSTED",
      disposition: "fail_closed" as const,
      toolExecuted: false as const,
    }));
    const execute = vi.fn();
    const respond = vi.fn(async () => "失败");

    const result = await runAgentGraph({
      originalQuery: "测试",
      contextualizedQuery: "测试",
      citaContextBlock: "",
      messages: [{ role: "user", content: "测试" }],
      availableCapabilities: ["music.play_track"],
    }, { decide, execute, respond });

    // fail_closed 不走 refresh，直接进 soul
    expect(decide).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(result.refreshCount).toBe(0);
  });
});
