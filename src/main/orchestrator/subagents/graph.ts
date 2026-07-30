// 通用子代理 Graph 骨架
//
// 固定流程：initialize -> activateStep -> decide -> execute -> observe -> verify -> advance/replan -> finalize
// 子图使用独立 SubAgentState，不共享 AgentGraphState。
// Profile 提供工具白名单、计划策略、预算、决策和最终结果构建。
// 内部 Tool Trace 不进入主 Graph。

import { toolRegistry, type ToolDefinition } from "../tool-registry";
import type { ToolContext } from "../tool-context";
import type { PlanStep, StepVerificationResult } from "../task-plan";
import type {
  SubAgentRunContext,
  SubAgentRunOutcome,
  SubAgentState,
  SubAgentProfileConfig,
  SubAgentPlan,
  SubAgentPublicResultV1,
  SubAgentDecision,
} from "./types";

// ── 工具函数 ──────────────────────────────────────────────

/** 判断是否为 AbortError */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
}

/** 递归排序对象 key，生成确定性 JSON（用于指纹计算） */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]),
  );
}

/** 通过统一原子工具执行边界调用工具 */
async function executeAllowedTool(
  toolId: string,
  args: Record<string, unknown>,
  allowedTools: Set<string>,
  signal?: AbortSignal,
): Promise<string> {
  const tool: ToolDefinition | undefined = toolRegistry.getById(toolId);
  if (!tool) throw new Error(`工具未注册: ${toolId}`);
  if (!tool.enabled) throw new Error(`工具已禁用: ${toolId}`);
  if (!allowedTools.has(toolId)) throw new Error(`工具不在白名单中: ${toolId}`);
  const ctx: ToolContext | undefined = signal
    ? { userQuery: "", conversationId: "subagent", signal }
    : undefined;
  return tool.execute(args, ctx);
}

// ── 无进展检测 ────────────────────────────────────────────

/**
 * 生成 action 指纹：stepId + toolId + stable(args)
 */
function actionFingerprint(stepId: string | undefined, decision: SubAgentDecision): string {
  if (decision.action !== "call_tool") return `skip:${stepId ?? ""}`;
  return `${stepId ?? ""}:${decision.toolId}:${JSON.stringify(stable(decision.args))}`;
}

interface NoProgressState {
  lastActionFingerprint?: string;
  lastProgressEvidence?: string;
  repeatCount: number;
}

/**
 * 无进展检测（在 observe 节点调用，execute 之后）。
 * 使用 Profile 提供的 extractProgressEvidence 基于语义字段判断进展，
 * 不使用字符串截断或原始输出前缀。
 * 不同 stepId 或不同 action 不算同一循环。
 */
function detectNoProgress(
  state: SubAgentState,
  noProgress: NoProgressState,
  decision: SubAgentDecision,
  profile: SubAgentProfileConfig,
): { noProgress: boolean; isFirstRepeat: boolean } {
  // 只在有实际工具结果时检测（skip 不消耗预算，不应被误判为无进展）
  if (decision.action !== "call_tool") return { noProgress: false, isFirstRepeat: false };
  if (state.toolResults.length === 0) return { noProgress: false, isFirstRepeat: false };

  const currentAction = actionFingerprint(state.currentStepId, decision);
  // 使用 Profile 的语义进展证据替代字符串截断
  const currentEvidence = profile.extractProgressEvidence(state);

  if (
    noProgress.lastActionFingerprint === currentAction
    && noProgress.lastProgressEvidence === currentEvidence
  ) {
    noProgress.repeatCount++;
    return { noProgress: true, isFirstRepeat: noProgress.repeatCount === 1 };
  }

  noProgress.lastActionFingerprint = currentAction;
  noProgress.lastProgressEvidence = currentEvidence;
  noProgress.repeatCount = 0;
  return { noProgress: false, isFirstRepeat: false };
}

// ── 预算与守卫 ────────────────────────────────────────────

/**
 * 检查取消/超时/预算。
 * 返回非 null 时应立即终止。
 */
