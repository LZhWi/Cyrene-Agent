/**
 * Cline 适配层 - 类型定义
 *
 * 设计文档: docs/delegate-coding-design.md v2
 */

// ── 输入 ──────────────────────────────────────────────────

export interface DelegateCodingInput {
  /** 代码任务描述（必须） */
  task: string;
  /** 项目根目录绝对路径（必须，会做 realpath 解析） */
  workspaceRoot: string;
  /** 附加上下文 */
  context?: {
    originalQuery?: string;
    relatedFiles?: string[];
    constraints?: string[];
  };
  /** 预算 */
  budget?: {
    maxIterations?: number;
    timeoutMs?: number;
  };
  /** 验证命令白名单（executable + args 精确匹配） */
  allowedCommands?: CommandAllowList;
}

export interface CommandAllowList {
  executables: CommandAllowEntry[];
}

export interface CommandAllowEntry {
  /** 可执行文件名或绝对路径，如 "npx" */
  name: string;
  /** 允许的参数组合，如 [["tsc", "--noEmit"]] */
  allowedArgs: string[][];
}

// ── 输出 ──────────────────────────────────────────────────

export interface CodingAgentResult {
  status: "completed" | "failed" | "cancelled";
  summary: string;
  workspaceRoot: string;
  changedFiles: string[];
  commands: CommandRecord[];
  verification: VerificationResult;
  error?: { code: string; message: string };
  usage?: { inputTokens: number; outputTokens: number; totalCost: number };
  /** 部分变更标记：status=failed/cancelled 但已有文件修改或命令执行时为 true */
  partialChanges: boolean;
}

export interface CommandRecord {
  command: string;
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
}

export interface VerificationResult {
  attempted: boolean;
  passed: boolean;
  details?: string;
}

// ── 内部状态 ──────────────────────────────────────────────

export interface StreamState {
  workspaceRoot: string;
  currentMessageId: string | null;
  currentContentType: "text" | "reasoning" | "tool" | null;
  textMessageOpen: boolean;
  thinkFilter: { insideThink: boolean; buffer: string };
  toolCalls: Map<string, ToolCallRecord>;
  changedFiles: Set<string>;
  commands: CommandRecord[];
  iterationCount: number;
  /** 保守标记：工具获得执行批准时就设为 true */
  hasPotentialSideEffects: boolean;
  summary: string;
  usage: { inputTokens: number; outputTokens: number; totalCost: number };
}

export interface ToolCallRecord {
  toolName: string;
  toolCallId: string;
  input: unknown;
  output?: unknown;
  error?: string;
  durationMs?: number;
  startedAt: number;
}

// ── 错误码 ──────────────────────────────────────────────

export type ClineErrorCode =
  | "CLINE_INIT_FAILED"
  | "CLINE_MODULE_LOAD_FAILED"
  | "CLINE_TIMEOUT"
  | "CLINE_MODEL_ERROR"
  | "CLINE_CANCELLED"
  | "CLINE_TOOL_ERROR"
  | "CLINE_MAX_ITERATIONS"
  | "CLINE_VERIFICATION_NOT_RUN"
  | "WORKSPACE_LOCKED"
  | "CLINE_UNKNOWN";
