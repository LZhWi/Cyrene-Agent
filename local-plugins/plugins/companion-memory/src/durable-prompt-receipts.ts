import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";

const KEY = "isolated-native-prompt-receipts";
const MAX_PENDING = 128;
export interface PromptSource {
  conversationId: string;
  runId: string;
  userTurnId: string;
  assistantTurnId: string;
  userEntryId: string;
  assistantEntryId?: string;
  status: string;
}
export interface IsolationTransaction {
  assertHealthy(): void;
  run<T>(operation: () => T, guard?: PromptSource | { promptTerminal: PromptLifecycle }): T;
}
export type PromptLifecycle =
  | { conversationId: string; runId: string; state: "terminal"; status: "failed" | "cancelled" | "interrupted"; proofId: string }
  | { conversationId: string; runId: string; state: "completed" | "inflight" | "unknown" };
interface Receipt { includedMemoryIds: string[]; recalledMemoryIds: string[] }
interface ColdCandidate { id: string; content: string; sourceAt: number; quote: string; evidence: string; status: "pending" }
interface Cold { queryHash: string; candidates: ColdCandidate[] }
interface Record { source: PromptSource; receipt: Receipt; cold?: Cold; accepted: boolean }
interface Ledger { version: 1; pending: Record[] }
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 500;
const validSource = (source: any): source is PromptSource => source && [source.conversationId, source.runId, source.userTurnId, source.assistantTurnId, source.userEntryId, source.status].every(validId)
  && (source.assistantEntryId === undefined || validId(source.assistantEntryId));
const sameSource = (a: PromptSource, b: PromptSource) => ["conversationId", "runId", "userTurnId", "assistantTurnId", "userEntryId"].every(key => a[key as keyof PromptSource] === b[key as keyof PromptSource]);