function checkGuards(
  state: SubAgentState,
  profile: SubAgentProfileConfig,
): SubAgentRunOutcome | null {
  const { ctx, budgetUsage, budget } = state;

  // 父运行取消
  if (ctx.signal?.aborted) {
    return { invocationStatus: "cancelled", error: { code: "ABORTED", message: "父运行已取消" } };
  }

  // 超时
  const now = Date.now();
  if (ctx.deadlineAt && now > ctx.deadlineAt) {
    return buildBudgetOutcome(state, profile, "timed_out");
  }
  if (now - budgetUsage.startedAt > budget.timeoutMs) {
    return buildBudgetOutcome(state, profile, "timed_out");
  }

  // 预算耗尽
  if (budgetUsage.toolCallsUsed >= budget.maxToolCalls) {
    return buildBudgetOutcome(state, profile, "completed");
  }
  if (state.iterationCount >= budget.maxSteps * 3) {
    return buildBudgetOutcome(state, profile, "completed");
  }

  return null;
}

/**
 * 预算耗尽时的结果构建：
 * - plan.status === "failed" → 保持 failed，不覆盖
 * - 有经过验证的 finding、artifact 或 completion evidence → partial
 * - 没有任何有效结果 → failed
 * - 永远不返回 blocked
 */
function buildBudgetOutcome(
  state: SubAgentState,
  profile: SubAgentProfileConfig,
  invocationStatus: "completed" | "timed_out",
): SubAgentRunOutcome {
  // 如果 plan 已经标记为 failed，直接返回失败结果
  if (state.plan.status === "failed") {
    return {
      invocationStatus,
      result: profile.buildResult(state),
    };
  }

  // 检查是否有经过验证的有效结果（由 Profile 定义有效性标准）
  const hasValidResults = profile.hasValidResults(state);
  const hasCompletedSteps = state.plan.steps.some(s => s.status === "completed");
  const hasResults = hasValidResults || hasCompletedSteps;

  if (hasResults) {
    // 有部分结果但任务未全部完成 -> partial
    const result = profile.buildResult(state);
    result.status = "partial";
    result.error = {
      code: "SUBAGENT_BUDGET_EXHAUSTED",
      message: "预算耗尽但有部分有效结果",
      recoverable: true,
    };
    return { invocationStatus, result };
  }

  // 无有效结果 -> failed
  return {
    invocationStatus,
    error: {
      code: "SUBAGENT_BUDGET_EXHAUSTED_NO_RESULT",
      message: "预算耗尽且无有效结果",
    },
  };
}

// ── 主循环 ────────────────────────────────────────────────

/** 找到下一个待执行步骤：pending 或 running（当前步骤可能仍在运行中） */
function findActiveStep(plan: SubAgentPlan): PlanStep | undefined {
  return plan.steps.find(s => s.status === "pending" || s.status === "running");
}

/**
 * 运行通用子代理 Graph。
 * 这是所有 Profile 的公共执行入口。
 */
