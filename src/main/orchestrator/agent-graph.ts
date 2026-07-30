import { Annotation, Command, END, START, StateGraph } from "@langchain/langgraph";
import { AgentRuntimeError } from "./agent-runtime-error";
import { perf } from "../perf-trace";
import type { ToolCallResult } from "./types";
import type { ToolDefinition } from "./tool-registry";
import { resolveEffectKind, resolveVerificationPolicy } from "./tool-registry";
import type { ChatMessage } from "./vendors/types";
import type {
  AskMissingField,
  AskUserAnswer,
} from "../../shared/ask-clarification";

export type ActionDecision =
  | {
      decision: "act";
      capability: string;
      objective: string;
      targetRefs: string[];
      /** 本次工具成功后的继续策略。未声明时默认 respond。 */
      afterSuccess?: "respond" | "replan";
    }
  | {
      decision: "respond";
      reason: string;
    }
  | {
      decision: "ask_user";
      reason: string;
      missingFields: AskMissingField[];
    }
  | {
      /** Local trusted failure fact. It is never produced by a model. */
      decision: "failure";
      reason: "action_gate_failed";
      code: string;
      disposition: "repair" | "ask_user" | "refresh_state" | "execution_policy" | "fail_closed";
      toolExecuted: false;
    };

export type ActDecision = Extract<ActionDecision, { decision: "act" }>;
export type AskUserDecision = Extract<ActionDecision, { decision: "ask_user" }>;
export type FailureDecision = Extract<ActionDecision, { decision: "failure" }>;

/** routeAfterTool 的纯路由决策逻辑，提取为可测试函数。 */
export function resolveRouteAfterTool(
  result: ToolCallResult | undefined,
  action: { afterSuccess?: "respond" | "replan" } | undefined,
  inPlanMode: boolean,
): "decide" | "soul" | "planVerify" {
  if (!result || !action) return "decide";
  let goto: "decide" | "soul" | "planVerify";
  if (result.status === "failed") {
    goto = result.retryable ? "decide" : "soul";
  } else if (!result.terminal) {
    goto = "decide";
  } else {
    goto = action.afterSuccess === "replan" ? "decide" : "soul";
  }
  if (goto === "soul" && inPlanMode) {
    goto = "planVerify";
  }
  return goto;
}

export interface GateFailureInfo {
  code: string;
  disposition: string;
}

export interface AgentGraphInput {
  originalQuery: string;
  contextualizedQuery: string;
  citaContextBlock: string;
  messages: ChatMessage[];
  availableCapabilities: string[];
  clarificationAnswers?: AskUserAnswer[];
  /**
   * 可信工作区根目录（来自 Conversation Workspace Binding）。
   * delegate_coding 和 run_verification 必须使用此目录。
   */
  resolvedWorkspaceRoot?: string;
}

/** 从工具结果中提取变更文件路径（结构化 JSON 或正则回退） */
function extractChangedFilePathFromResult(result: ToolCallResult): string {
  try {
    const parsed = JSON.parse(result.output);
    // delegate_coding 返回 changedFiles 数组
    if (Array.isArray(parsed.changedFiles) && parsed.changedFiles.length > 0) {
      return parsed.changedFiles[0];
    }
    if (parsed.filePath) return String(parsed.filePath);
  } catch {
    // 非 JSON 输出，回退到正则
  }
  const match = result.output.match(/已更新\s+(.+?)$/m) || result.output.match(/已写入[:\s]+(.+?)$/m);
  return match ? match[1].trim() : "";
}

/** 从工具结果提取全部变更文件（delegate_coding 返回 changedFiles 数组） */
function extractAllChangedFiles(result: ToolCallResult): string[] {
  try {
    const parsed = JSON.parse(result.output);
    if (Array.isArray(parsed.changedFiles)) return parsed.changedFiles;
  } catch { /* 非 JSON */ }
  const single = extractChangedFilePathFromResult(result);
  return single ? [single] : [];
}

/** 从工具结果提取 workspaceRoot（delegate_coding 返回 workspaceRoot） */
function extractWorkspaceRoot(result: ToolCallResult): string | undefined {
  try {
    const parsed = JSON.parse(result.output);
    if (parsed.workspaceRoot) return String(parsed.workspaceRoot);
  } catch { /* 非 JSON */ }
  return undefined;
}

/**
 * 检测用户消息是否包含跳过验证的明确授权。
 * 只有用户消息中包含以下含义时才能创建 waiver：
 * - "不要运行测试" / "不用验证" / "只修改，不要编译" / "直接改完即可"
 * Action Gate 的 reason 不能创建 waiver。
 */
export function detectVerificationWaiver(
  messages: ChatMessage[],
  runId: string,
): VerificationWaiver | undefined {
  // 只检查最近的用户消息
  const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
  if (!lastUserMsg || typeof lastUserMsg.content !== "string") return undefined;

  const text = lastUserMsg.content.toLowerCase();
  const skipPatterns = [
    /不要(运行|跑|执行)?(测试|test)/,
    /不用(验证|检查|编译|构建)/,
    /只(修改|改|写)(代码|文件)?[，,]?\s*不要(运行|跑|执行)?(测试|编译|验证)/,
    /直接(改|写|修改)(完|好|掉)(就行|即可|就好)/,
    /skip\s*(test|verify|build|compile)/,
    /no\s*(test|verify|build|compile)/,
  ];

  if (skipPatterns.some(p => p.test(text))) {
    return {
      source: "explicit_user_instruction",
      messageId: `msg_${Date.now()}`,
      runId,
      scope: "current_run",
      evidenceText: lastUserMsg.content.slice(0, 200),
    };
  }
  return undefined;
}

