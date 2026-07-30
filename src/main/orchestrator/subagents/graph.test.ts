import { describe, expect, it, vi, beforeEach } from "vitest";
import { toolRegistry } from "../tool-registry";
import { runSubAgentGraph } from "./graph";
import type {
  SubAgentRunContext,
  SubAgentProfileConfig,
  SubAgentDecision,
  SubAgentPlan,
  SubAgentPublicResultV1,
} from "./types";
import type { PlanStep, StepVerificationResult } from "../task-plan";
import { generatePlanId, generateStepId } from "../task-plan";

function testCtx(overrides?: Partial<SubAgentRunContext>): SubAgentRunContext {
  return { profile: "document", taskId: `test-${Date.now()}`, args: {}, parentContext: { runId: "test-run" }, ...overrides };
}

function mockProfile(config: {
  decisions: SubAgentDecision[];
  verifyResults: StepVerificationResult[];
  steps: PlanStep[];
  allowedTools?: Set<string>;
  budget?: { maxSteps: number; maxToolCalls: number; timeoutMs: number; maxReplans: number };
}): SubAgentProfileConfig {
  let decideCount = 0;
  const decisions = config.decisions;
  const verifyResults = config.verifyResults;

  return {
    id: "document",
    allowedTools: config.allowedTools ?? new Set(["mock_tool"]),
    budget: config.budget ?? { maxSteps: 5, maxToolCalls: 10, timeoutMs: 60_000, maxReplans: 2 },
    createInitialPlan: (): SubAgentPlan => ({
      id: generatePlanId(), goal: "test", steps: config.steps.map(s => ({ ...s })),
      status: "running", createdAt: Date.now(), updatedAt: Date.now(),
    }),
    decide: (): SubAgentDecision => {
      const idx = Math.min(decideCount, decisions.length - 1);
      decideCount++;
      return decisions[idx];
    },
    verifyStep: (state): StepVerificationResult => {
      const idx = Math.min(state.iterationCount - 1, verifyResults.length - 1);
      return verifyResults[idx] ?? { status: "running" };
    },
    buildResult: (state): SubAgentPublicResultV1 => ({
      kind: "subagent_result", version: 1, taskId: state.ctx.taskId, profile: "document",
      status: state.plan.status === "failed" ? "failed" : "succeeded",
      summary: "test", findings: [], artifacts: [], completionEvidence: [],
    }),
    hasValidResults: (state): boolean => {
      return state.toolResults.some(r => r.status === "succeeded" && r.output.length > 0);
    },
    extractProgressEvidence: (state): string => {
      // 基于唯一输出内容和完成步骤数判断进展，不使用 toolCallsUsed（每次都变）
      const uniqueOutputs = new Set(state.toolResults.map(r => r.output)).size;
      const completedSteps = state.plan.steps.filter(s => s.status === "completed").length;
      return JSON.stringify({ uniqueOutputs, completedSteps });
    },
  };
}

function ensureMockTool(id = "mock_tool", execute?: (args: Record<string, unknown>) => Promise<string>) {
  toolRegistry.register({
    id, name: "Mock", description: "test", enabled: true,
    inputSchema: { type: "object", properties: {} },
    execute: execute ?? (async () => "mock output"),
  });
}

beforeEach(() => { vi.clearAllMocks(); ensureMockTool(); });

// ── 1. skip 语义 ──

