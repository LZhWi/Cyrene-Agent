import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";

export interface ChatPromptSource {
  conversationId: string; runId: string; userTurnId: string; assistantTurnId: string;
  userEntryId: string; assistantEntryId?: string; status: string;
}
export interface ProactiveSource {
  runId: string; pluginId: "companion-chat"; conversationId: string; messageId: string;
  assistantEntryId: string; status: "delivered"; deliveredAt: number;
}
export type ProactiveLifecycle =
  | { runId: string; state: "delivered"; source: ProactiveSource; delivery: { conversationId: string; messageId: string; at: string; deliveredText: string } }
  | { runId: string; state: "invalidated" | "abandoned"; proofId: string }
  | { runId: string; state: "inflight" | "unknown" };
export type PromptLifecycle =
  | { conversationId: string; runId: string; state: "terminal"; status: "failed" | "cancelled" | "interrupted"; proofId: string }
  | { conversationId: string; runId: string; state: "completed" | "inflight" | "unknown" };
export interface ChatIsolationSources {
  readPromptSource(conversationId: string, runId: string): Promise<ChatPromptSource | null>;
  readProactiveSource(runId: string): Promise<ProactiveSource | null>;
  readProactiveLifecycle?(runId: string): Promise<ProactiveLifecycle>;
  readPromptLifecycle?(conversationId: string, runId: string): Promise<PromptLifecycle>;
}
export interface ChatIsolationTransaction {
  assertHealthy(): void;
  run<T>(operation: () => T, guard?: ChatPromptSource | { proactiveSource: ProactiveSource } | { proactiveSourceAbsent: string }
    | { proactiveTerminal: ProactiveLifecycle } | { promptTerminal: PromptLifecycle }): T;
}
interface Worldbook {
  pendingSnapshot(runId: string): unknown;
  restorePending(runId: string, value: unknown, accepted: boolean): boolean;
  commit(runId: string): boolean;
  discard(runId: string): void;
}
interface Life {
  conversationOffer(runId: string): unknown;
  restoreConversationOffer(runId: string, value: unknown): boolean;
  applyConversationUpdate(runId: string, raw: string, messageId: string | null): boolean;
  discardConversationUpdate(runId: string): void;
}
interface Row {
  runId: string; kind: "desktop" | "proactive"; source?: ChatPromptSource;
  worldbook?: { pending: unknown; accepted: boolean };
  life?: unknown;
}
const KEY = "isolated-chat-context-receipts", MAX_PENDING = 128;
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 500;
const validSource = (v: any): v is ChatPromptSource => v && [v.conversationId, v.runId, v.userTurnId, v.assistantTurnId, v.userEntryId, v.status].every(id)
  && (v.assistantEntryId === undefined || id(v.assistantEntryId));
const sameSource = (a: ChatPromptSource, b: ChatPromptSource) => ["conversationId", "runId", "userTurnId", "assistantTurnId", "userEntryId"]
  .every(key => a[key as keyof ChatPromptSource] === b[key as keyof ChatPromptSource]);
const delivered = (v: any, runId: string): v is ProactiveSource => v && v.runId === runId && v.pluginId === "companion-chat" && v.status === "delivered"
  && [v.conversationId, v.messageId, v.assistantEntryId].every(id) && Number.isFinite(v.deliveredAt) && v.deliveredAt >= 0;