/**
 * 分辨 RunCompletionStatus：根据 FinalizationDisposition 和代码验证状态确定最终完成状态。
 * 由路由节点调用，结果固化到 FinalizationOutcome，Soul 只读取不重新计算。
 */
export function resolveCompletionStatus(
  state: AgentGraphState,
  disposition: { kind: string },
): FinalizationOutcome {
  if (disposition.kind === "allow_unverified") {
    return { status: "completed_unverified", reason: "用户授权跳过验证" };
  }
  if (disposition.kind === "allow_failure") {
    return { status: "failed", reason: (disposition as { reason?: string }).reason ?? "验证失败或预算耗尽" };
  }
  // allow_success
  const cv = state.codeVerification;
  if (!cv || cv.mutationRevision === 0) {
    // 无代码修改 -> completed（搜索、读取、文档生成等）
    return { status: "completed" };
  }
  if (cv.verifiedRevision === cv.mutationRevision) {
    // 代码修改已验证 -> completed_verified
    return { status: "completed_verified" };
  }
  // 不应到达此处（Guard 已验证），防御性返回
  return { status: "completed", reason: "无代码修改" };
}

// ── Finalization Guard（纯函数，四态） ──────────────────────

export type FinalizationDisposition =
  | { kind: "allow_success"; update?: Partial<AgentGraphState> }
  | { kind: "allow_unverified"; update: Partial<AgentGraphState> }
  | { kind: "allow_failure"; reason: string }
  | { kind: "block"; redirectTo: "decide" | "planVerify" | "replan"; reason: string; update?: Partial<AgentGraphState> };

/**
 * 纯函数 Finalization Guard：检查是否允许成功收尾。
 * 不修改输入 state，返回 disposition 和可选 update 由调用节点应用。
 *
 * 覆盖三处调用：routeAfterTool -> soul, planVerify -> soul, decide -> respond
 */
export function checkFinalizationGuard(state: AgentGraphState): FinalizationDisposition {
  // ── Rule 1: Plan 状态检查（如果有 Plan）──
  if (state.taskPlan) {
    const planStatus = state.taskPlan.status;
    if (planStatus === "running") {
      return {
        kind: "block",
        redirectTo: "planVerify",
        reason: "计划仍在运行中",
      };
    }
    if (planStatus === "failed") {
      return { kind: "allow_failure", reason: "计划执行失败" };
    }
    if (planStatus === "cancelled") {
      return { kind: "allow_failure", reason: "计划已取消" };
    }
    if (planStatus === "paused" || planStatus === "awaiting_user") {
      return { kind: "block", redirectTo: "decide", reason: "计划暂停或等待用户输入" };
    }
    // planStatus === "completed" -> 继续检查代码验证
  }

  // ── Rule 2: 代码验证状态检查 ──
  const cv = state.codeVerification;

  // 无代码修改 -> 正常完成
  if (!cv || cv.mutationRevision === 0) {
    return { kind: "allow_success" };
  }

  // 用户明确授权跳过验证
  if (cv.status === "pending" && state.verificationWaiver) {
    return {
      kind: "allow_unverified",
      update: {
        codeVerification: { ...cv, status: "skipped" as const },
      },
    };
  }

  // 当前 revision 已验证
  if (cv.status === "passed" && cv.verifiedRevision === cv.mutationRevision) {
    return { kind: "allow_success" };
  }

  // 有未验证修改
  if (cv.status === "pending") {
    if (hasRemainingVerificationBudget(state)) {
      return {
        kind: "block",
        redirectTo: "decide",
        reason: "存在未验证的代码修改",
        update: {
          lastGateFailure: {
            code: "E_VERIFICATION_REQUIRED",
            disposition: "execution_policy",
          },
          requiredNextAction: {
            capabilityId: "run_verification",
            reason: "代码修改后必须运行验证",
            forcedArgs: {
              verificationType: "typecheck",
              cwd: state.lastDelegateCodingWorkspace,
            },
          },
        },
      };
    }
    return { kind: "allow_failure", reason: "验证预算耗尽，修改未经验证" };
  }

  // 验证失败
  if (cv.status === "failed") {
    if (state.requiredNextAction?.capabilityId === "run_verification") {
      // 瞬时故障：保留约束，允许重试（但有熔断上限）
      const retryCount = state.verificationRetryCount ?? 0;
      const MAX_VERIFICATION_RETRIES = 1;
      if (retryCount < MAX_VERIFICATION_RETRIES && hasRemainingVerificationBudget(state)) {
        return { kind: "block", redirectTo: "decide", reason: "验证超时，请重试" };
      }
      return { kind: "allow_failure", reason: "验证重试耗尽，修改未经验证" };
    }
    // 非瞬时故障：约束已清除，允许修复
    if (hasRemainingRepairBudget(state)) {
      return { kind: "block", redirectTo: "decide", reason: "验证失败，需要修复代码" };
    }
    return { kind: "allow_failure", reason: "验证失败且修复预算耗尽" };
  }

  // skipped
  if (cv.status === "skipped") {
    return { kind: "allow_unverified", update: {} };
  }

  return { kind: "allow_success" };
}

