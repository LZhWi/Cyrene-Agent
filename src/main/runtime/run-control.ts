import { randomUUID } from "node:crypto";
import type { ToolEffectKind } from "../orchestrator/tool-registry";

export type RunStatus = "active" | "cancelling" | "completed";
export type EffectStatus = "started" | "completed" | "failed" | "cancelled";

export interface RunEffectEntry {
  id: string;
  toolId: string;
  kind: ToolEffectKind;
  status: EffectStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

export class RunCancelledError extends Error {
  readonly code = "E_RUN_CANCELLED";

  constructor(public readonly runId: string, message = "run cancelled") {
    super(`E_RUN_CANCELLED: ${message}`);
    this.name = "RunCancelledError";
  }
}

export function isRunCancelledError(error: unknown): error is RunCancelledError {
  return error instanceof RunCancelledError
    || (error instanceof Error && error.message.startsWith("E_RUN_CANCELLED:"));
}

export class RunControl {
  readonly runId: string;
  readonly controller = new AbortController();
  private statusValue: RunStatus = "active";
  private readonly effects = new Map<string, RunEffectEntry>();

  constructor(runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`) {
    this.runId = runId;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get status(): RunStatus {
    return this.statusValue;
  }

  cancel(reason = "user requested cancellation"): boolean {
    if (this.statusValue !== "active") return false;
    this.statusValue = "cancelling";
    this.controller.abort(new RunCancelledError(this.runId, reason));
    for (const entry of this.effects.values()) {
      if (entry.status === "started") {
        entry.status = "cancelled";
        entry.finishedAt = Date.now();
      }
    }
    return true;
  }

  complete(): void {
    if (this.statusValue === "active") this.statusValue = "completed";
  }

  throwIfCancelled(): void {
    if (this.signal.aborted || this.statusValue === "cancelling") {
      throw new RunCancelledError(this.runId);
    }
  }

  startEffect(input: { id: string; toolId: string; kind: ToolEffectKind }): void {
    this.throwIfCancelled();
    if (this.effects.has(input.id)) throw new Error(`E_DUPLICATE_EFFECT: ${input.id}`);
    this.effects.set(input.id, {
      ...input,
      status: "started",
      startedAt: Date.now(),
    });
  }

  finishEffect(id: string, status: Exclude<EffectStatus, "started">, error?: string): void {
    const entry = this.effects.get(id);
    if (!entry || entry.status !== "started") return;
    entry.status = status;
    entry.finishedAt = Date.now();
    if (error) entry.error = error;
  }

  snapshot(): { runId: string; status: RunStatus; effects: RunEffectEntry[] } {
    return {
      runId: this.runId,
      status: this.statusValue,
      effects: Array.from(this.effects.values(), (entry) => ({ ...entry })),
    };
  }
}
