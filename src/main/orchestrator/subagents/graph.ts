// 通用子代理 Graph 骨架
//
// 固定流程：initialize -> activateStep -> decide -> execute -> observe -> verify -> advance/replan -> finalize
// 子图使用独立 SubAgentState，不共享 AgentGraphState。
// Profile 提供工具白名单、计划策略、预算、决策和最终结果构建。
// 内部 Tool Trace 不进入主 Graph。

import { toolRegistry, type ToolDefinition } from "../tool-registry";
import type { ToolContext } from "../tool-context";
import { findStep } from "../task-plan";
import type { PlanStep } from "../task-plan";
import type {
  SubAgentRunContext,
  SubAgentRunOutcome,
  SubAgentState,
  SubAgentProfileConfig,
  SubAgentPlan,
  SubAgentPublicResultV1,
} from "./types";

/** 判断是否为 AbortError */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
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

/** 检查取消/超时/预算 */
function checkGuards(state: SubAgentState): SubAgentRunOutcome | null {
  const { ctx, budgetUsage, budget } = state;
  // 父运行取消
  if (ctx.signal?.aborted) {
    return { invocationStatus: "cancelled", error: { code: "ABORTED", message: "父运行已取消" } };
  }
  // 超时
  if (ctx.deadlineAt && Date.now() > ctx.deadlineAt) {
    return { invocationStatus: "timed_out", error: { code: "SUBAGENT_TIMEOUT", message: "子代理达到截止时间" } };
  }
  if (Date.now() - budgetUsage.startedAt > budget.timeoutMs) {
    return { invocationStatus: "timed_out", error: { code: "SUBAGENT_TIMEOUT", message: "子代理达到超时上限" } };
  }
  // 预算耗尽
  if (budgetUsage.toolCallsUsed >= budget.maxToolCalls) {
    return { invocationStatus: "completed", error: { code: "SUBAGENT_BUDGET_EXHAUSTED", message: "工具调用次数耗尽" } };
  }
  if (state.iterationCount >= budget.maxSteps * 3) {
    return { invocationStatus: "completed", error: { code: "SUBAGENT_STEP_LIMIT", message: "步骤迭代次数耗尽" } };
  }
  return null;
}

/** 找到下一个 pending 步骤 */
function findNextPendingStep(plan: SubAgentPlan): PlanStep | undefined {
  return plan.steps.find(s => s.status === "pending");
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

  try {
    // ── 主循环 ──
    while (true) {
      // 检查取消/超时/预算
      const guard = checkGuards(state);
      if (guard) {
        // 超时但有部分结果时，尝试构建 partial 结果
        if (guard.invocationStatus === "timed_out" && state.toolResults.length > 0) {
          return { invocationStatus: "completed", result: profile.buildResult(state) };
        }
        return guard;
      }

      // ── activateStep ──
      const step = findNextPendingStep(state.plan);
      if (!step) {
        // 所有步骤完成 -> finalize
        state.plan.status = "completed";
        return { invocationStatus: "completed", result: profile.buildResult(state) };
      }

      step.status = "running";
      state.currentStepId = step.id;
      state.iterationCount++;

      // ── decide ──
      const decision = profile.decide(state);

      if (decision.action === "fail") {
        step.status = "failed";
        const result = profile.buildResult(state);
        return { invocationStatus: "completed", result };
      }

      // ── execute ──
      if (decision.action === "call_tool") {
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
        state.budgetUsage.toolCallsUsed++;
      }
      // action === "skip": 不调用工具，直接进入验证

      // ── observe（无进展检测预留，第一阶段不触发） ──
      // TODO: 当 Search Agent 引入 partial/blocked 时实现

      // ── verify ──
      const verification = profile.verifyStep(state);

      if (verification.status === "completed") {
        // ── advance ──
        step.status = "completed";
        state.plan.updatedAt = Date.now();
      } else if (verification.status === "failed") {
        // ── replan ──
        if (state.budgetUsage.replanCount < profile.budget.maxReplans) {
          step.status = "failed";
          state.budgetUsage.replanCount++;
          // 简单策略：标记当前步骤失败，继续下一步
          // 后续可实现更智能的 replan
        } else {
          step.status = "failed";
          state.plan.status = "failed";
          const result = profile.buildResult(state);
          return { invocationStatus: "completed", result };
        }
      }
      // verification.status === "running": 继续循环（同一步骤）
    }
  } catch (err) {
    // AbortError 重新抛出
    if (isAbortError(err)) throw err;

    const message = err instanceof Error ? err.message : String(err);
    return {
      invocationStatus: "crashed",
      error: { code: "SUBAGENT_RUNTIME_ERROR", message },
    };
  }
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
