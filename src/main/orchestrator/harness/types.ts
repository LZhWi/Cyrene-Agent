/**
 * CyreneHarness 核心类型定义。
 *
 * 设计依据：docs/design/2026-08-08-cyreneHarnessloopdesign.md (v3)
 *
 * 本文件只定义 Harness 特有的类型，复用现有类型：
 * - ChatMessage / ToolCall / ToolSpec 来自 vendors/types
 * - ToolDefinition 来自 tool-registry
 * - ToolCallResult 来自 orchestrator/types
 */

import type { ChatMessage, ToolCall, ToolSpec } from "../vendors/types";
import type { ToolDefinition } from "../tool-registry";
import type { CyreneRunTerminalResult } from "../../../shared/run-terminal";
import type { ToolErrorCategory } from "../tool-execution-error";
export type { ToolErrorCategory } from "../tool-execution-error";

// ── 工具调用结果 ──────────────────────────────────────────

/**
 * 工具执行结果的四态 outcome（v3 §5.5.1）。
 * - success: Runtime 明确知道工具成功
 * - failure: Runtime 明确知道工具失败
 * - unknown: Runtime 不知道工具到底怎么样了（主要是 non_idempotent timeout）
 * - not_executed: Runtime 主动决定不执行（协议性结果）
 */
export type ToolCallOutcome = "success" | "failure" | "unknown" | "not_executed";

/** 副作用分类（v3 §5.2） */
export type SideEffectKind =
  | "read_only"
  | "idempotent_mutation"
  | "non_idempotent_side_effect";

/** 重试决策 */
export type RetryDecision = "retry" | "no_retry";

/** 工具执行后的结构化 observation（v3 §5.5） */
export interface ToolObservation {
  outcome: ToolCallOutcome;
  category?: ToolErrorCategory;
  toolSideEffect?: SideEffectKind;
  retryDecision?: RetryDecision;
  retryCount?: number;
  tool: string;
  target?: string;
  message: string;
  suggestion?: string;
  /** 截断信息（v3 §5.7） */
  truncated?: boolean;
  preview?: string;
  fullOutputRef?: string;
  /** 工具返回的原始输出（未截断前），可能被截断后只保留 preview */
  output?: string;
}

// ── Uncertain Effect（v3 §5.5.1.1）───────────────────────

export interface UncertainEffect {
  id: string;
  toolCallId: string;
  fingerprint: string;
  toolName: string;
  message: string;
  repeatAuthorization?: { source: "user"; grantedAt: number };
}

// ── Todo（v3 §8）─────────────────────────────────────────

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

// ── Agent State（v3 §6.3）────────────────────────────────

export interface AgentState {
  todoItems: TodoItem[];
  uncertainEffects: UncertainEffect[];
}

// ── Harness 配置 ─────────────────────────────────────────

export interface HarnessConfig {
  /** 最大循环轮数 */
  maxRounds: number;
  /** 总超时（毫秒） */
  totalTimeoutMs: number;
  /** 用户等待超时（毫秒，ask_user 等待期间不计入执行超时） */
  userWaitTimeoutMs: number;
  /** 上下文窗口大小（token） */
  contextWindowTokens: number;
  /** 为 LLM 回复预留的 token 预算 */
  reservedOutputTokens: number;
  /** 固定安全余量（token） */
  safetyMarginTokens: number;
  /** 压缩触发阈值比例（默认 0.7） */
  compactionThreshold: number;
  /** 软截断字符数（默认 2000） */
  softTruncateChars: number;
  /** 硬熔断字符数（默认 8000） */
  hardTruncateChars: number;
}

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  maxRounds: 50,
  totalTimeoutMs: 300_000,
  userWaitTimeoutMs: 120_000,
  contextWindowTokens: 256_000,
  reservedOutputTokens: 8_192,
  safetyMarginTokens: 512,
  compactionThreshold: 0.7,
  softTruncateChars: 2_000,
  hardTruncateChars: 8_000,
};

// ── Harness 事件（给 UI / 桥层）──────────────────────────

