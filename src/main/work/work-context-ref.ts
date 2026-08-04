import { randomUUID } from "crypto";

interface WorkContextRefEntry<T> {
  ref: string;
  sessionId: string;
  kind: string;
  value: T;
  expiresAt: number;
}

export class WorkContextRefRegistry {
  private readonly entries = new Map<string, WorkContextRefEntry<unknown>>();

  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly maxEntries = 256,
    private readonly now: () => number = Date.now,
  ) {}

  register<T>(sessionId: string, kind: string, value: T): string {
    this.evict();
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
    const ref = `workref_${randomUUID()}`;
    this.entries.set(ref, {
      ref,
      sessionId,
      kind,
      value: structuredClone(value),
      expiresAt: this.now() + this.ttlMs,
    });
    return ref;
  }

  resolve<T>(ref: string, sessionId: string, expectedKind?: string): T {
    const entry = this.entries.get(ref);
    if (!entry) throw new Error("E_WORK_REF_NOT_FOUND");
    if (entry.sessionId !== sessionId) throw new Error("E_WORK_REF_SESSION_MISMATCH");
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(ref);
      throw new Error("E_WORK_REF_EXPIRED");
    }
    if (expectedKind && entry.kind !== expectedKind) throw new Error("E_WORK_REF_KIND_MISMATCH");
    return structuredClone(entry.value) as T;
  }

  clearSession(sessionId: string): void {
    for (const [ref, entry] of this.entries) {
      if (entry.sessionId === sessionId) this.entries.delete(ref);
    }
  }

  private evict(): void {
    const now = this.now();
    for (const [ref, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(ref);
    }
  }
}

export const workContextRefs = new WorkContextRefRegistry();
