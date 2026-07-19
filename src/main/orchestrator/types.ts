// Orchestrator types

// ToolCallResult: 单次工具调用的结果
export interface ToolCallResult {
  toolId: string;
  args: Record<string, unknown>;
  output: string;
  status: "succeeded" | "failed";
  errorCode?: string;
}

export interface ToolExecutionOutcome {
  output: string;
  status: "succeeded" | "failed";
  errorCode?: string;
}
