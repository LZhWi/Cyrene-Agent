/**
 * Task 2 / C1 修订测试：harness-adapter 的终态映射 + 子事件 runId stamp。
 *
 * 覆盖 Issue 2（cancelled/error 不再被吞成 success）+ Issue 6（所有 AG-UI 事件附 canonical runId）。
 *
 * 这两个被测函数都是纯函数，直接单测，不需要 mock harness / vendor。
 */

import { describe, expect, it } from "vitest";
import { buildHarnessSystemPrompt, mapTerminateReasonToTerminal, sendHarnessEventAsAgui } from "./harness-adapter";
import type { HarnessEvent } from "./harness/types";
import type { BaseEvent } from "@ag-ui/core";

describe("Harness Todo working notebook policy", () => {
  it("places the soft Todo policy in every Harness system prompt", () => {
    const prompt = buildHarnessSystemPrompt({
      soulSystemBaseContent: "persona",
      toolSystemContent: "tools",
    } as never);

    expect(prompt).toContain("[TODO_WORKING_NOTEBOOK_POLICY]");
    expect(prompt).toContain("至少 2 个 execution step");
    expect(prompt).toContain("不得作为后续行动的强约束");
  });
});

describe("Harness recovery context", () => {
  it("injects interrupted Todo context as read-only evidence", () => {
    const prompt = buildHarnessSystemPrompt({
      soulSystemBaseContent: "persona",
      toolSystemContent: "tools",
      recoveryContext: "上次停在检查取消链路",
    } as never);

    expect(prompt).toContain("[RECOVERY_CONTEXT]");
    expect(prompt).toContain("上次停在检查取消链路");
  });
});

describe("mapTerminateReasonToTerminal (Issue 2 + 3)", () => {
  it("maps undefined → success with externalEffectsMayContinue=false", () => {
    expect(mapTerminateReasonToTerminal(undefined)).toStrictEqual({
      status: "success",
      externalEffectsMayContinue: false,
    });
  });

  // P1 修订：success + uncertainEffects 必须报告 true，不能谎报 false。
  it("maps undefined + hasUncertainEffects=true → success with externalEffectsMayContinue=true (P1)", () => {
    expect(mapTerminateReasonToTerminal(undefined, true)).toStrictEqual({
      status: "success",
      externalEffectsMayContinue: true,
    });
  });

  it("maps undefined + hasUncertainEffects=false → success with externalEffectsMayContinue=false (P1)", () => {
    expect(mapTerminateReasonToTerminal(undefined, false)).toStrictEqual({
      status: "success",
      externalEffectsMayContinue: false,
    });
  });

  // P1 修订：hasUncertainEffects 不影响 cancelled / timeout / runtime_error（恒为 true）。
  it("ignores hasUncertainEffects for cancelled/timeout/runtime_error (P1)", () => {
    expect(mapTerminateReasonToTerminal("cancelled", false)).toStrictEqual({
      status: "cancelled",
      reason: "user_cancelled",
      externalEffectsMayContinue: true,
    });
    expect(mapTerminateReasonToTerminal("timeout", false)).toStrictEqual({
      status: "timeout",
      reason: "timeout",
      externalEffectsMayContinue: true,
    });
    expect(mapTerminateReasonToTerminal("error", false)).toStrictEqual({
      status: "runtime_error",
      reason: "E_HARNESS_FAILURE",
      externalEffectsMayContinue: true,
    });
  });

  it("maps max_rounds → timeout with externalEffectsMayContinue=true", () => {
    expect(mapTerminateReasonToTerminal("max_rounds")).toStrictEqual({
      status: "timeout",
      reason: "max_rounds",
      externalEffectsMayContinue: true,
    });
  });

  it("maps timeout → timeout with externalEffectsMayContinue=true", () => {
    expect(mapTerminateReasonToTerminal("timeout")).toStrictEqual({
      status: "timeout",
      reason: "timeout",
      externalEffectsMayContinue: true,
    });
  });

  // Issue 2 核心不变量：cancelled 不再被 default 吞成 success
  it("maps cancelled → cancelled (NOT success) with externalEffectsMayContinue=true", () => {
    const terminal = mapTerminateReasonToTerminal("cancelled");
    expect(terminal.status).toBe("cancelled");
    expect(terminal.reason).toBe("user_cancelled");
    expect(terminal.externalEffectsMayContinue).toBe(true);
  });

  // Issue 2 核心不变量：error 不再被 default 吞成 success，而是 runtime_error
  it("maps error → runtime_error (NOT success) with externalEffectsMayContinue=true", () => {
    const terminal = mapTerminateReasonToTerminal("error");
    expect(terminal.status).toBe("runtime_error");
    expect(terminal.reason).toBe("E_HARNESS_FAILURE");
    expect(terminal.externalEffectsMayContinue).toBe(true);
  });

  it("never returns a terminal missing externalEffectsMayContinue (Issue 3 invariant)", () => {
    for (const reason of [undefined, "max_rounds", "timeout", "cancelled", "error"] as const) {
      const terminal = mapTerminateReasonToTerminal(reason);
      expect(typeof terminal.externalEffectsMayContinue).toBe("boolean");
    }
  });
});