function hasRemainingVerificationBudget(state: AgentGraphState): boolean {
  if (state.iterationCount >= 30) return false;  // HARD_MAX_ITERATIONS
  if (state.taskPlan) {
    const hasPendingVerification = state.taskPlan.steps.some(s =>
      (s.status === "pending" || s.status === "running") &&
      s.completionPolicy.allOf?.some(c => c.kind === "verification_passed")
    );
    if (hasPendingVerification) return true;
  }
  if (state.replanCount < 2) return true;  // DEFAULT_MAX_REPLANS
  return false;
}

function hasRemainingRepairBudget(state: AgentGraphState): boolean {
  if (state.iterationCount >= 30) return false;
  if (state.replanCount < 2) return true;
  return false;
}

export interface CodeVerificationState {
  /** 当前代码修改版本号（只在 verificationPolicy=code 的 mutation 成功时 +1） */
  mutationRevision: number;
  /** 已验证的代码修改版本号（验证通过且 revisionAtStart === mutationRevision 时更新） */
  verifiedRevision: number;
  /** 代码验证状态 */
  status: "clean" | "pending" | "passed" | "failed" | "skipped";
  /** 已修改的代码文件列表 */
  changedFiles: string[];
  /** 最后一次代码修改的 stepAttemptId */
  lastMutationStepAttemptId?: string;
  /** 最后一次验证的 stepAttemptId */
  lastVerificationStepAttemptId?: string;
}

export interface VerificationWaiver {
  source: "explicit_user_instruction";
  messageId: string;
  runId: string;
  scope: "current_run";
  evidenceText: string;
}

export interface FinalizationOutcome {
  status: "completed" | "completed_verified" | "completed_unverified" | "failed";
  reason?: string;
}

export interface AgentGraphState extends AgentGraphInput {
  decision?: ActionDecision;
  /** 当前正在执行的 act 决策（含 afterSuccess），供 routeAfterTool 读取。 */
  currentAction?: ActDecision;
  toolResults: ToolCallResult[];
  iterationCount: number;
  reply: string;
  clarificationAnswers: AskUserAnswer[];
  /** refresh_state 重新决策次数，防止无限循环。 */
  refreshCount: number;
  /** 上一次 Action Gate 失败信息，供下一次 decide 读取并传给模型。 */
  lastGateFailure?: GateFailureInfo;
  /** Task Router 路由结果（feature flag 开启时使用） */
  taskRoute?: import("./task-router").TaskRoute;
  /** 执行计划（plan 模式） */
  taskPlan?: import("./task-plan").TaskPlan;
  /** 当前执行的步骤 ID */
  currentStepId?: string;
  /** 重规划次数 */
  replanCount: number;
  /** 临时 direct 完成后恢复旧 Plan */
  resumePlanAfterDirect?: boolean;
  /** 代码修改验证状态 */
  codeVerification?: CodeVerificationState;
  /** 用户验证跳过授权 */
  verificationWaiver?: VerificationWaiver;
  /** 最终确定化结果（路由阶段固化，Soul 只读取不重新计算） */
  finalizationOutcome?: FinalizationOutcome;
  /** 确定性强制下一步（跳过 Action Gate LLM） */
  requiredNextAction?: {
    capabilityId: string;
    reason: string;
    /** 预构造的工具参数（如 run_verification 的 cwd） */
    forcedArgs?: Record<string, unknown>;
  };
  /** delegate_coding 返回的可信 workspaceRoot（run_verification 继承） */
  lastDelegateCodingWorkspace?: string;
  /** 验证重试计数（熔断器：防止无限重试） */
  verificationRetryCount?: number;
}

export interface AgentGraphDeps {
  decide: (state: AgentGraphState) => Promise<ActionDecision>;
  execute: (state: AgentGraphState, decision: ActDecision) => Promise<ToolCallResult[]>;
  askUser?: (state: AgentGraphState, decision: AskUserDecision) => Promise<AskUserAnswer>;
  respond: (state: AgentGraphState, decision: Exclude<ActionDecision, { decision: "act" }>) => Promise<string>;
  /** 根据 capabilityId 获取工具定义（供证据收集器解析 effectKind/verificationPolicy） */
  getToolById?: (id: string) => ToolDefinition | undefined;
  /** Task Router 回调（feature flag 开启时提供） */
  route?: (state: AgentGraphState) => Promise<import("./task-router").TaskRoute>;
  /** 计划创建回调（plan 模式） */
  createPlan?: (state: AgentGraphState) => Promise<import("./task-plan").TaskPlan>;
  /** 步骤验证回调（plan 模式） */
  planVerify?: (state: AgentGraphState) => Promise<import("./task-plan").StepVerificationResult>;
  /** 重规划回调（plan 模式） */
  planReplan?: (state: AgentGraphState) => Promise<import("./task-plan").PlanStep[]>;
  maxIterations?: number;
  /** refresh_state 最多重新决策次数，默认 1。 */
  maxRefresh?: number;
  /** 最大重规划次数，默认 2 */
  maxReplans?: number;
  /** Plan 状态变化时调用，发送快照给前端 */
  onPlanUpdate?: (plan: import("./task-plan").TaskPlan, replanCount: number) => void;
  trace?: (node: string, state: AgentGraphState) => void;
}