export type HarnessEvent =
  | { type: "round_start"; roundId: string }
  | { type: "round_end"; roundId: string }
  | { type: "progress_text"; content: string }
  | { type: "final_answer"; content: string }
  | { type: "reasoning_start"; messageId: string }
  | { type: "reasoning_delta"; messageId: string; delta: string }
  | { type: "reasoning_end"; messageId: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_end"; toolCallId: string; outcome: ToolCallOutcome; preview: string }
  | { type: "todo_update"; items: TodoItem[] }
  | { type: "ask_user"; card: unknown }
  | { type: "runtime_feedback"; message: string }
  | { type: "error"; message: string };

// ── Harness 输入与输出 ───────────────────────────────────

export interface HarnessToolSpec extends ToolSpec {
  /** Harness 内置工具标记（不进 registry） */
  harnessBuiltin?: boolean;
}

export interface HarnessInput {
  /** 系统提示词（已包含人设 + Runtime Policy） */
  systemPrompt: string;
  /** 初始消息（不含 system） */
  messages: ChatMessage[];
  /** 普通工具列表（从 registry 获取） */
  tools: ToolDefinition[];
  /** 厂商适配器 ID（用于 LLM 调用） */
  vendorConfig: import("../vendors/types").VendorConfig;
  /** 配置 */
  config?: Partial<HarnessConfig>;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 事件回调 */
  onEvent?: (event: HarnessEvent) => void;
  /** 用户澄清函数（ask_user 内置工具使用） */
  requestUserClarification?: (card: unknown) => Promise<unknown>;
  /** 工具上下文（权限检查等） */
  toolContext?: import("../tool-context").ToolContext;
  /** 权限检查函数 */
  checkPermission?: (toolId: string, args: Record<string, unknown>) => Promise<boolean>;
  /** ExecutionLedger：可选的同进程工具去重缓存（v3 §5.5.1.1） */
  executionLedger?: import("../execution-ledger").ExecutionLedger;
}

export interface HarnessResult {
  /** 最终回复文本 */
  finalAnswer: string;
  /** 最终 Agent State 快照 */
  finalState: AgentState;
  /** 是否因超时/轮数上限退出（兼容字段；新消费方请改用 terminal.status） */
  terminated: boolean;
  /** 终止原因（兼容字段；新消费方请改用 terminal.reason） */
  terminateReason?: "max_rounds" | "timeout" | "cancelled" | "error";
  /**
   * Canonical 终态结算（Task 2 / C1）。
   *
   * 新消费方（CyreneAgent.runWithEvents、agui-bridge settlement gate）必须读 terminal，
   * 不要再从 terminated / terminateReason 反推：
   *  - status="success"：模型自然收尾（无 tool call 或主动结束）。
   *  - status="timeout"：reason ∈ { max_rounds, timeout }。
   *  - status="cancelled"：reason="user_cancelled"（Task 3 才会真正写入；Task 2 占位）。
   *  - status="error"：reason 来自 AgentRuntimeError.code 或工具 fatal。
   *
   * Task 2 暂由 harness-adapter 根据 terminateReason 映射填充，
   * cyrene-harness 内部仍只写 terminated / terminateReason，避免触动 P0-A 已审过的主路径。
   */
  terminal?: CyreneRunTerminalResult;
  /** 总执行轮数 */
  rounds: number;
}

// ── 辅助类型 ─────────────────────────────────────────────

/** 把 ToolCall 的 arguments JSON 字符串解析为对象 */
export function parseToolCallArgs(call: ToolCall): Record<string, unknown> {
  try {
    return JSON.parse(call.arguments) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 生成工具调用的 fingerprint（用于 uncertainEffects 重复拦截） */
export function toolCallFingerprint(toolName: string, args: Record<string, unknown>): string {
  const sortedArgs = Object.keys(args)
    .sort()
    .map((k) => `${k}=${String(args[k])}`)
    .join(",");
  return `${toolName}(${sortedArgs})`;
}
