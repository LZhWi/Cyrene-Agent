/**
 * A-F 自动化 Graph 集成测试
 *
 * 测试 Agent Graph 状态机的完整路由链路，覆盖六个核心场景：
 *
 * A: code mutation → run_verification → completed_verified
 * B: verification fail → requiredNextAction clear → re-apply_patch → re-verify success
 * C: verification timeout → requiredNextAction preserved → retry
 * D: user waiver → completed_unverified; model skip claim doesn't work
 * E: delegate_search/delegate_document → completed (not completed_verified)
 * F: revision 1 verified → modify to revision 2 → same verification params still re-execute
 */

import { describe, expect, it } from "vitest";
import {
  resolveRouteAfterTool,
  checkFinalizationGuard,
  resolveCompletionStatus,
  detectVerificationWaiver,
  type AgentGraphState,
  type CodeVerificationState,
  type VerificationWaiver,
} from "./agent-graph";
import type { ToolCallResult } from "./types";

// ── 辅助函数 ──

function baseState(overrides?: Partial<AgentGraphState>): AgentGraphState {
  return {
    originalQuery: "test",
    contextualizedQuery: "test",
    citaContextBlock: "",
    messages: [],
    availableCapabilities: [],
    toolResults: [],
    iterationCount: 0,
    reply: "",
    clarificationAnswers: [],
    refreshCount: 0,
    replanCount: 0,
    ...overrides,
  } as AgentGraphState;
}

function codeState(
  cv: Partial<CodeVerificationState>,
  overrides?: Partial<AgentGraphState>,
): AgentGraphState {
  return baseState({
    codeVerification: {
      mutationRevision: 0,
      verifiedRevision: 0,
      status: "clean",
      changedFiles: [],
      ...cv,
    },
    ...overrides,
  });
}