const GraphState = Annotation.Root({
  originalQuery: Annotation<string>,
  contextualizedQuery: Annotation<string>,
  citaContextBlock: Annotation<string>,
  messages: Annotation<ChatMessage[]>,
  availableCapabilities: Annotation<string[]>,
  decision: Annotation<ActionDecision | undefined>,
  currentAction: Annotation<ActDecision | undefined>,
  toolResults: Annotation<ToolCallResult[]>,
  iterationCount: Annotation<number>,
  reply: Annotation<string>,
  clarificationAnswers: Annotation<AskUserAnswer[]>,
  refreshCount: Annotation<number>,
  lastGateFailure: Annotation<GateFailureInfo | undefined>,
  taskRoute: Annotation<import("./task-router").TaskRoute | undefined>,
  taskPlan: Annotation<import("./task-plan").TaskPlan | undefined>,
  currentStepId: Annotation<string | undefined>,
  replanCount: Annotation<number>,
  resumePlanAfterDirect: Annotation<boolean | undefined>,
  codeVerification: Annotation<CodeVerificationState | undefined>,
  verificationWaiver: Annotation<VerificationWaiver | undefined>,
  finalizationOutcome: Annotation<FinalizationOutcome | undefined>,
  requiredNextAction: Annotation<{ capabilityId: string; reason: string; forcedArgs?: Record<string, unknown> } | undefined>,
  lastDelegateCodingWorkspace: Annotation<string | undefined>,
  verificationRetryCount: Annotation<number | undefined>,
  /** 可信工作区根目录（来自 Conversation Workspace Binding） */
  resolvedWorkspaceRoot: Annotation<string | undefined>,
});

// ── createPlan 错误分类 ──────────────────────

function extractHttpStatus(message: string): number | undefined {
  const match = message.match(/HTTP\s+(\d{3})/);
  return match ? parseInt(match[1], 10) : undefined;
}

function classifyCreatePlanError(error: unknown): { errorType: string; retryable: boolean } {
  const errStr = error instanceof Error ? error.message : String(error);
  const errName = error instanceof Error ? error.name : "Unknown";
  const httpStatus = extractHttpStatus(errStr);

  // 用户主动取消
  if (errName === "AbortError" || errStr.includes("aborted") || errStr.includes("E_AGENT_GRAPH_CANCELLED")) {
    return { errorType: "abort", retryable: false };
  }
  // 鉴权失败
  if (errStr.includes("401") || errStr.includes("403") || errStr.includes("AUTH") || errStr.includes("API key")) {
    return { errorType: "auth_failed", retryable: false };
  }
  // 内容拒绝
  if (errStr.includes("REFUSED") || errStr.includes("CONTENT_FILTERED")) {
    return { errorType: "model_refused", retryable: false };
  }
  // schema 错误（结构化输出 repair 预算已用完）
  if (errStr.includes("REPAIR_EXHAUSTED") || errStr.includes("NO_JSON_OBJECT") || errStr.includes("NO_SCHEMA_VALID_OBJECT")) {
    return { errorType: "structured_output_failed", retryable: false };
  }
  // 可重试的临时错误
  if (httpStatus === 429 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504 || httpStatus === 529) {
    return { errorType: "temporary_server_error", retryable: true };
  }
  if (errStr.includes("overloaded") || errStr.includes("timeout") || errStr.includes("TIMEOUT")) {
    return { errorType: "temporary_server_error", retryable: true };
  }
  if (errStr.includes("MODEL_REQUEST_TIMEOUT") || errStr.includes("STRUCTURED_OUTPUT_TIMEOUT")) {
    return { errorType: "timeout", retryable: true };
  }
  if (errStr.includes("MODEL_HTTP_ERROR")) {
    return { errorType: "http_error", retryable: httpStatus === 429 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504 || httpStatus === 529 };
  }
  if (errStr.includes("MODEL_RESPONSE_PARSE_FAILED")) {
    return { errorType: "parse_failed", retryable: false };
  }
  if (errStr.includes("MODEL_REQUEST_FAILED") && !httpStatus) {
    // 无 HTTP 状态码的请求失败，可能是网络问题
    return { errorType: "request_failed", retryable: true };
  }
  return { errorType: "unknown", retryable: false };
}

