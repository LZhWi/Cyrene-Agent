import type {
  StateUpdateProposal,
  TurnObservationInput,
  TurnUnderstanding,
  TurnUnderstandingInput,
} from "./contracts";

export interface SemanticGenerateRequest {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  /** Function Calling 工具定义（ToolSpec 格式）。传入时 generate 回调应将它们附加到请求。 */
  tools?: unknown[];
  /** tool_choice 模式："required" 强制调用工具，undefined 不传。 */
  toolChoice?: "required";
}

export interface SemanticGeneratorResult {
  text: string;
  /** 模型返回的工具调用列表。FC 模式下包含 submit_context_understanding 的结果。 */
  toolCalls?: Array<{ name: string; arguments: string }>;
}

export type SemanticTextGenerator = (
  request: SemanticGenerateRequest,
  signal?: AbortSignal,
) => Promise<SemanticGeneratorResult>;

export interface CitaSemanticEngine {
  understandTurn(input: TurnUnderstandingInput, signal?: AbortSignal): Promise<TurnUnderstanding>;
  observeTurn?(input: TurnObservationInput, signal?: AbortSignal): Promise<StateUpdateProposal>;
}
