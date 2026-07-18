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
}

export type SemanticTextGenerator = (
  request: SemanticGenerateRequest,
  signal?: AbortSignal,
) => Promise<string>;

export interface CitaSemanticEngine {
  understandTurn(input: TurnUnderstandingInput, signal?: AbortSignal): Promise<TurnUnderstanding>;
  observeTurn?(input: TurnObservationInput, signal?: AbortSignal): Promise<StateUpdateProposal>;
}