export async function runAgentGraph(input: AgentGraphInput, deps: AgentGraphDeps): Promise<AgentGraphState> {
  const maxIterations = Math.max(1, deps.maxIterations ?? 12);
  const maxRefresh = Math.max(0, deps.maxRefresh ?? 1);
  const maxReplans = Math.max(0, deps.maxReplans ?? 2);

  const compileTimer = perf.begin("graph_build_compile");
  const graph = new StateGraph(GraphState)
    .addNode("route", async (state) => {
      deps.trace?.("route", state);
      if (!deps.route) return {};  // feature flag 关闭时 no-op
      const taskRoute = await deps.route(state);
      return { taskRoute };
    })
    .addNode("decide", async (state) => {
      deps.trace?.("decide", state);
      const decision = await deps.decide(state);

      // ── requiredNextAction 硬约束：代码修改后必须验证 ──
      if (state.requiredNextAction && decision.decision === "act") {
        if (decision.capability !== state.requiredNextAction.capabilityId) {
          // Action Gate 选择了其他能力（如 delegate_coding）-> 拒绝，强制 run_verification
          console.log("[AgentGraph]", `requiredNextAction 拦截: 模型选了 ${decision.capability}，要求 ${state.requiredNextAction.capabilityId}`);
          return {
            decision: {
              decision: "failure" as const,
              reason: "action_gate_failed",
              code: "E_REQUIRED_CAPABILITY_NOT_SELECTED",
              disposition: "execution_policy",
              toolExecuted: false,
            },
            lastGateFailure: {
              code: "E_REQUIRED_CAPABILITY_NOT_SELECTED",
              disposition: "execution_policy",
            },
          };
        }
      }
      if (state.requiredNextAction && decision.decision === "respond") {
        // 试图 respond 但有 requiredNextAction -> 阻止
        return {
          decision: {
            decision: "failure" as const,
            reason: "action_gate_failed",
            code: "E_VERIFICATION_REQUIRED",
            disposition: "execution_policy",
            toolExecuted: false,
          },
          lastGateFailure: {
            code: "E_VERIFICATION_REQUIRED",
            disposition: "execution_policy",
          },
        };
      }

      // ── Finalization Guard：Action Gate 返回 respond 时检查 ──
      if (decision.decision === "respond") {
        const guard = checkFinalizationGuard(state);
        if (guard.kind === "block") {
          // 阻止 respond，注入失败信息并重新决策
          return {
            decision: {
              decision: "failure" as const,
              reason: "action_gate_failed",
              code: "E_FINALIZATION_BLOCKED",
              disposition: "execution_policy",
              toolExecuted: false,
            },
            lastGateFailure: {
              code: "E_FINALIZATION_BLOCKED",
              disposition: "execution_policy",
            },
            ...(guard.update ?? {}),
          };
        }
        if (guard.kind === "allow_failure") {
          return {
            decision,
            finalizationOutcome: resolveCompletionStatus(state, guard),
            lastGateFailure: undefined,
          };
        }
        if (guard.kind === "allow_unverified") {
          return {
            decision,
            ...(guard.update ?? {}),
            finalizationOutcome: resolveCompletionStatus(state, guard),
            lastGateFailure: undefined,
          };
        }
        // allow_success
        return {
          decision,
          finalizationOutcome: resolveCompletionStatus(state, guard),
          lastGateFailure: undefined,
        };
      }

      // act decision 同步写入 currentAction，供 routeAfterTool 读取 afterSuccess
      // lastGateFailure 在 decide 回调读取后清空，避免跨轮残留
      return {
        decision,
        lastGateFailure: undefined,
        ...(decision.decision === "act" ? { currentAction: decision } : {}),
      };
    })
    .addNode("execute", async (state) => {
      deps.trace?.("execute", state);
      if (state.iterationCount >= maxIterations) {
        throw new AgentRuntimeError(
          "E_AGENT_GRAPH_ITERATION_LIMIT",
          `Agent graph exceeded ${maxIterations} iterations.`,
        );
      }
      if (state.decision?.decision !== "act") {
        throw new Error("E_AGENT_GRAPH_INVALID_ACT_STATE");
      }
      const results = await deps.execute(state, state.decision);
      return {
        toolResults: [...state.toolResults, ...results],
        iterationCount: state.iterationCount + 1,
      };
    })
    .addNode("routeAfterTool", async (state) => {
      deps.trace?.("routeAfterTool", state);
      const result = state.toolResults[state.toolResults.length - 1];
      const action = state.currentAction;
      const inPlanMode = state.taskRoute?.executionMode === "plan"
        && state.taskPlan?.status === "running";
      const goto = resolveRouteAfterTool(result, action, inPlanMode);

      // ── 代码验证证据收集（两层语义） ──
      // 第一层：mutation 证据 — 从 output JSON 提取 changedFiles，不依赖 result.status
      // 第二层：verification 结果 — 依赖 result.status === "succeeded"
      let codeVerificationUpdate: Partial<AgentGraphState> = {};
      if (result) {
        const effectKind = result.capabilityId
          ? resolveEffectKind(deps.getToolById?.(result.capabilityId), result.args)
          : "unknown";

        // ── 第一层：mutation 证据收集 ──
        // 只要工具返回了可解析的 CodingAgentResult，就检查 changedFiles
        // 不依赖 result.status（业务 failed 不影响 mutation 证据）
        if (effectKind === "mutation") {
          const allChanged = extractAllChangedFiles(result);
          const hasPartialChanges = (() => {
            try { return JSON.parse(result.output)?.partialChanges === true; }
            catch { return false; }
          })();

          if (allChanged.length > 0 || hasPartialChanges) {
            const cv = state.codeVerification;
            const newRevision = (cv?.mutationRevision ?? 0) + 1;
            const prevFiles = cv?.changedFiles ?? [];
            const mergedFiles = [...new Set([...prevFiles, ...allChanged])].filter(Boolean);
            const ws = extractWorkspaceRoot(result);

            codeVerificationUpdate = {
              codeVerification: {
                mutationRevision: newRevision,
                verifiedRevision: cv?.verifiedRevision ?? 0,
                status: "pending",
                changedFiles: mergedFiles,
                lastMutationStepAttemptId: result.stepAttemptId,
                lastVerificationStepAttemptId: cv?.lastVerificationStepAttemptId,
              },
              requiredNextAction: {
                capabilityId: "run_verification",
                reason: "delegate_coding 产生了文件修改，必须验证",
                forcedArgs: {
                  verificationType: "typecheck",
                  // 优先使用 Conversation Workspace Binding（不可变可信源）
                  // 回退到 delegate_coding 返回的 workspaceRoot
                  cwd: state.resolvedWorkspaceRoot ?? ws ?? state.lastDelegateCodingWorkspace,
                },
              },
              lastDelegateCodingWorkspace: state.resolvedWorkspaceRoot ?? ws ?? state.lastDelegateCodingWorkspace,
              // 运行时 invariant：如果设置了 resolvedWorkspaceRoot，delegate_coding 返回的 workspaceRoot 必须一致
              ...(state.resolvedWorkspaceRoot && ws && ws !== state.resolvedWorkspaceRoot ? {
                lastGateFailure: {
                  code: "WORKSPACE_CONTEXT_MISMATCH",
                  disposition: "block",
                },
              } : {}),
            };
            // 清除之前的验证通过状态
            if (cv?.status === "passed") {
              (codeVerificationUpdate.codeVerification as CodeVerificationState).status = "pending";
            }

            console.log("[AgentGraph] mutation 证据收集:",
              "changedFiles=" + JSON.stringify(allChanged),
              "partialChanges=" + hasPartialChanges,
              "mutationRevision=" + newRevision,
            );
          }
        }

        // ── 第二层：verification 结果 ──
        // 仅当工具成功返回时处理
        if (result.status === "succeeded" && effectKind === "verification" && result.toolId === "run_verification") {
          const cv = state.codeVerification;
          if (cv) {
            try {
              const verificationResult = JSON.parse(result.output);
              const revisionAtStart = verificationResult.revisionAtStart ?? cv.mutationRevision;
              const passed = verificationResult.passed === true;

              if (passed && revisionAtStart === cv.mutationRevision) {
                codeVerificationUpdate = {
                  codeVerification: {
                    ...cv,
                    verifiedRevision: revisionAtStart,
                    status: "passed",
                    lastVerificationStepAttemptId: result.stepAttemptId,
                  },
                  requiredNextAction: undefined,
                  verificationRetryCount: 0,
                  lastGateFailure: undefined, // 验证通过后清除过期的 E_FINALIZATION_BLOCKED
                };
                console.log("[AgentGraph] 验证通过: verifiedRevision=" + revisionAtStart);
              } else if (passed && revisionAtStart < cv.mutationRevision) {
                // 验证期间发生了新修改 -> 验证只证明旧 revision
              } else {
                // 只有 timeout 才是瞬时故障；exitCode=-1 是 spawn 失败，非瞬时
                const isTransient = verificationResult.timedOut === true;
                const retryCount = (state.verificationRetryCount ?? 0) + 1;
                codeVerificationUpdate = {
                  codeVerification: {
                    ...cv,
                    status: "failed",
                    lastVerificationStepAttemptId: result.stepAttemptId,
                  },
                  requiredNextAction: isTransient ? state.requiredNextAction : undefined,
                  verificationRetryCount: retryCount,
                };
                console.log("[AgentGraph] 验证失败: exitCode=" + verificationResult.exitCode
                  + " errorCode=" + (verificationResult.errorCode ?? "none")
                  + " transient=" + isTransient
                  + " retryCount=" + retryCount);
                console.log("[AgentGraph] 验证失败: exitCode=" + verificationResult.exitCode + " transient=" + isTransient);
              }
            } catch {
              // 解析失败
            }
          }
        }

        // ── run_verification 工具执行失败（非 succeeded） ──
        // 例如：VERIFICATION_CONFIG_NOT_FOUND、spawn 失败等
        // 必须递增 verificationRetryCount 以触发熔断器
        if (result.status !== "succeeded" && result.toolId === "run_verification") {
          const cv = state.codeVerification;
          if (cv && cv.mutationRevision > cv.verifiedRevision) {
            const retryCount = (state.verificationRetryCount ?? 0) + 1;
            const errorCode = result.errorCode || "VERIFICATION_TOOL_FAILED";
            codeVerificationUpdate = {
              codeVerification: {
                ...cv,
                status: "failed",
                lastVerificationStepAttemptId: result.stepAttemptId,
              },
              // 工具执行失败 → 清除 requiredNextAction，让 guard 根据 retryCount 决定
              requiredNextAction: undefined,
              verificationRetryCount: retryCount,
            };
            console.log("[AgentGraph] run_verification 工具执行失败:",
              "errorCode=" + errorCode,
              "retryCount=" + retryCount,
              "output=" + (result.output ?? "").slice(0, 100),
            );
          }
        }
      }

      // ── Finalization Guard ──
      // 执行条件：goto === "soul"（正常完成路径）或有 requiredNextAction（mutation 已收集）
      // 不执行条件：goto === "decide"（retryable 失败重试）且无 requiredNextAction
      const hasRequiredAction = codeVerificationUpdate.requiredNextAction != null;
      const shouldCheckGuard = goto === "soul" || hasRequiredAction;

      if (shouldCheckGuard) {
        const stateWithEvidence = { ...state, ...codeVerificationUpdate };
        const guard = checkFinalizationGuard(stateWithEvidence);

        if (guard.kind === "block") {
          console.log("[AgentGraph] FinalizationGuard block: goto=" + goto + " → " + guard.redirectTo + " reason=" + guard.reason);
          return new Command({
            update: {
              ...codeVerificationUpdate,
              ...(guard.update ?? {}),
              ...(goto === "soul" ? { decision: undefined } : {}),
            },
            goto: guard.redirectTo,
          });
        }

        if (guard.kind === "allow_failure") {
          return new Command({
            update: {
              ...codeVerificationUpdate,
              decision: { decision: "respond" as const, reason: "verification_failed" },
              finalizationOutcome: resolveCompletionStatus(stateWithEvidence, guard),
            },
            goto: "soul",
          });
        }

        if (guard.kind === "allow_unverified") {
          return new Command({
            update: {
              ...codeVerificationUpdate,
              ...(guard.update ?? {}),
              decision: { decision: "respond" as const, reason: "tool_complete" },
              finalizationOutcome: resolveCompletionStatus(stateWithEvidence, guard),
            },
            goto: "soul",
          });
        }

        // allow_success
        return new Command({
          update: {
            ...codeVerificationUpdate,
            decision: { decision: "respond" as const, reason: "tool_complete" },
            finalizationOutcome: resolveCompletionStatus(stateWithEvidence, guard),
          },
          goto: "soul",
        });
      }

      // 非 soul 路由（decide/planVerify），直接转发
      const update = { ...codeVerificationUpdate };
      return new Command({ update, goto });
    })
    .addNode("askUser", async (state) => {
      deps.trace?.("askUser", state);
      if (state.decision?.decision !== "ask_user" || !deps.askUser) {
        return new Command({ goto: "soul" });
      }
      if (state.iterationCount >= maxIterations) {
        throw new AgentRuntimeError(
          "E_AGENT_GRAPH_ITERATION_LIMIT",
          `Agent graph exceeded ${maxIterations} iterations.`,
        );
      }
      const answer = await deps.askUser(state, state.decision);
      if (answer.answers.length === 0) {
        return new Command({ goto: "soul" });
      }
      return new Command({
        update: {
          clarificationAnswers: [...state.clarificationAnswers, answer],
          decision: undefined,
          iterationCount: state.iterationCount + 1,
        },
        goto: "decide",
      });
    })
    .addNode("refresh", async (state) => {
      deps.trace?.("refresh", state);
      const failure = state.decision as FailureDecision;
      return {
        refreshCount: state.refreshCount + 1,
        lastGateFailure: { code: failure.code, disposition: failure.disposition } as GateFailureInfo,
        decision: undefined,
      };
    })
    .addNode("createPlan", async (state) => {
      deps.trace?.("createPlan", state);
      if (!deps.createPlan) {
        console.warn("[AgentGraph] CreatePlan: dep missing, skipping");
        return new Command({ goto: "decide" });
      }
      console.log("[AgentGraph] CreatePlan entered");

      const MAX_REQUEST_RETRIES = 1;
      let lastError: unknown;

      for (let attempt = 1; attempt <= 1 + MAX_REQUEST_RETRIES; attempt++) {
        try {
          const plan = await deps.createPlan(state);
          const firstStep = plan.steps.find((s) => s.status === "pending");
          if (firstStep) {
            firstStep.executionId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            firstStep.status = "running";
          }
          if (attempt > 1) {
            console.log(`[AgentGraph] CreatePlan retry succeeded: attempt=${attempt} steps=${plan.steps.length}`);
          } else {
            console.log(`[AgentGraph] CreatePlan succeeded: steps=${plan.steps.length} goal=${plan.goal.slice(0, 80)}`);
          }
          deps.onPlanUpdate?.(plan, 0);
          return {
            taskPlan: plan,
            currentStepId: firstStep?.id,
          };
        } catch (error) {
          lastError = error;
          const errStr = error instanceof Error ? error.message : String(error);
          const errName = error instanceof Error ? error.name : "Unknown";
          const { errorType, retryable } = classifyCreatePlanError(error);
          const httpStatus = extractHttpStatus(errStr);

          if (retryable && attempt <= MAX_REQUEST_RETRIES) {
            // 短退避后重试
            console.log(`[AgentGraph] CreatePlan request failed: attempt=${attempt}/${1 + MAX_REQUEST_RETRIES} type=${errorType} httpStatus=${httpStatus ?? "n/a"} retryable=true next=retry`);
            await new Promise((r) => setTimeout(r, 300 + Math.random() * 300));
            continue;
          }

          // 最终失败
          console.error(`[AgentGraph] CreatePlan failed: attempts=${attempt} type=${errorType} httpStatus=${httpStatus ?? "n/a"} retryable=${retryable} fallback=direct`);
          break;
        }
      }

      // 降级：清理 plan 状态，但保留原始路由意图
      return new Command({
        update: {
          taskRoute: {
            executionMode: "direct" as const,
            requestedExecutionMode: "plan" as const,
            fallbackReason: "create_plan_failed",
            skillIds: state.taskRoute?.skillIds ?? [],
            reason: "Plan creation failed, fallback to direct",
          },
          taskPlan: undefined,
          currentStepId: undefined,
        },
        goto: "decide",
      });
    })
    .addNode("planVerify", async (state) => {
      deps.trace?.("planVerify", state);
      if (!deps.planVerify || !state.taskPlan || !state.currentStepId) {
        return new Command({ goto: "soul" });
      }
      const result = await deps.planVerify(state);
      const plan = state.taskPlan;
      const step = plan.steps.find((s) => s.id === state.currentStepId);
      if (!step) return new Command({ goto: "soul" });

      if (result.status === "completed") {
        step.status = "completed";
        plan.updatedAt = Date.now();
        // 查找下一个 pending 步骤
        const nextStep = plan.steps.find((s) => s.status === "pending");
        if (nextStep) {
          nextStep.executionId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          nextStep.status = "running";
          deps.onPlanUpdate?.(plan, state.replanCount);
          return new Command({
            update: { taskPlan: plan, currentStepId: nextStep.id },
            goto: "decide",
          });
        }
        // 全部完成
        plan.status = "completed";
        deps.onPlanUpdate?.(plan, state.replanCount);
        // Finalization Guard：Plan 完成后检查代码验证状态
        const guard = checkFinalizationGuard({ ...state, taskPlan: plan });
        if (guard.kind === "block") {
          return new Command({
            update: { taskPlan: plan, ...(guard.update ?? {}) },
            goto: guard.redirectTo,
          });
        }
        return new Command({
          update: {
            taskPlan: plan,
            decision: { decision: "respond" as const, reason: "plan_completed" },
            finalizationOutcome: resolveCompletionStatus({ ...state, taskPlan: plan }, guard),
          },
          goto: "soul",
        });
      }
      if (result.status === "failed") {
        step.status = "failed";
        step.failure = { message: result.failureReason ?? "步骤失败", failedAt: Date.now() };
        plan.updatedAt = Date.now();
        deps.onPlanUpdate?.(plan, state.replanCount);
        return new Command({
          update: { taskPlan: plan },
          goto: "planReplan",
        });
      }
      // running：继续当前步骤
      return new Command({ goto: "decide" });
    })
    .addNode("planReplan", async (state) => {
      deps.trace?.("planReplan", state);
      if (!deps.planReplan || !state.taskPlan || state.replanCount >= maxReplans) {
        // 重规划预算耗尽
        const plan = state.taskPlan;
        if (plan) {
          plan.status = "failed";
          plan.updatedAt = Date.now();
          deps.onPlanUpdate?.(plan, state.replanCount);
        }
        return new Command({
          update: { taskPlan: plan, decision: { decision: "respond" as const, reason: "plan_failed" } },
          goto: "soul",
        });
      }
      try {
        const replacementSteps = await deps.planReplan(state);
        const plan = state.taskPlan;
        const failedStep = plan.steps.find((s) => s.id === state.currentStepId && s.status === "failed");
        if (!failedStep) return new Command({ goto: "soul" });

        // 标记 failed 及其后 pending 步骤为 superseded
        const replacementIds = replacementSteps.map((s) => s.id);
        const failedIndex = plan.steps.indexOf(failedStep);
        failedStep.status = "superseded";
        failedStep.supersededBy = replacementIds;
        for (let i = failedIndex + 1; i < plan.steps.length; i++) {
          if (plan.steps[i].status === "pending") {
            plan.steps[i].status = "superseded";
            plan.steps[i].supersededBy = replacementIds;
          }
        }
        // 插入替代步骤
        plan.steps.splice(failedIndex + 1, 0, ...replacementSteps);
        plan.updatedAt = Date.now();

        const nextStep = replacementSteps[0];
        if (nextStep) {
          nextStep.executionId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          nextStep.status = "running";
        }
        deps.onPlanUpdate?.(plan, state.replanCount + 1);
        return new Command({
          update: {
            taskPlan: plan,
            currentStepId: nextStep?.id,
            replanCount: state.replanCount + 1,
          },
          goto: "decide",
        });
      } catch {
        // 重规划失败
        const plan = state.taskPlan;
        if (plan) {
          plan.status = "failed";
          plan.updatedAt = Date.now();
        }
        return new Command({
          update: { taskPlan: plan, decision: { decision: "respond" as const, reason: "replan_failed" } },
          goto: "soul",
        });
      }
    })
    .addNode("soul", async (state) => {
      deps.trace?.("soul", state);
      if (!state.decision || state.decision.decision === "act") {
        throw new Error("E_AGENT_GRAPH_INVALID_SOUL_STATE");
      }
      return { reply: await deps.respond(state, state.decision) };
    })
    .addEdge(START, "route")
    .addConditionalEdges("route", (state) => {
      const mode = state.taskRoute?.executionMode;
      const hasCreatePlan = !!deps.createPlan;
      if (mode === "plan" && hasCreatePlan) {
        console.log("[AgentGraph] Route transition: executionMode=plan next=createPlan");
        return "createPlan";
      }
      if (mode === "plan" && !hasCreatePlan) {
        console.warn("[AgentGraph] Route transition: executionMode=plan but createPlan dep missing, falling back to decide");
      }
      return "decide";
    })
    .addEdge("createPlan", "decide")
    .addConditionalEdges("decide", (state) => {
      if (state.decision?.decision === "act") return "execute";
      if (state.decision?.decision === "ask_user" && deps.askUser) return "askUser";
      if (state.decision?.decision === "failure"
        && state.decision.disposition === "refresh_state"
        && state.refreshCount < maxRefresh) {
        return "refresh";
      }
      return "soul";
    })
    .addEdge("execute", "routeAfterTool")
    .addEdge("refresh", "decide")
    .addEdge("soul", END)
    .compile();
  compileTimer.end();

  const invokeTimer = perf.begin("graph_invoke");
  const result = await graph.invoke({
    ...input,
    decision: undefined,
    currentAction: undefined,
    toolResults: [],
    clarificationAnswers: input.clarificationAnswers ?? [],
    iterationCount: 0,
    refreshCount: 0,
    lastGateFailure: undefined,
    taskRoute: undefined,
    taskPlan: undefined,
    currentStepId: undefined,
    replanCount: 0,
    resumePlanAfterDirect: undefined,
    reply: "",
  }, {
    // route + decide + execute + routeAfterTool + planVerify/planReplan 消耗多个 superstep。
    recursionLimit: maxIterations * 4 + 12,
  });
  invokeTimer.end();
  return result;
}
