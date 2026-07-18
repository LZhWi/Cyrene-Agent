export type ContextRef = string;

export type DialogueActType =
  | "affirm"
  | "cancel"
  | "select"
  | "request"
  | "request_explanation"
  | "inform"
  | "correct"
  | "continue"
  | "compare"
  | "comment"
  | "greet"
  | "unclear";

export interface ModelVisibleContext {
  contextRef: ContextRef;
  conversationId: string;
  domain: string;
  kind: string;
  label: string;
  attributes?: Record<string, string | string[]>;
  position?: number;
  lifecycle: "active" | "expired";
  expiresAt?: number;
  source: "tool_result" | "ui_event" | "runtime_event";
}

export interface ContextEventBase {
  eventId: string;
  conversationId: string;
  occurredAt: number;
  source: string;
}

export type ContextEvent = ContextEventBase & (
  | { type: "context_upserted"; context: ModelVisibleContext }
  | { type: "context_presented"; contextRefs: ContextRef[] }
  | { type: "tool_failed"; toolId: string; errorCode: string }
  | { type: "conversation_reset" }
);

export interface ContextState {
  conversationId: string;
  revision: number;
  updatedAt: number;
  contexts: ModelVisibleContext[];
  focusedEntityRefs: ContextRef[];
  activeDomain?: string;
  activeTopic?: string;
}

export interface StateUpdateProposal {
  baseRevision: number;
  activeDomain?: string;
  activeTopic?: string;
  focusedEntityRefs: ContextRef[];
}

export interface TurnObservationInput {
  conversationId: string;
  baseRevision: number;
  recentDialogue: Array<{ role: "user" | "assistant"; text: string }>;
  recentEvents: ContextEvent[];
}

export interface TurnUnderstandingInput {
  conversationId: string;
  turnId: string;
  stateRevision: number;
  originalQuery: string;
  availableContexts: ModelVisibleContext[];
  recentDialogue: Array<{ role: "user" | "assistant"; text: string }>;
  recentEvents: ContextEvent[];
}

export interface TurnUnderstanding {
  dialogueAct: { type: DialogueActType };
  resolvedReferences: Array<{
    surface: string;
    targetRef: ContextRef;
    relation: "direct" | "candidate_position" | "previous" | "focused" | "comparison_item";
  }>;
  topicTransition: "continue" | "switch" | "return" | "unclear";
  focusedEntityRefs: ContextRef[];
  contextualizedQuery: string;
  rewriteStatus: "unchanged" | "contextualized" | "ambiguous";
  uncertainties: Array<{
    type: "multiple_references" | "missing_context" | "expired_context" | "unclear_dialogue_act" | "topic_ambiguity";
    description: string;
  }>;
}

export interface ContextPackage {
  originalQuery: string;
  contextualizedQuery: string;
  rewriteStatus: TurnUnderstanding["rewriteStatus"];
  dialogueAct?: TurnUnderstanding["dialogueAct"];
  resolvedReferences: TurnUnderstanding["resolvedReferences"];
  focusedContexts: ModelVisibleContext[];
  uncertaintyNotes: string[];
  semanticStatus: "ready" | "degraded" | "unavailable";
  stateRevision: number;
}

export type UnderstandingValidationResult =
  | { status: "accepted"; understanding: TurnUnderstanding }
  | { status: "degraded"; understanding: TurnUnderstanding; reasons: string[] }
  | { status: "rejected"; reasons: string[] };

export interface CitaSettings {
  enabled: boolean;
  semanticEngine: "remote" | "local";
}
