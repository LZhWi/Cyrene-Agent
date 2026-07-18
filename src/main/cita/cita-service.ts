import type {
  CitaSettings,
  ContextEvent,
  ContextPackage,
  ModelVisibleContext,
  TurnUnderstanding,
} from "./contracts";
import { buildCitaContextBlock } from "./context-package";
import type { ContextStore } from "./context-store";
import type { CitaSemanticEngine } from "./semantic-engine";
import { validateUnderstanding } from "./understanding-validator";

export interface CitaPrepareTurnInput {
  conversationId: string;
  turnId: string;
  originalQuery: string;
  recentDialogue: Array<{ role: "user" | "assistant"; text: string }>;
}

export interface CitaPrepareTurnResult {
  contextPackage?: ContextPackage;
  contextBlock: string;
}

interface CitaServiceInput {
  store: ContextStore;
  engine: CitaSemanticEngine;
  getSettings: () => CitaSettings;
  now?: () => number;
}

export class CitaService {
  private readonly store: ContextStore;
  private readonly engine: CitaSemanticEngine;
  private readonly getSettings: () => CitaSettings;
  private readonly now: () => number;

  constructor(input: CitaServiceInput) {
    this.store = input.store;
    this.engine = input.engine;
    this.getSettings = input.getSettings;
    this.now = input.now ?? Date.now;
  }

  ingest(event: ContextEvent): void {
    if (!this.getSettings().enabled) return;
    this.store.append(event);
  }

  async prepareTurn(input: CitaPrepareTurnInput, signal?: AbortSignal): Promise<CitaPrepareTurnResult> {
    const settings = this.getSettings();
    if (!settings.enabled) return { contextBlock: "" };

    const state = this.store.snapshot(input.conversationId);
    if (settings.semanticEngine === "local") {
      return this.buildUnavailablePackage(input, state.revision);
    }

    const understandingInput = {
      ...input,
      stateRevision: state.revision,
      availableContexts: state.contexts,
      recentEvents: this.store.recentEvents(input.conversationId),
    };

    try {
      const candidate = await this.engine.understandTurn(understandingInput, signal);
      const validation = validateUnderstanding(understandingInput, candidate, this.now());
      if (validation.status === "rejected") {
        return this.buildUnavailablePackage(input, state.revision, validation.reasons);
      }
      const contextPackage = this.toContextPackage(
        input.originalQuery,
        validation.understanding,
        state.contexts,
        state.revision,
        validation.status === "accepted" ? "ready" : "degraded",
        validation.status === "degraded" ? validation.reasons : [],
      );
      return { contextPackage, contextBlock: buildCitaContextBlock(contextPackage) };
    } catch {
      return this.buildUnavailablePackage(input, state.revision);
    }
  }

  clear(conversationId?: string): void {
    this.store.clear(conversationId);
  }

  private buildUnavailablePackage(
    input: CitaPrepareTurnInput,
    stateRevision: number,
    uncertaintyNotes: string[] = [],
  ): CitaPrepareTurnResult {
    const contextPackage: ContextPackage = {
      originalQuery: input.originalQuery,
      contextualizedQuery: input.originalQuery,
      rewriteStatus: "unchanged",
      resolvedReferences: [],
      focusedContexts: [],
      uncertaintyNotes,
      semanticStatus: "unavailable",
      stateRevision,
    };
    return { contextPackage, contextBlock: buildCitaContextBlock(contextPackage) };
  }

  private toContextPackage(
    originalQuery: string,
    understanding: TurnUnderstanding,
    contexts: ModelVisibleContext[],
    stateRevision: number,
    semanticStatus: ContextPackage["semanticStatus"],
    validationNotes: string[],
  ): ContextPackage {
    const focusedRefs = new Set([
      ...understanding.focusedEntityRefs,
      ...understanding.resolvedReferences.map((reference) => reference.targetRef),
    ]);
    return {
      originalQuery,
      contextualizedQuery: understanding.contextualizedQuery,
      rewriteStatus: understanding.rewriteStatus,
      dialogueAct: understanding.dialogueAct,
      resolvedReferences: understanding.resolvedReferences,
      focusedContexts: contexts.filter((context) => focusedRefs.has(context.contextRef)),
      uncertaintyNotes: [
        ...understanding.uncertainties.map((uncertainty) => uncertainty.description),
        ...validationNotes,
      ],
      semanticStatus,
      stateRevision,
    };
  }
}