describe("skip semantics", () => {
  it("skip + verify=completed -> step completed", async () => {
    const steps = [{ id: "s1", objective: "skip-step", status: "pending" as const, completionPolicy: {}, toolCallCount: 0, retryCount: 0 }];
    const profile = mockProfile({
      decisions: [{ action: "skip" as const }],
      verifyResults: [{ status: "completed" as const }],
      steps,
    });
    const outcome = await runSubAgentGraph(testCtx(), profile);
    expect(outcome.invocationStatus).toBe("completed");
    expect(outcome.result!.status).toBe("succeeded");
  });

  it("skip + verify=failed (no replan budget) -> failed", async () => {
    const steps = [{ id: "s1", objective: "skip-step", status: "pending" as const, completionPolicy: {}, toolCallCount: 0, retryCount: 0 }];
    const profile = mockProfile({
      decisions: [{ action: "skip" as const }],
      verifyResults: [{ status: "failed" as const, failureReason: "verification failed" }],
      steps,
      budget: { maxSteps: 5, maxToolCalls: 10, timeoutMs: 60_000, maxReplans: 0 },
    });
    const outcome = await runSubAgentGraph(testCtx(), profile);
    expect(outcome.invocationStatus).toBe("completed");
    expect(outcome.result!.status).toBe("failed");
  });

  it("skip does not increment toolCallsUsed", async () => {
    let captured = -1;
    const steps = [{ id: "s1", objective: "skip-step", status: "pending" as const, completionPolicy: {}, toolCallCount: 0, retryCount: 0 }];
    const profile = mockProfile({
      decisions: [{ action: "skip" as const }],
      verifyResults: [{ status: "completed" as const }],
      steps,
    });
    const orig = profile.buildResult;
    profile.buildResult = (state) => { captured = state.budgetUsage.toolCallsUsed; return orig(state); };
    await runSubAgentGraph(testCtx(), profile);
    expect(captured).toBe(0);
  });
});

// ── 2. 无进展检测 ──

describe("no-progress detection", () => {
  it("same call + same result -> replan (step failed) -> no more steps -> plan failed with NO_PROGRESS", async () => {
    // 单步，两轮相同调用，replan 后无 pending 步骤 -> plan failed
    const steps = [{ id: "s1", objective: "search", status: "pending" as const, completionPolicy: {}, toolCallCount: 0, retryCount: 0 }];
    const profile = mockProfile({
      decisions: [
        { action: "call_tool" as const, toolId: "mock_tool", args: { q: "test" } },
        { action: "call_tool" as const, toolId: "mock_tool", args: { q: "test" } },
      ],
      verifyResults: [{ status: "running" as const }, { status: "running" as const }],
      steps,
      budget: { maxSteps: 10, maxToolCalls: 20, timeoutMs: 60_000, maxReplans: 2 },
    });
    const outcome = await runSubAgentGraph(testCtx(), profile);
    // replan 后无 pending 步骤 -> plan failed
    expect(outcome.result!.status).toBe("failed");
  });

  it("same call + different result -> not no-progress", async () => {
    let calls = 0;
    ensureMockTool("mock_tool", async () => { calls++; return calls === 1 ? "result-A" : "result-B"; });

    const steps = [{ id: "s1", objective: "search", status: "pending" as const, completionPolicy: {}, toolCallCount: 0, retryCount: 0 }];
    const profile = mockProfile({
      decisions: [
        { action: "call_tool" as const, toolId: "mock_tool", args: { q: "test" } },
        { action: "call_tool" as const, toolId: "mock_tool", args: { q: "test" } },
      ],
      verifyResults: [{ status: "running" as const }, { status: "completed" as const }],
      steps,
      budget: { maxSteps: 10, maxToolCalls: 20, timeoutMs: 60_000, maxReplans: 2 },
    });
    const outcome = await runSubAgentGraph(testCtx(), profile);
    expect(outcome.result!.status).toBe("succeeded");
    expect(outcome.result!.error?.code).not.toBe("SUBAGENT_NO_PROGRESS");
  });

  it("different stepId -> not same loop", async () => {
    const steps = [
      { id: "s1", objective: "step1", status: "pending" as const, completionPolicy: {}, toolCallCount: 0, retryCount: 0 },
      { id: "s2", objective: "step2", status: "pending" as const, completionPolicy: {}, toolCallCount: 0, retryCount: 0 },
    ];
    const profile = mockProfile({
      decisions: [
        { action: "call_tool" as const, toolId: "mock_tool", args: { q: "test" } },
        { action: "call_tool" as const, toolId: "mock_tool", args: { q: "test" } },
      ],
      verifyResults: [{ status: "completed" as const }, { status: "completed" as const }],
      steps,
      budget: { maxSteps: 10, maxToolCalls: 20, timeoutMs: 60_000, maxReplans: 2 },
    });
    const outcome = await runSubAgentGraph(testCtx(), profile);
    // 不同步骤的相同调用不应被误判
    expect(outcome.result!.status).toBe("succeeded");
  });
});