/** Isolated only. The host transaction atomically commits every synchronous owner write and removal of this receipt. */
export function createDurablePromptReceipts(
  storage: PluginStorage,
  transaction: IsolationTransaction,
  readSource: (conversationId: string, runId: string) => Promise<PromptSource | null>,
  readLifecycle: ((conversationId: string, runId: string) => Promise<PromptLifecycle>) | undefined = (storage as any).isolationSources?.readPromptLifecycle,
) {
  function load(): Ledger {
    transaction.assertHealthy();
    const value = storage.get<Ledger>(KEY);
    if (value === undefined) return { version: 1, pending: [] };
    if (value.version !== 1 || !Array.isArray(value.pending) || value.pending.length > MAX_PENDING
      || new Set(value.pending.map(row => row?.source?.runId)).size !== value.pending.length
      || value.pending.some(row => !row || !validSource(row.source) || typeof row.accepted !== "boolean"
        || !row.receipt || [row.receipt.includedMemoryIds, row.receipt.recalledMemoryIds].some(ids => !Array.isArray(ids) || ids.length > 20_000 || ids.some(id => !validId(id)))
        || (row.cold !== undefined && (!row.cold || typeof row.cold.queryHash !== "string" || !/^[0-9a-f]{64}$/.test(row.cold.queryHash)
          || !Array.isArray(row.cold.candidates) || row.cold.candidates.length > 2
          || row.cold.candidates.some(candidate => !candidate || !validId(candidate.id) || typeof candidate.content !== "string"
            || !Number.isFinite(candidate.sourceAt) || typeof candidate.quote !== "string" || typeof candidate.evidence !== "string" || candidate.status !== "pending"))))) {
      throw new Error("SQLITE_PROMPT_RECEIPTS_CORRUPT");
    }
    return structuredClone(value);
  }
  const save = (pending: Record[]) => storage.set(KEY, { version: 1, pending });
  async function retireTerminal(row: Record) {
    if (!readLifecycle) return false;
    let state: PromptLifecycle;
    try { state = await readLifecycle(row.source.conversationId, row.source.runId); } catch { return false; }
    if (!state || state.conversationId !== row.source.conversationId || state.runId !== row.source.runId || state.state !== "terminal"
      || !["failed", "cancelled", "interrupted"].includes(state.status) || !validId(state.proofId)) return false;
    if (!load().pending.some(item => item.source.runId === row.source.runId)) return false;
    return transaction.run(() => { save(load().pending.filter(item => item.source.runId !== row.source.runId)); return true; }, { promptTerminal: state });
  }
  return {
    async source(conversationId: string, runId: string) {
      transaction.assertHealthy();
      const source = await readSource(conversationId, runId);
      if (!validSource(source) || source.conversationId !== conversationId || source.runId !== runId
        || !["prepared", "running"].includes(source.status)) throw new Error("SQLITE_PROMPT_SOURCE_UNAVAILABLE");
      return source;
    },
    async prepare(source: PromptSource, receipt: Receipt, cold?: Cold) {
      transaction.assertHealthy();
      const current = await readSource(source.conversationId, source.runId);
      if (!current || !sameSource(source, current) || !["prepared", "running"].includes(current.status)) throw new Error("SQLITE_PROMPT_SOURCE_STALE");
      const ledger = load(), row: Record = { source, receipt, ...(cold?.candidates.length ? { cold } : {}), accepted: false };
      const previous = ledger.pending.find(item => item.source.runId === source.runId);
      if (previous?.accepted) {
        if (JSON.stringify({ ...previous, accepted: false }) !== JSON.stringify(row)) throw new Error("SQLITE_PROMPT_ACCEPTED_RECEIPT_CHANGED");
        return;
      }
      const pending = ledger.pending.filter(item => item.source.runId !== source.runId);
      if (pending.length >= MAX_PENDING) throw new Error("SQLITE_PROMPT_RECEIPTS_FULL");
      save([...pending, row]);
    },
    accept(runId: string, complete: boolean) {
      const ledger = load(), row = ledger.pending.find(item => item.source.runId === runId);
      if (!row || !complete || row.accepted) return;
      row.accepted = true;
      save(ledger.pending);
    },
    async finish(event: { runId?: string; conversationId: string; inputMessageId: string; finalMessageId?: string; status: string; source: string; mode: string; chatBackend?: string }, apply: (receipt: Receipt, cold?: Cold) => void) {
      const ledger = load(), row = ledger.pending.find(item => item.source.runId === event.runId);
      if (!row) return false;
      const discard = () => save(load().pending.filter(item => item.source.runId !== event.runId));
      if (event.source !== "desktop" || event.mode !== "chat" || event.chatBackend !== "companion") return false;
      if (event.status !== "success") {
        await retireTerminal(row);
        return false;
      }
      let source: PromptSource | null;
      try { source = await readSource(row.source.conversationId, row.source.runId); } catch { return false; }
      if (!source || !sameSource(row.source, source) || source.status !== "completed" || !source.assistantEntryId
        || event.conversationId !== source.conversationId || event.inputMessageId !== source.userTurnId || event.finalMessageId !== source.assistantTurnId) {
        await retireTerminal(row);
        return false;
      }
      // A source-invalidation event may have removed this row while readSource awaited.
      // With no remaining work, do not enter a stale-source transaction or poison the owner.
      if (!load().pending.some(item => item.source.runId === event.runId)) return false;
      return transaction.run(() => {
        const current = load().pending.find(item => item.source.runId === event.runId);
        if (!current) return false;
        if (JSON.stringify(current) !== JSON.stringify(row)) throw new Error("SQLITE_PROMPT_RECEIPT_CHANGED");
        if (row.accepted) apply(row.receipt, row.cold);
        discard();
        return row.accepted;
      }, source);
    },
    invalidate(conversationId: string, allMessages: boolean, messageIds: string[]) {
      const ledger = load(), ids = new Set(messageIds);
      const pending = ledger.pending.filter(row => row.source.conversationId !== conversationId
        || (!allMessages && !ids.has(row.source.userTurnId) && !ids.has(row.source.assistantTurnId)));
      if (pending.length !== ledger.pending.length) save(pending);
    },
    async cleanup() {
      let retired = 0;
      for (const row of load().pending) if (await retireTerminal(row)) retired += 1;
      return retired;
    },
    view() { const pending = load().pending; return { pending: pending.length, accepted: pending.filter(row => row.accepted).length }; },
  };
}