describe("sendHarnessEventAsAgui runId stamping (Issue 6)", () => {
  const runId = "run-canonical-abc";
  const messageId = "msg-1";
  const threadId = "thread-1";

  function captureEvents(harnessEvent: HarnessEvent): BaseEvent[] {
    const sent: BaseEvent[] = [];
    sendHarnessEventAsAgui(harnessEvent, messageId, threadId, runId, (e) => sent.push(e));
    return sent;
  }

  it("routes progress_text to the process area instead of the formal answer bubble", () => {
    const events = captureEvents({ type: "progress_text", content: "正在处理" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "CUSTOM",
      name: "cyrene.process_text",
      value: { content: "正在处理" },
      runId,
    });
  });

  it("maps explicit model round boundaries to one ordered custom event stream", () => {
    expect(captureEvents({ type: "round_start", roundId: "round-3" })[0]).toMatchObject({
      type: "CUSTOM",
      name: "cyrene.round",
      value: { action: "start", roundId: "round-3" },
      runId,
    });
    expect(captureEvents({ type: "round_end", roundId: "round-3" })[0]).toMatchObject({
      type: "CUSTOM",
      name: "cyrene.round",
      value: { action: "end", roundId: "round-3" },
      runId,
    });
  });

  it("maps public model reasoning to AG-UI reasoning events", () => {
    const start = captureEvents({ type: "reasoning_start", messageId: "reason-1" });
    const delta = captureEvents({ type: "reasoning_delta", messageId: "reason-1", delta: "先检查" });
    const end = captureEvents({ type: "reasoning_end", messageId: "reason-1" });

    expect(start[0]).toMatchObject({ type: "REASONING_MESSAGE_START", messageId: "reason-1", runId });
    expect(delta[0]).toMatchObject({ type: "REASONING_MESSAGE_CONTENT", messageId: "reason-1", delta: "先检查", runId });
    expect(end[0]).toMatchObject({ type: "REASONING_MESSAGE_END", messageId: "reason-1", runId });
  });

  it("stamps runId on TOOL_CALL events (tool_start / tool_end)", () => {
    const startEvents = captureEvents({
      type: "tool_start",
      toolCallId: "tc-1",
      toolName: "apply_patch",
      args: { path: "src/main.ts" },
    });
    const endEvents = captureEvents({
      type: "tool_end",
      toolCallId: "tc-1",
      outcome: "success",
      preview: "done",
    });

    // 至少一个工具事件必须带 canonical runId（Issue 6 要求断言）
    const toolStart = startEvents[0] as BaseEvent & { runId?: string; toolCallId?: string };
    expect(toolStart).toBeDefined();
    expect(toolStart.runId).toBe(runId);
    expect(toolStart.toolCallId).toBe("tc-1");

    expect(startEvents[1]).toMatchObject({
      type: "TOOL_CALL_ARGS",
      toolCallId: "tc-1",
      delta: JSON.stringify({ path: "src/main.ts" }),
      runId,
    });

    const toolEnd = endEvents[0] as BaseEvent & { runId?: string; toolCallId?: string };
    expect(toolEnd.runId).toBe(runId);
    expect(toolEnd.toolCallId).toBe("tc-1");
  });

  it("emits a terminal TOOL_CALL_RESULT before TOOL_CALL_END", () => {
    const events = captureEvents({
      type: "tool_end",
      toolCallId: "tc-result",
      outcome: "success",
      preview: "saved file",
    }) as Array<BaseEvent & {
      type?: string;
      toolCallId?: string;
      content?: string;
      status?: string;
      runId?: string;
    }>;

    expect(events.map((event) => event.type)).toEqual(["TOOL_CALL_RESULT", "TOOL_CALL_END"]);
    expect(events[0]).toMatchObject({
      toolCallId: "tc-result",
      content: "saved file",
      status: "success",
      runId,
    });
  });

  it("marks every non-success harness outcome as a failed tool result", () => {
    for (const outcome of ["failure", "unknown", "not_executed"] as const) {
      const [result] = captureEvents({
        type: "tool_end",
        toolCallId: `tc-${outcome}`,
        outcome,
        preview: outcome,
      }) as Array<BaseEvent & { status?: string }>;
      expect(result.status).toBe("failed");
    }
  });

  it("stamps runId on CUSTOM todo events", () => {
    const events = captureEvents({
      type: "todo_update",
      items: [{ id: "t1", content: "task", status: "pending" }],
    });

    expect(events).toHaveLength(1);
    const custom = events[0] as BaseEvent & { runId?: string; name?: string };
    expect(custom.runId).toBe(runId);
    expect(custom.name).toBe("cyrene.todo");
  });

  it("stamps runId on final_answer TEXT_MESSAGE events", () => {
    const events = captureEvents({ type: "final_answer", content: "最终回复" });

    expect(events).toHaveLength(3);
    for (const event of events) {
      expect((event as { runId?: string }).runId).toBe(runId);
    }
  });
});