// ── 3. 预算语义 ──

describe("budget semantics", () => {
  it("toolCallsUsed only increments on real execute (not skip)", async () => {
    let captured = -1;
    const steps = [{ id: "s1", objective: "skip", status: "pending" as const, completionPolicy: {}, toolCallCount: 0, retryCount: 0 }];
    const profile = mockProfile({
      decisions: [{ action: "skip" as const }],
      verifyResults: [{ status: "completed" as const }],
      steps,
    });
    const orig = profile.buildResult;
    profile.buildResult = (state) => { captured = state.budgetUsage.toolCallsUsed; return orig(state); };
    await runSubAgentGraph(testCtx(), profile);
    expect(captured).toBe(0);
  });

  it("maxToolCalls reached -> budget outcome (partial)", async () => {
    let calls = 0;
    ensureMockTool("mock_tool", async () => { calls++; return `output-${calls}`; });

    // 多步骤、不同 args 避免 no-progress，确保预算守卫触发
    const steps = [
      { id: "s1", objective: "step1", status: "pending" as const, completionPolicy: {}, toolCallCount: 0, retryCount: 0 },
      { id: "s2", objective: "step2", status: "pending" as const, completionPolicy: {}, toolCallCount: 0, retryCount: 0 },
      { id: "s3", objective: "step3", status: "pending" as const, completionPolicy: {}, toolCallCount: 0, retryCount: 0 },
      { id: "s4", objective: "step4", status: "pending" as const, completionPolicy: {}, toolCallCount: 0, retryCount: 0 },
    ];
    const profile = mockProfile({
      decisions: [
        { action: "call_tool" as const, toolId: "mock_tool", args: { step: 1 } },
        { action: "call_tool" as const, toolId: "mock_tool", args: { step: 2 } },
        { action: "call_tool" as const, toolId: "mock_tool", args: { step: 3 } },
        { action: "call_tool" as const, toolId: "mock_tool", args: { step: 4 } },
      ],
      verifyResults: [
        { status: "completed" as const },
        { status: "completed" as const },
        { status: "completed" as const },
        { status: "completed" as const },
      ],
      steps,
      budget: { maxSteps: 10, maxToolCalls: 3, timeoutMs: 60_000, maxReplans: 2 },
    });
    const outcome = await runSubAgentGraph(testCtx(), profile);
    // 3 tool calls used, then guard triggers on 4th iteration
    expect(outcome.result?.status).toBe("partial");
  });

  it("maxReplans reached -> finalize as failed", async () => {
    const steps = [{ id: "s1", objective: "fail-step", status: "pending" as const, completionPolicy: {}, toolCallCount: 0, retryCount: 0 }];
    const profile = mockProfile({
      decisions: [{ action: "skip" as const }],
      verifyResults: [{ status: "failed" as const, failureReason: "always fail" }],
      steps,
      budget: { maxSteps: 5, maxToolCalls: 10, timeoutMs: 60_000, maxReplans: 0 },
    });
    const outcome = await runSubAgentGraph(testCtx(), profile);
    expect(outcome.result!.status).toBe("failed");
  });

  it("budget exhaustion (iteration limit) with no results -> error only", async () => {
    // 单步、skip、running、maxSteps=1 → iteration limit 1*3=3
    const steps = [{ id: "s1", objective: "loop", status: "pending" as const, completionPolicy: {}, toolCallCount: 0, retryCount: 0 }];
    const profile = mockProfile({
      decisions: [{ action: "skip" as const }],
      verifyResults: [{ status: "running" as const }],
      steps,
      budget: { maxSteps: 1, maxToolCalls: 10, timeoutMs: 60_000, maxReplans: 0 },
    });
    const outcome = await runSubAgentGraph(testCtx(), profile);
    // 无工具结果、无完成步骤 -> error
    expect(outcome.invocationStatus).toBe("completed");
    expect(outcome.error?.code).toBe("SUBAGENT_BUDGET_EXHAUSTED_NO_RESULT");
  });

  it("budget exhaustion with results -> partial with SUBAGENT_BUDGET_EXHAUSTED", async () => {
    let calls = 0;
    ensureMockTool("mock_tool", async () => { calls++; return `output-${calls}`; });

    // 多步骤、不同 args，确保预算守卫触发
    const steps = [
      { id: "s1", objective: "step1", status: "pending" as const, completionPolicy: {}, toolCallCount: 0, retryCount: 0 },
      { id: "s2", objective: "step2", status: "pending" as const, completionPolicy: {}, toolCallCount: 0, retryCount: 0 },
      { id: "s3", objective: "step3", status: "pending" as const, completionPolicy: {}, toolCallCount: 0, retryCount: 0 },
      { id: "s4", objective: "step4", status: "pending" as const, completionPolicy: {}, toolCallCount: 0, retryCount: 0 },
    ];
    const profile = mockProfile({
      decisions: [
        { action: "call_tool" as const, toolId: "mock_tool", args: { step: 1 } },
        { action: "call_tool" as const, toolId: "mock_tool", args: { step: 2 } },
        { action: "call_tool" as const, toolId: "mock_tool", args: { step: 3 } },
        { action: "call_tool" as const, toolId: "mock_tool", args: { step: 4 } },
      ],
      verifyResults: [
        { status: "completed" as const },
        { status: "completed" as const },
        { status: "completed" as const },
        { status: "completed" as const },
      ],
      steps,
      budget: { maxSteps: 10, maxToolCalls: 3, timeoutMs: 60_000, maxReplans: 2 },
    });
    const outcome = await runSubAgentGraph(testCtx(), profile);
    // 3 tool calls used, then guard triggers on 4th iteration
    expect(outcome.result?.status).toBe("partial");
    expect(outcome.result?.error?.code).toBe("SUBAGENT_BUDGET_EXHAUSTED");
  });

  it("failed plan with results -> failed (not overridden to partial)", async () => {
    let calls = 0;
    ensureMockTool("mock_tool", async () => { calls++; return `output-${calls}`; });

    const steps = [
      { id: "s1", objective: "step1", status: "pending" as const, completionPolicy: {}, toolCallCount: 0, retryCount: 0 },
      { id: "s2", objective: "step2", status: "pending" as const, completionPolicy: {}, toolCallCount: 0, retryCount: 0 },
    ];
    const profile = mockProfile({
      decisions: [
        { action: "call_tool" as const, toolId: "mock_tool", args: { step: 1 } },
        { action: "skip" as const },
      ],
      verifyResults: [
        { status: "completed" as const },
        { status: "failed" as const, failureReason: "verification failed" },
      ],
      steps,
      budget: { maxSteps: 5, maxToolCalls: 10, timeoutMs: 60_000, maxReplans: 0 },
    });
    const outcome = await runSubAgentGraph(testCtx(), profile);
    // plan failed, but has results -> should be failed (not partial)
    expect(outcome.result!.status).toBe("failed");
  });

  it("failed plan with no results -> failed", async () => {
    const steps = [
      { id: "s1", objective: "step1", status: "pending" as const, completionPolicy: {}, toolCallCount: 0, retryCount: 0 },
    ];
    const profile = mockProfile({
      decisions: [{ action: "skip" as const }],
      verifyResults: [{ status: "failed" as const, failureReason: "verification failed" }],
      steps,
      budget: { maxSteps: 5, maxToolCalls: 10, timeoutMs: 60_000, maxReplans: 0 },
    });
    const outcome = await runSubAgentGraph(testCtx(), profile);
    expect(outcome.result!.status).toBe("failed");
  });
});
