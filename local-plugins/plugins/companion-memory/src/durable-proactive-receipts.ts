import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";

const KEY = "isolated-proactive-prompt-receipts";
const MAX_PENDING = 128;
interface Receipt { includedMemoryIds: string[]; recalledMemoryIds: string[] }
interface Record { runId: string; receipt: Receipt; accepted: boolean }
interface Ledger { version: 1; pending: Record[] }
export interface ProactiveSource {
  runId: string;
  pluginId: "companion-chat";
  conversationId: string;
  messageId: string;
  assistantEntryId: string;
  status: "delivered";
  deliveredAt: number;
}
export type ProactiveLifecycle =
  | { runId: string; state: "delivered"; source: ProactiveSource; delivery: { conversationId: string; messageId: string; at: string; deliveredText: string } }
  | { runId: string; state: "invalidated" | "abandoned"; proofId: string }
  | { runId: string; state: "inflight" | "unknown" };
export interface ProactiveTransaction {
  assertHealthy(): void;
  run<T>(operation: () => T, guard?: { proactiveSource: ProactiveSource } | { proactiveSourceAbsent: string } | { proactiveTerminal: ProactiveLifecycle }): T;
}
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 500;
const validReceipt = (receipt: any): receipt is Receipt => receipt && [receipt.includedMemoryIds, receipt.recalledMemoryIds]
  .every(ids => Array.isArray(ids) && ids.length <= 20_000 && ids.every(validId));
const validSource = (source: any, runId: string): source is ProactiveSource => source && source.runId === runId
  && source.pluginId === "companion-chat" && source.status === "delivered"
  && [source.runId, source.conversationId, source.messageId, source.assistantEntryId].every(validId)
  && Number.isFinite(source.deliveredAt) && source.deliveredAt >= 0;

/** Isolation only: prompt use must be accepted before generation and proved by a durable delivery. */
export function createDurableProactiveReceipts(
  storage: PluginStorage,
  transaction: ProactiveTransaction,
  readSource: (runId: string) => Promise<ProactiveSource | null>,
  apply: (receipt: Receipt, deliveredAt: number) => void,
  readLifecycle?: (runId: string) => Promise<ProactiveLifecycle>,
) {
  function load(): Ledger {
    transaction.assertHealthy();
    const value = storage.get<Ledger>(KEY);
    if (value === undefined) return { version: 1, pending: [] };
    if (!value || value.version !== 1 || !Array.isArray(value.pending) || value.pending.length > MAX_PENDING
      || new Set(value.pending.map(row => row?.runId)).size !== value.pending.length
      || value.pending.some(row => !row || !validId(row.runId) || !validReceipt(row.receipt) || typeof row.accepted !== "boolean")) {
      throw new Error("SQLITE_PROACTIVE_RECEIPTS_CORRUPT");
    }
    return structuredClone(value);
  }
  const save = (pending: Record[]) => storage.set(KEY, { version: 1, pending });
  async function commit(runId: string): Promise<boolean> {
    if (!load().pending.some(item => item.runId === runId)) return false;
    let state: ProactiveLifecycle | undefined, source: ProactiveSource | null;
    try {
      state = await readLifecycle?.(runId);
      source = readLifecycle ? state?.runId === runId && state.state === "delivered" ? state.source : null : await readSource(runId);
    } catch { return false; } // Unavailable evidence is not evidence of non-delivery.
    const row = load().pending.find(item => item.runId === runId);
    if (!row) return false;
    const terminal = state?.runId === runId && (state.state === "invalidated" || state.state === "abandoned") && validId(state.proofId);
    if (state && terminal) {
      transaction.run(() => save(load().pending.filter(item => item.runId !== runId)), { proactiveTerminal: state });
      return false;
    }
    if (!validSource(source, runId)) return false;
    if (!row.accepted) {
      transaction.run(() => save(load().pending.filter(item => item.runId !== runId)),
        state ? { proactiveTerminal: state } : { proactiveSource: source });
      return false;
    }
    return transaction.run(() => {
      const ledger = load(), current = ledger.pending.find(item => item.runId === runId);
      if (!current) return false;
      if (JSON.stringify(current) !== JSON.stringify(row)) throw new Error("SQLITE_PROACTIVE_RECEIPT_CHANGED");
      apply(row.receipt, source.deliveredAt);
      save(ledger.pending.filter(item => item.runId !== runId));
      return true;
    }, { proactiveSource: source });
  }
  return {
    prepare(runId: string, receipt: Receipt) {
      if (!validId(runId) || !validReceipt(receipt)) throw new Error("SQLITE_PROACTIVE_RECEIPT_INVALID");
      const ledger = load(), previous = ledger.pending.find(item => item.runId === runId);
      const row: Record = { runId, receipt: { includedMemoryIds: [...receipt.includedMemoryIds], recalledMemoryIds: [...receipt.recalledMemoryIds] }, accepted: false };
      if (previous?.accepted) {
        if (JSON.stringify(previous.receipt) !== JSON.stringify(row.receipt)) throw new Error("SQLITE_PROACTIVE_ACCEPTED_RECEIPT_CHANGED");
        return;
      }
      const pending = ledger.pending.filter(item => item.runId !== runId);
      if (pending.length >= MAX_PENDING) throw new Error("SQLITE_PROACTIVE_RECEIPTS_FULL");
      transaction.run(() => save([...pending, row]), { proactiveSourceAbsent: runId });
    },
    accept(runId: string) {
      const ledger = load(), row = ledger.pending.find(item => item.runId === runId);
      if (!row) throw new Error("SQLITE_PROACTIVE_RECEIPT_MISSING");
      if (!row.accepted) {
        row.accepted = true;
        transaction.run(() => save(ledger.pending), { proactiveSourceAbsent: runId });
      }
      return true;
    },
    commit,
    async discard(runId: string) {
      await commit(runId);
      return !load().pending.some(item => item.runId === runId);
    },
    async recover() {
      let committed = 0;
      for (const row of load().pending) if (await commit(row.runId)) committed += 1;
      return committed;
    },
    view() { const pending = load().pending; return { pending: pending.length, accepted: pending.filter(row => row.accepted).length }; },
  };
}
