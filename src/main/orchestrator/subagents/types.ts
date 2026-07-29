// 子代理公共类型定义

import type { PlanStep, StepVerificationResult } from "../task-plan";
import type { ToolCallResult } from "../types";

/** 子代理 Profile ID 联合类型 */
export type SubAgentProfileId = "document" | "search" | "crawler";

/** 子代理运行上下文（由主 Agent 执行节点构造） */
export interface SubAgentRunContext {
  profile: SubAgentProfileId;
  taskId: string;
  args: Record<string, unknown>;
  parentContext: {
    runId: string;
    planId?: string;
    stepId?: string;
    stepExecutionId?: string;
    stepAttemptId?: string;
  };
  /** 父运行取消信号，子代理内部工具执行时应传播此信号 */
  signal?: AbortSignal;
  /** 子代理运行截止时间戳（ms） */
  deadlineAt?: number;
}

/** 子代理预算 */
export interface SubAgentBudget {
  maxSteps: number;
  maxToolCalls: number;
  timeoutMs: number;
  maxReplans: number;
}

/** 子代理简化计划（复用 PlanStep，不复用 TaskPlan） */
export interface SubAgentPlan {
  id: string;
  goal: string;
  steps: PlanStep[];
  status: "running" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
}

/** 子代理决策：当前步骤要做什么 */
export type SubAgentDecision =
  | { action: "call_tool"; toolId: string; args: Record<string, unknown> }
  | { action: "skip" }
  | { action: "fail"; reason: string; code: string; recoverable: boolean };

/**
 * 子代理独立状态。不共享 AgentGraphState。
 * 内部 Tool Trace 存储在此，不进入主 Graph。
 */
export interface SubAgentState {
  ctx: SubAgentRunContext;
  budget: SubAgentBudget;
  plan: SubAgentPlan;
  currentStepId?: string;
  toolResults: ToolCallResult[];
  iterationCount: number;
  budgetUsage: {
    toolCallsUsed: number;
    replanCount: number;
    startedAt: number;
  };
  /** 无进展检测预留字段（第一阶段不触发） */
  lastActionFingerprint?: string;
  lastResultFingerprint?: string;
  /** 最终结果（finalize 后填充） */
  result?: SubAgentPublicResultV1;
}

/**
 * Profile 配置：提供工具白名单、计划策略、预算、决策和结果构建。
 * 每种 Profile（document/search/crawler）实现此接口。
 */
export interface SubAgentProfileConfig {
  id: SubAgentProfileId;
  allowedTools: Set<string>;
  budget: SubAgentBudget;

  /** 创建初始计划（模板或 LLM 生成） */
  createInitialPlan(ctx: SubAgentRunContext): SubAgentPlan;

  /** 决策：当前步骤要调用什么工具（或 skip/fail） */
  decide(state: SubAgentState): SubAgentDecision;

  /** 验证当前步骤是否完成 */
  verifyStep(state: SubAgentState): StepVerificationResult;

  /** 构建最终 SubAgentPublicResult */
  buildResult(state: SubAgentState): SubAgentPublicResultV1;

  /**
   * 判断当前状态是否存在经过验证的有效结果。
   * 预算耗尽时使用：有有效结果 -> partial，无有效结果 -> failed。
   * 不能只判断 findings.length > 0；Search finding 至少应满足内容非空、来源有效。
   */
  hasValidResults(state: SubAgentState): boolean;
}

/** 子代理 Finding：一条结构化发现 */
export interface SubAgentFinding {
  id: string;
  title?: string;
  content: string;
  source?: string;
}

/** 子代理 Artifact：一个已验证的产出物 */
export interface SubAgentArtifact {
  id: string;
  name: string;
  path?: string;
  mimeType?: string;
  sizeBytes?: number;
  verified: boolean;
}

/** 完成证据记录 */
export interface CompletionEvidenceRecord {
  criterion: string;
  satisfied: boolean;
  evidenceRefs: string[];
}

/**
 * 子代理返回的公共结果信封。
 * 序列化为 JSON 字符串存入 ToolExecutionOutcome.output，
 * 由 parseSubAgentResult 统一解析。
 */
export interface SubAgentPublicResultV1 {
  kind: "subagent_result";
  version: 1;

  taskId: string;
  profile: "search" | "crawler" | "document";

  status: "succeeded" | "partial" | "blocked" | "failed";

  summary: string;

  findings: SubAgentFinding[];
  artifacts: SubAgentArtifact[];
  completionEvidence: CompletionEvidenceRecord[];

  missingInformation?: string[];
  warnings?: string[];

  error?: {
    code: string;
    message: string;
    recoverable: boolean;
  };

  traceRef?: string;

  /** 扁平化的主产物信息，供 entity_detail 投影器直接提取 */
  primaryArtifact?: {
    name: string;
    path: string;
    verified: boolean;
  };
}

/** 子图运行层结果：区分"调用是否正常结束"和"任务是否完成" */
export interface SubAgentRunOutcome {
  invocationStatus: "completed" | "timed_out" | "cancelled" | "crashed";
  result?: SubAgentPublicResultV1;
  error?: {
    code: string;
    message: string;
  };
}