/** Isolated Chat-owned receipts. No memory-plugin state or retrieval policy is shared. */
export function createDurableChatContexts(storage: PluginStorage, transaction: ChatIsolationTransaction,
  sources: ChatIsolationSources, worldbook: Worldbook, life: Life) {
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const work = tail.then(operation); tail = work.catch(() => {}); return work;
  };
  function load(): Row[] {
    transaction.assertHealthy();
    const value = storage.get<{ version: number; pending: Row[] }>(KEY);
    if (value === undefined) return [];
    if (value.version !== 1 || !Array.isArray(value.pending) || value.pending.length > MAX_PENDING
      || new Set(value.pending.map(row => row?.runId)).size !== value.pending.length
      || value.pending.some(row => !row || !id(row.runId) || !["desktop", "proactive"].includes(row.kind)
        || (row.kind === "desktop" && (!validSource(row.source) || row.source.runId !== row.runId))
        || (row.kind === "proactive" && (row.source !== undefined || row.life !== undefined))
        || (row.worldbook !== undefined && (!row.worldbook || typeof row.worldbook.accepted !== "boolean" || !row.worldbook.pending))
        || (row.worldbook === undefined && row.life === undefined))) throw new Error("SQLITE_CHAT_RECEIPTS_CORRUPT");
    return structuredClone(value.pending);
  }
  const save = (pending: Row[]) => storage.set(KEY, { version: 1, pending });
  function remove(runId: string) {
    const rows = load();
    if (rows.some(row => row.runId === runId)) save(rows.filter(row => row.runId !== runId));
    worldbook.discard(runId); life.discardConversationUpdate(runId);
  }
  function put(row: Row) {
    const rows = load().filter(item => item.runId !== row.runId);
    if (rows.length >= MAX_PENDING) throw new Error("SQLITE_CHAT_RECEIPTS_FULL");
    save([...rows, row]);
  }
  async function current(conversationId: string, runId: string) {
    const source = await sources.readPromptSource(conversationId, runId);
    if (!validSource(source) || source.conversationId !== conversationId || source.runId !== runId
      || !["prepared", "running"].includes(source.status)) throw new Error("SQLITE_CHAT_PROMPT_SOURCE_STALE");
    return source;
  }
  async function commitProactive(runId: string) {
    const row = load().find(item => item.runId === runId && item.kind === "proactive");
    if (!row) return false;
    let state: ProactiveLifecycle | undefined, source: ProactiveSource | null;
    try {
      state = await sources.readProactiveLifecycle?.(runId);
      source = sources.readProactiveLifecycle ? state?.runId === runId && state.state === "delivered" ? state.source : null : await sources.readProactiveSource(runId);
    } catch { return false; }
    if (state?.runId === runId && (state.state === "invalidated" || state.state === "abandoned") && id(state.proofId)) {
      transaction.run(() => remove(runId), { proactiveTerminal: state }); return false;
    }
    if (!delivered(source, runId)) return false;
    if (!row.worldbook?.accepted) {
      transaction.run(() => remove(runId), state ? { proactiveTerminal: state } : { proactiveSource: source }); return false;
    }
    if (JSON.stringify(load().find(item => item.runId === runId)) !== JSON.stringify(row)) throw new Error("SQLITE_CHAT_RECEIPT_CHANGED");
    return transaction.run(() => {
      if (worldbook.restorePending(runId, row.worldbook!.pending, true)) worldbook.commit(runId);
      remove(runId); return true;
    }, { proactiveSource: source });
  }
  async function retireDesktop(row: Row) {
    if (!sources.readPromptLifecycle || !row.source) return false;
    let state: PromptLifecycle;
    try { state = await sources.readPromptLifecycle(row.source.conversationId, row.runId); } catch { return false; }
    if (!state || state.conversationId !== row.source.conversationId || state.runId !== row.runId || state.state !== "terminal"
      || !["failed", "cancelled", "interrupted"].includes(state.status) || !id(state.proofId)) return false;
    transaction.run(() => remove(row.runId), { promptTerminal: state }); return true;
  }
  return {
    prepareDesktop: (conversationId: string, runId: string, kind: "worldbook" | "life") => serial(async () => {
      const source = await current(conversationId, runId), rows = load();
      const prior = rows.find(row => row.runId === runId);
      if (prior && (prior.kind !== "desktop" || !sameSource(prior.source!, source))) throw new Error("SQLITE_CHAT_RECEIPT_SOURCE_CHANGED");
      const value = kind === "worldbook" ? worldbook.pendingSnapshot(runId) : life.conversationOffer(runId);
      if (value === undefined) return;
      if (kind === "worldbook" && prior?.worldbook?.accepted) {
        if (JSON.stringify(prior.worldbook.pending) !== JSON.stringify(value)) throw new Error("SQLITE_CHAT_ACCEPTED_RECEIPT_CHANGED");
        return;
      }
      transaction.run(() => put({ ...prior, runId, kind: "desktop", source,
        ...(kind === "worldbook" ? { worldbook: { pending: value, accepted: false } } : { life: value }) }), source);
    }),
    prepareProactive: (runId: string) => serial(async () => {
      const pending = worldbook.pendingSnapshot(runId);
      if (pending === undefined) return;
      if (load().some(row => row.runId === runId)) throw new Error("SQLITE_CHAT_PROACTIVE_RUN_REUSED");
      transaction.run(() => put({ runId, kind: "proactive", worldbook: { pending, accepted: false } }), { proactiveSourceAbsent: runId });
    }),
    accept: (runId: string, kind: "desktop" | "proactive", complete = true) => serial(async () => {
      const row = load().find(item => item.runId === runId && item.kind === kind);
      if (!row?.worldbook || !complete || row.worldbook.accepted) return;
      row.worldbook.accepted = true;
      if (kind === "proactive") transaction.run(() => put(row), { proactiveSourceAbsent: runId });
      else {
        const source = await current(row.source!.conversationId, runId);
        if (!sameSource(row.source!, source)) throw new Error("SQLITE_CHAT_RECEIPT_SOURCE_CHANGED");
        transaction.run(() => put(row), source);
      }
    }),
    finishDesktop: (event: { runId?: string; conversationId: string; inputMessageId: string; finalMessageId?: string; status: string; source: string; mode: string; chatBackend?: string; companionLifeUpdate?: string }) => serial(async () => {
      const row = load().find(item => item.runId === event.runId && item.kind === "desktop");
      if (!row) return false;
      if (event.source !== "desktop" || event.mode !== "chat" || event.chatBackend !== "companion") return false;
      if (event.status !== "success") { await retireDesktop(row); return false; }
      let source: ChatPromptSource | null;
      try { source = await sources.readPromptSource(row.source!.conversationId, row.runId); } catch { return false; }
      if (!validSource(source) || !sameSource(row.source!, source) || source.status !== "completed" || !source.assistantEntryId
        || source.conversationId !== event.conversationId || source.userTurnId !== event.inputMessageId || source.assistantTurnId !== event.finalMessageId) { await retireDesktop(row); return false; }
      if (JSON.stringify(load().find(item => item.runId === row.runId)) !== JSON.stringify(row)) throw new Error("SQLITE_CHAT_RECEIPT_CHANGED");
      return transaction.run(() => {
        // Life retains its existing successful-turn + planToken contract; it has no accepted receipt.
        if (row.life !== undefined && event.companionLifeUpdate && life.restoreConversationOffer(row.runId, row.life)) {
          life.applyConversationUpdate(row.runId, event.companionLifeUpdate, event.finalMessageId!);
        }
        if (row.worldbook?.accepted && worldbook.restorePending(row.runId, row.worldbook.pending, true)) worldbook.commit(row.runId);
        remove(row.runId); return true;
      }, source);
    }),
    commitProactive: (runId: string) => serial(() => commitProactive(runId)),
    discardProactive: (runId: string) => serial(() => commitProactive(runId)),
    invalidate: (conversationId: string, allMessages: boolean, messageIds: string[]) => serial(async () => {
      const ids = new Set(messageIds);
      for (const row of load()) if (row.kind === "desktop" && row.source!.conversationId === conversationId
        && (allMessages || ids.has(row.source!.userTurnId) || ids.has(row.source!.assistantTurnId))) remove(row.runId);
    }),
    recover: () => serial(async () => {
      for (const row of load()) {
        if (row.kind === "proactive") { await commitProactive(row.runId); continue; }
        await retireDesktop(row);
        // Completed desktop work waits for its real durable turn event, never a synthesized reply.
      }
    }),
    async whenIdle() { for (;;) { const observed = tail; await observed; if (observed === tail) return; } },
    view() { const pending = load(); return { pending: pending.length, proactive: pending.filter(row => row.kind === "proactive").length }; },
  };
}
