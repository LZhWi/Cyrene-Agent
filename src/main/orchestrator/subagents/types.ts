// 子代理公共类型定义

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

/** 子代理任务契约 */
export interface SubAgentTask {
  taskId: string;
  profile: "search" | "crawler" | "document";
  objective: string;
  /** 主 Agent Native FC 生成的参数 */
  args: Record<string, unknown>;
  /** 从主图 state 组装的上下文 */
  context?: Array<{
    refId: string;
    type: "tool_result" | "text" | "entity";
    value: unknown;
  }>;
  parent: {
    runId: string;
    planId?: string;
    stepId?: string;
  };
}

/** 子代理预算 */
export interface SubAgentBudget {
  maxSteps: number;
  maxToolCalls: number;
  timeoutMs: number;
  maxReplans: number;
}
