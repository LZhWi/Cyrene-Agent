// Orchestrator types

// ToolCallResult: 单次工具调用的结果
export interface ToolCallResult {
  toolId: string;
  args: Record<string, unknown>;
  output: string;
  status: "succeeded" | "failed";
  errorCode?: string;
  // 完成语义：该工具步骤是否已经结束（默认 true，由 normalizer 推导）
  terminal?: boolean;
  // 完成语义：失败后是否值得重试（默认 false，由 normalizer 推导）
  retryable?: boolean;
  // 本次调用未真正执行，是 ExecutionLedger 缓存命中
  deduplicated?: boolean;
  /** false means the failure happened before Tool Runtime was invoked. */
  toolExecuted?: false;
}

export interface ToolExecutionOutcome {
  output: string;
  status: "succeeded" | "failed";
  errorCode?: string;
  // 完成语义：该工具步骤是否已经结束（默认 true，由 normalizer 推导）
  terminal?: boolean;
  // 完成语义：失败后是否值得重试（默认 false，由 normalizer 推导）
  retryable?: boolean;
}
