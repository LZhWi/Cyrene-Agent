export interface WorkExecutionOutcome {
  status: "succeeded" | "failed";
  toolId: string;
  output: string;
  contextRef?: string;
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]),
  );
}

function fingerprint(toolId: string, args: Record<string, unknown>): string {
  return JSON.stringify(stable({ toolId, args }));
}

export class WorkExecutionLedger {
  private readonly succeeded = new Map<string, WorkExecutionOutcome>();

  async execute(
    toolId: string,
    args: Record<string, unknown>,
    run: () => Promise<WorkExecutionOutcome>,
  ): Promise<{ outcome: WorkExecutionOutcome; cached: boolean }> {
    const key = fingerprint(toolId, args);
    const cached = this.succeeded.get(key);
    if (cached) return { outcome: { ...cached }, cached: true };
    const outcome = await run();
    if (outcome.status === "succeeded") this.succeeded.set(key, { ...outcome });
    return { outcome, cached: false };
  }
}