export async function runSubAgentGraph(
  ctx: SubAgentRunContext,
  profile: SubAgentProfileConfig,
): Promise<SubAgentRunOutcome> {
  // ── initialize ──
  const plan = profile.createInitialPlan(ctx);
  const state: SubAgentState = {
    ctx,
    budget: profile.budget,
    plan,
    toolResults: [],
    iterationCount: 0,
    budgetUsage: {
      toolCallsUsed: 0,
      replanCount: 0,
      startedAt: Date.now(),
    },
  };

  const noProgress: NoProgressState = { repeatCount: 0 };

  try {
    // ── 主循环 ──
    while (true) {
      // 进入前检查取消/超时/预算
      const guard = checkGuards(state, profile);
      if (guard) return guard;

      // ── activateStep ──
      const step = findActiveStep(state.plan);
      if (!step) {
        // 所有步骤完成或失败 -> finalize
        const hasFailed = state.plan.steps.some(s => s.status === "failed");
        const hasCompleted = state.plan.steps.some(s => s.status === "completed");
        if (hasFailed && !hasCompleted) {
          // 全部失败 -> plan failed
          state.plan.status = "failed";
          return { invocationStatus: "completed", result: profile.buildResult(state) };
        }
        // 有完成步骤（或全部完成）-> plan completed
        state.plan.status = "completed";
        return { invocationStatus: "completed", result: profile.buildResult(state) };
      }

      if (step.status === "pending") {
        step.status = "running";
      }
      state.currentStepId = step.id;
      state.iterationCount++; // 每次 decide 循环加一

      // ── decide ──
      const decision = profile.decide(state);

      if (decision.action === "fail") {
        step.status = "failed";
        const result = profile.buildResult(state);
        return { invocationStatus: "completed", result };
      }

      // ── execute ──
      if (decision.action === "call_tool") {
        // 检查工具调用预算
        if (state.budgetUsage.toolCallsUsed >= profile.budget.maxToolCalls) {
          return buildBudgetOutcome(state, profile, "completed");
        }

        try {
          const output = await executeAllowedTool(
            decision.toolId,
            decision.args,
            profile.allowedTools,
            ctx.signal,
          );
          state.toolResults.push({
            toolId: decision.toolId,
            args: decision.args,
            output,
            status: "succeeded",
            terminal: true,
          });
          state.budgetUsage.toolCallsUsed++; // 只有真正进入 tool.execute() 才加一
        } catch (err) {
          // 执行前失败（白名单拒绝、工具不存在）不计入 toolCalls，但计入 iteration
          if (isAbortError(err)) throw err;
          state.toolResults.push({
            toolId: decision.toolId,
            args: decision.args,
            output: err instanceof Error ? err.message : String(err),
            status: "failed",
            errorCode: "E_TOOL_EXECUTION_FAILED",
            terminal: true,
          });
        }

        // 工具执行结束后再次检查 deadline
        if (ctx.deadlineAt && Date.now() > ctx.deadlineAt) {
          return buildBudgetOutcome(state, profile, "timed_out");
        }

        // ── observe: 无进展检测（execute 之后） ──
        const np = detectNoProgress(state, noProgress, decision, profile);
        if (np.noProgress) {
          if (np.isFirstRepeat && state.budgetUsage.replanCount < profile.budget.maxReplans) {
            // 第一次重复 -> replan
            state.budgetUsage.replanCount++;
            step.status = "failed";
            // 重置指纹以允许 replan 后重新检测
            noProgress.repeatCount = 0;
            noProgress.lastActionFingerprint = undefined;
            noProgress.lastProgressEvidence = undefined;
            continue; // 重新进入循环
          } else {
            // replan 后仍重复或无 replan 预算 -> 终止
            return {
              invocationStatus: "completed",
              result: buildNoProgressResult(state, profile),
            };
          }
        }
      }
      // action === "skip": 不调用工具，不增加 toolCallsUsed，直接进入 verify

      // ── verify ──
      const verification = profile.verifyStep(state);

      if (verification.status === "completed") {
        // ── advance ──
        step.status = "completed";
        state.plan.updatedAt = Date.now();
        // 重置无进展检测（步骤完成后进入新步骤）
        noProgress.repeatCount = 0;
      } else if (verification.status === "failed") {
        // ── replan ──
        if (state.budgetUsage.replanCount < profile.budget.maxReplans) {
          step.status = "failed";
          state.budgetUsage.replanCount++; // 只有成功应用一次 replan 才加一
          // 继续循环，找下一个 pending 步骤
        } else {
          // 无 replan 预算 -> finalize
          step.status = "failed";
          state.plan.status = "failed";
          const result = profile.buildResult(state);
          return { invocationStatus: "completed", result };
        }
      }
      // verification.status === "running": 继续循环（同一步骤）
    }
  } catch (err) {
    if (isAbortError(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    return { invocationStatus: "crashed", error: { code: "SUBAGENT_RUNTIME_ERROR", message } };
  }
}

/** 构建无进展失败的 SubAgentPublicResult */
function buildNoProgressResult(state: SubAgentState, profile: SubAgentProfileConfig): SubAgentPublicResultV1 {
  const result = profile.buildResult(state);
  result.status = "failed";
  result.error = {
    code: "SUBAGENT_NO_PROGRESS",
    message: "子代理连续重复执行相同动作且无新证据",
    recoverable: false,
  };
  return result;
}

/** 构建失败的 SubAgentPublicResult（供 Profile 使用） */
export function buildFailedResult(
  taskId: string,
  profile: "search" | "crawler" | "document",
  message: string,
  code: string,
  recoverable: boolean,
): SubAgentPublicResultV1 {
  return {
    kind: "subagent_result",
    version: 1,
    taskId,
    profile,
    status: "failed",
    summary: message,
    findings: [],
    artifacts: [],
    completionEvidence: [],
    error: { code, message, recoverable },
  };
}
