export type UnifiedStreamDelta =
  | { type: "reasoning_delta"; delta: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_start"; index: number; id?: string; nameDelta?: string }
  | { type: "tool_call_arguments_delta"; index: number; id?: string; delta: string }
  | { type: "tool_call_end"; index: number; id?: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "finish"; reason: string }
  | { type: "refusal"; reason?: string };

export interface StreamAccumulatorSnapshot {
  text: string;
  thinking?: string;
  toolCalls: ReadonlyArray<{
    index: number;
    id?: string;
    name: string;
    arguments: string;
    ended: boolean;
  }>;
  finishReason?: string;
  refusal?: string;
  usage?: { input: number; output: number };
}

export type ProviderProtocolErrorCode =
  | "E_TOOL_CALL_ID_CHANGED"
  | "E_TOOL_CALL_INCOMPLETE"
  | "E_STREAM_TERMINAL_MISMATCH"
  | "E_UNSUPPORTED_STREAM_EVENT";

export class ProviderProtocolError extends Error {
  constructor(
    readonly code: ProviderProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProviderProtocolError";
  }
}