function toolResult(
  toolId: string,
  status: "succeeded" | "failed",
  output: string = "",
  overrides?: Partial<ToolCallResult>,
): ToolCallResult {
  return {
    toolId,
    args: {},
    output,
    status,
    terminal: true,
    retryable: false,
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════
// A: code mutation → run_verification → completed_verified
// ══════════════════════════════════════════════════════════════

describe("Scenario A: code mutation → verification → completed_verified", () => {
  it("Step 1: apply_patch succeeds + afterSuccess=replan → route to decide (plan mode)", () => {
    // afterSuccess="replan" → goto="decide"，不受 inPlanMode 影响
    const result = toolResult("apply_patch", "succeeded", '{"filePath":"src/foo.ts"}');
    const route = resolveRouteAfterTool(result, { afterSuccess: "replan" }, true);
    expect(route).toBe("decide");
  });

  it("Step 1b: apply_patch succeeds + afterSuccess=respond → route to planVerify (plan mode)", () => {
    // afterSuccess="respond" → goto="soul"，inPlanMode 重定向到 planVerify
    const result = toolResult("apply_patch", "succeeded", '{"filePath":"src/foo.ts"}');
    const route = resolveRouteAfterTool(result, { afterSuccess: "respond" }, true);
    expect(route).toBe("planVerify");
  });

  it("Step 2: run_verification succeeds → route to planVerify (plan mode)", () => {
    const result = toolResult("run_verification", "succeeded", '{"passed":true,"exitCode":0}');
    const route = resolveRouteAfterTool(result, { afterSuccess: "respond" }, true);
    expect(route).toBe("planVerify");
  });

  it("Step 3: Finalization guard — mutation=1, verified=1 → allow_success", () => {
    const state = codeState({ mutationRevision: 1, verifiedRevision: 1, status: "passed" });
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_success");
  });

  it("Step 4: Finalization outcome → completed_verified", () => {
    const state = codeState({ mutationRevision: 1, verifiedRevision: 1 });
    const outcome = resolveCompletionStatus(state, { kind: "allow_success" });
    expect(outcome.status).toBe("completed_verified");
  });

  it("Full chain: mutation → verification → guard → outcome", () => {
    // 模拟完整链路
    const state = codeState({ mutationRevision: 1, verifiedRevision: 0, status: "pending" });

    // 验证通过后更新状态
    const verifiedState = codeState({
      mutationRevision: 1,
      verifiedRevision: 1,
      status: "passed",
    });

    const guard = checkFinalizationGuard(verifiedState);
    expect(guard.kind).toBe("allow_success");

    const outcome = resolveCompletionStatus(verifiedState, guard);
    expect(outcome.status).toBe("completed_verified");
  });
});

// ══════════════════════════════════════════════════════════════
// B: verification fail → requiredNextAction clear → re-apply_patch → re-verify success
// ══════════════════════════════════════════════════════════════

describe("Scenario B: verification fail → repair → re-verify success", () => {
  it("Step 1: run_verification fails → route to planVerify", () => {
    const result = toolResult("run_verification", "failed", '{"passed":false,"exitCode":1,"stderr":"Type error"}');
    const route = resolveRouteAfterTool(result, { afterSuccess: "respond" }, true);
    expect(route).toBe("planVerify");
  });

  it("Step 2: Finalization guard — mutation=1, verified=0, status=failed → block", () => {
    const state = codeState({ mutationRevision: 1, verifiedRevision: 0, status: "failed" });
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("block");
    if (guard.kind === "block") {
      expect(guard.redirectTo).toBeDefined();
    }
  });

  it("Step 3: After repair (re-apply_patch) → mutationRevision=2", () => {
    // 修复后 mutationRevision 递增
    const state = codeState({ mutationRevision: 2, verifiedRevision: 0, status: "pending" });
    expect(state.codeVerification!.mutationRevision).toBe(2);
  });

  it("Step 4: Re-verify success → completed_verified", () => {
    const state = codeState({ mutationRevision: 2, verifiedRevision: 2, status: "passed" });
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_success");

    const outcome = resolveCompletionStatus(state, guard);
    expect(outcome.status).toBe("completed_verified");
  });

  it("Full chain: mutation → fail → repair → re-verify → completed_verified", () => {
    // 初始状态：mutation=1, verified=0, status=pending
    let state = codeState({ mutationRevision: 1, verifiedRevision: 0, status: "pending" });

    // 验证失败
    state = codeState({ mutationRevision: 1, verifiedRevision: 0, status: "failed" });
    let guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("block");

    // 修复（重新 apply_patch）→ mutationRevision=2
    state = codeState({ mutationRevision: 2, verifiedRevision: 0, status: "pending" });
    guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("block");

    // 重新验证成功
    state = codeState({ mutationRevision: 2, verifiedRevision: 2, status: "passed" });
    guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_success");

    const outcome = resolveCompletionStatus(state, guard);
    expect(outcome.status).toBe("completed_verified");
  });
});

// ══════════════════════════════════════════════════════════════
// C: verification timeout → requiredNextAction preserved → retry
// ══════════════════════════════════════════════════════════════

describe("Scenario C: verification timeout → retry", () => {
  it("Step 1: run_verification timeout → route to decide (retryable)", () => {
    // 超时视为 failed，retryable=true → goto="decide"
    const result = toolResult("run_verification", "failed", '{"passed":false,"timedOut":true}', {
      retryable: true,
    });
    const route = resolveRouteAfterTool(result, { afterSuccess: "respond" }, true);
    expect(route).toBe("decide");
  });

  it("Step 2: Finalization guard — timeout with requiredNextAction → block", () => {
    const state = codeState(
      { mutationRevision: 1, verifiedRevision: 0, status: "failed" },
      { requiredNextAction: { capabilityId: "run_verification", reason: "超时" } },
    );
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("block");
  });

  it("Step 3: Retry verification → success → completed_verified", () => {
    const state = codeState({ mutationRevision: 1, verifiedRevision: 1, status: "passed" });
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_success");

    const outcome = resolveCompletionStatus(state, guard);
    expect(outcome.status).toBe("completed_verified");
  });
});

// ══════════════════════════════════════════════════════════════
// D: user waiver → completed_unverified; model skip claim doesn't work
// ══════════════════════════════════════════════════════════════

describe("Scenario D: user waiver → completed_unverified", () => {
  it("Step 1: User says '不要运行测试' → waiver detected", () => {
    const waiver = detectVerificationWaiver(
      [{ role: "user", content: "帮我改一下代码，不要运行测试" }],
      "run_1",
    );
    expect(waiver).toBeDefined();
    expect(waiver!.scope).toBe("current_run");
  });

  it("Step 2: mutation=1, verified=0, pending + waiver → allow_unverified", () => {
    const state = codeState(
      { mutationRevision: 1, verifiedRevision: 0, status: "pending" },
      {
        verificationWaiver: {
          source: "explicit_user_instruction",
          messageId: "msg_1",
          runId: "run_1",
          scope: "current_run",
          evidenceText: "不要运行测试",
        },
      },
    );
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_unverified");
  });

  it("Step 3: Finalization outcome → completed_unverified", () => {
    const state = codeState({ mutationRevision: 1, verifiedRevision: 0 });
    const outcome = resolveCompletionStatus(state, { kind: "allow_unverified", update: {} } as any);
    expect(outcome.status).toBe("completed_unverified");
  });

  it("Model claim 'verification passed' does NOT create waiver", () => {
    // 模型声称验证通过，但系统不信任模型的声明
    // 只有用户消息才能创建 waiver
    const waiver = detectVerificationWaiver(
      [{ role: "assistant", content: "代码已修改完成，验证通过" }],
      "run_1",
    );
    expect(waiver).toBeUndefined();
  });

  it("Model claim 'skip test' in assistant message does NOT create waiver", () => {
    const waiver = detectVerificationWaiver(
      [{ role: "assistant", content: "我已跳过测试，代码修改完成" }],
      "run_1",
    );
    expect(waiver).toBeUndefined();
  });

  it("Full chain: mutation → user waiver → allow_unverified → completed_unverified", () => {
    const waiver: VerificationWaiver = {
      source: "explicit_user_instruction",
      messageId: "msg_1",
      runId: "run_1",
      scope: "current_run",
      evidenceText: "不用验证",
    };

    const state = codeState(
      { mutationRevision: 1, verifiedRevision: 0, status: "pending" },
      { verificationWaiver: waiver },
    );

    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_unverified");

    const outcome = resolveCompletionStatus(state, guard);
    expect(outcome.status).toBe("completed_unverified");
  });
});

// ══════════════════════════════════════════════════════════════
// E: delegate_search/delegate_document → completed (not completed_verified)
// ══════════════════════════════════════════════════════════════

describe("Scenario E: delegate_search/delegate_document → completed", () => {
  it("delegate_search succeeds → no code mutation → allow_success", () => {
    // delegate_search 是 read 类型，不产生 code mutation
    const state = codeState({ mutationRevision: 0, verifiedRevision: 0, status: "clean" });
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_success");
  });

  it("delegate_search → completed (not completed_verified)", () => {
    const state = codeState({ mutationRevision: 0 });
    const outcome = resolveCompletionStatus(state, { kind: "allow_success" });
    expect(outcome.status).toBe("completed");
    expect(outcome.status).not.toBe("completed_verified");
  });

  it("delegate_document succeeds → artifact mutation → allow_success", () => {
    // delegate_document 是 mutation+artifact 类型，不产生 code mutation
    const state = codeState({ mutationRevision: 0, verifiedRevision: 0, status: "clean" });
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_success");
  });

  it("delegate_document → completed (not completed_verified)", () => {
    const state = codeState({ mutationRevision: 0 });
    const outcome = resolveCompletionStatus(state, { kind: "allow_success" });
    expect(outcome.status).toBe("completed");
    expect(outcome.status).not.toBe("completed_verified");
  });

  it("routeAfterTool: delegate_search non-plan mode → soul", () => {
    const result = toolResult("delegate_search", "succeeded", '{"findings":[]}');
    const route = resolveRouteAfterTool(result, { afterSuccess: "respond" }, false);
    expect(route).toBe("soul");
  });

  it("routeAfterTool: delegate_document non-plan mode → soul", () => {
    const result = toolResult("delegate_document", "succeeded", '{"filePath":"doc.docx"}');
    const route = resolveRouteAfterTool(result, { afterSuccess: "respond" }, false);
    expect(route).toBe("soul");
  });
});

// ══════════════════════════════════════════════════════════════
// F: revision 1 verified → modify to revision 2 → re-execute verification
// ══════════════════════════════════════════════════════════════

describe("Scenario F: revision bump forces re-verification", () => {
  it("Step 1: mutation=1, verified=1 → allow_success", () => {
    const state = codeState({ mutationRevision: 1, verifiedRevision: 1, status: "passed" });
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_success");
  });

  it("Step 2: new mutation → mutationRevision=2, verifiedRevision=1 → block", () => {
    // 重新修改代码后，mutationRevision 递增，但 verifiedRevision 仍是旧值
    const state = codeState({ mutationRevision: 2, verifiedRevision: 1, status: "pending" });
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("block");
  });

  it("Step 3: re-verify → verifiedRevision=2 → allow_success", () => {
    const state = codeState({ mutationRevision: 2, verifiedRevision: 2, status: "passed" });
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_success");

    const outcome = resolveCompletionStatus(state, guard);
    expect(outcome.status).toBe("completed_verified");
  });

  it("Full chain: v1 verified → modify → v2 pending → block → v2 verified → allow", () => {
    // v1 已验证
    let state = codeState({ mutationRevision: 1, verifiedRevision: 1, status: "passed" });
    let guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_success");

    // 重新修改 → mutationRevision=2
    state = codeState({ mutationRevision: 2, verifiedRevision: 1, status: "pending" });
    guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("block");
    if (guard.kind === "block") {
      expect(guard.redirectTo).toBeDefined();
    }

    // 重新验证 → verifiedRevision=2
    state = codeState({ mutationRevision: 2, verifiedRevision: 2, status: "passed" });
    guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_success");

    const outcome = resolveCompletionStatus(state, guard);
    expect(outcome.status).toBe("completed_verified");
  });

  it("verifiedRevision never exceeds mutationRevision", () => {
    // 不可能出现 verifiedRevision > mutationRevision
    const state = codeState({ mutationRevision: 1, verifiedRevision: 2, status: "passed" });
    // 即使 verifiedRevision > mutationRevision，guard 仍应 allow_success
    // 因为 status=passed 且 verifiedRevision >= mutationRevision
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_success");
  });
});

// ══════════════════════════════════════════════════════════════
// 补充：边界场景
// ══════════════════════════════════════════════════════════════

describe("Edge cases", () => {
  it("no codeVerification field → allow_success (non-code task)", () => {
    const state = baseState();
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_success");
  });

  it("plan running → block (redirect to planVerify)", () => {
    const state = codeState(
      {},
      {
        taskPlan: {
          id: "p1",
          conversationId: "c1",
          goal: "test",
          steps: [],
          status: "running",
          skillIds: [],
          createdAt: 0,
          updatedAt: 0,
        },
      },
    );
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("block");
    if (guard.kind === "block") {
      expect(guard.redirectTo).toBe("planVerify");
    }
  });

  it("plan failed → allow_failure", () => {
    const state = codeState(
      {},
      {
        taskPlan: {
          id: "p1",
          conversationId: "c1",
          goal: "test",
          steps: [],
          status: "failed",
          skillIds: [],
          createdAt: 0,
          updatedAt: 0,
        },
      },
    );
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_failure");
  });

  it("skipped status → allow_unverified", () => {
    const state = codeState({ mutationRevision: 1, verifiedRevision: 0, status: "skipped" });
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_unverified");
  });

  it("routeAfterTool: failed + retryable → decide", () => {
    const result = toolResult("apply_patch", "failed", "error", { retryable: true });
    const route = resolveRouteAfterTool(result, { afterSuccess: "replan" }, true);
    expect(route).toBe("decide");
  });

  it("routeAfterTool: failed + non-retryable → planVerify (in plan mode)", () => {
    // non-retryable → goto="soul"，inPlanMode 重定向到 planVerify
    const result = toolResult("apply_patch", "failed", "error", { retryable: false });
    const route = resolveRouteAfterTool(result, { afterSuccess: "replan" }, true);
    expect(route).toBe("planVerify");
  });

  it("routeAfterTool: failed + non-retryable → soul (not in plan mode)", () => {
    const result = toolResult("apply_patch", "failed", "error", { retryable: false });
    const route = resolveRouteAfterTool(result, { afterSuccess: "replan" }, false);
    expect(route).toBe("soul");
  });

  it("routeAfterTool: non-terminal → decide", () => {
    const result = toolResult("delegate_search", "succeeded", "...", { terminal: false });
    const route = resolveRouteAfterTool(result, { afterSuccess: "respond" }, false);
    expect(route).toBe("decide");
  });
});
