import type { ModelFailureInfo } from "../../shared/model-error";

/**
 * 结构化 Agent 运行时错误（修订第 3 点）。
 *
 * 用 `code` 字段区分错误类型，避免下游靠 `message.startsWith("E_...")` 解析文本。
 * AgUiBridge 据此把 `code` 透传给 renderer，renderer 据此显示不同文案。
 */
export type AgentErrorCode =
  | "E_AGENT_NO_PROGRESS"
  | "E_AGENT_GRAPH_ITERATION_LIMIT"
  | "E_MODEL_REQUEST_FAILED"
  | "E_MODEL_REQUEST_TIMEOUT"
  | "E_MODEL_HTTP_ERROR"
  | "E_MODEL_RESPONSE_PARSE_FAILED";

export class AgentRuntimeError extends Error {
  constructor(
    public readonly code: AgentErrorCode,
    message: string,
    options?: ErrorOptions & { modelFailure?: ModelFailureInfo; retryAfterMs?: number },
  ) {
    super(message, options);
    this.name = "AgentRuntimeError";
    this.modelFailure = options?.modelFailure;
    this.retryAfterMs = options?.retryAfterMs;
  }
  public readonly modelFailure?: ModelFailureInfo;
  /** 内部重试元数据；不透传给 renderer。 */
  public readonly retryAfterMs?: number;
}
