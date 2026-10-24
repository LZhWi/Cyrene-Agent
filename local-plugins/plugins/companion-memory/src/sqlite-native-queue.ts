import { createHash } from "node:crypto";
import type { Turn } from "../../companion-chat/src/chat";
import type { NativeIntegrationSettings } from "./native-integration";

export interface SqliteQueueCapability {
  call(method: string, ...args: any[]): Promise<any>;
  register(controller: { whenIdle(): Promise<void>; retry(): Promise<void>; bootstrap(): Promise<void>; view(): unknown }): void | (() => void);
}

/** Isolation-only queue adapter. The loaded plugin remains the only memory owner. */
export function createSqliteNativeQueue(deps: {
  capability: SqliteQueueCapability;
  storage: { get<T>(key: string): T | undefined; set(key: string, value: unknown): void };
  memory: { view(): { turns: Turn[]; processed: string[] }; ingest(turn: Turn, signal?: AbortSignal): unknown };
  settings(): NativeIntegrationSettings;
  signal(): AbortSignal;
  read(task: any, signal: AbortSignal): Promise<Turn>;
  legacyTaskIsChat(task: any, signal: AbortSignal): Promise<boolean>;
  maintain(before: Turn[], pending: Turn[], signal: AbortSignal): Promise<unknown>;
  social?(turn: Turn, signal: AbortSignal): Promise<void>;
}) {
  const { capability: db } = deps;
  const OWNER = "isolated-sqlite-pending-owner";
  const RETRY_KEY = "sqlite-extraction-retry-state";
  type Retry = { batch: string; attempts: number; nextAt: number; code: string };
  const retries: Record<string, Retry> = deps.storage.get<Record<string, Retry>>(RETRY_KEY) ?? {};
  let retryTimer: ReturnType<typeof setTimeout> | undefined, disposed = false;
  const saveRetries = () => deps.storage.set(RETRY_KEY, structuredClone(retries));
  const errorCode = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("记忆已发生变化") ? "SQLITE_EXTRACTION_REVISION_CHANGED"
      : /校验|语义复核|JSON/.test(message) ? "SQLITE_EXTRACTION_VALIDATION_FAILED" : "SQLITE_EXTRACTION_FAILED";
  };
  function scheduleRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    if (disposed || deps.signal().aborted || !deps.settings().captureEnabled || !deps.settings().autoExtractEnabled) return;
    const times = Object.entries(retries).filter(([id, row]) => !id.startsWith("private:companion-chat:") && row.attempts < 2).map(([, row]) => row.nextAt);
    if (!times.length) return;
    retryTimer = setTimeout(() => { retryTimer = undefined; void controller.retry().catch(() => {}); }, Math.max(1, Math.min(...times) - Date.now()));
    retryTimer.unref?.();
  }
  let tail = Promise.resolve(), processing = 0;
  let status = { pending: 0, completed: 0 };
  const failures = new Map<string, { error: unknown; at: number; kind: "read" | "extract" }>();
  let phase: "read" | "extract" = "read";
  const check = (signal: AbortSignal) => { if (signal.aborted) throw new Error("SQLITE_NATIVE_CANCELLED"); };
  const record = (turn: Turn) => {
    const source = turn.hostSourceVersion;
    const conversationId = turn.origin === "companion-chat" ? `private:companion-chat:${turn.sessionId}` : turn.sessionId;
    if (!source || source.conversationId !== conversationId || source.userTurnId !== turn.inputMessageId
      || !source.userEntryId || !source.assistantEntryId) throw new Error("SQLITE_FROZEN_SOURCE_REQUIRED");
    return { ...source, userInput: turn.user, assistantReply: turn.assistant, pluginTurn: turn };
  };
  const decode = (row: any): Turn => {
    const turn: Turn = row.pluginTurn;
    const source = turn?.hostSourceVersion;
    if (!source || source.conversationId !== row.conversationId || source.userTurnId !== row.userTurnId
      || source.userEntryId !== row.userEntryId || source.assistantEntryId !== row.assistantEntryId
      || turn.user !== row.userInput || turn.assistant !== row.assistantReply) throw new Error("SQLITE_FROZEN_PAYLOAD_MISMATCH");
    record(turn);
    return turn;
  };
  async function refresh() {
    status = await db.call("memory.queueStatus");
    if (Object.keys(retries).length) {
      const conversations: string[] = await db.call("memory.pendingConversations");
      let changed = false;
      for (const id of Object.keys(retries)) if (!conversations.includes(id)) { delete retries[id]; changed = true; }
      if (changed) { saveRetries(); scheduleRetry(); }
    }
  }
  async function restoreCaptured(signal: AbortSignal) {
    for (const row of await db.call("memory.queueRows")) {
      check(signal);
      const turn = decode(row);
      // Both the durable ledger and memory-state keep the original event identity.
      if (!deps.memory.view().turns.some(item => item.id === turn.id)) await deps.memory.ingest(turn, signal);
    }
    await refresh();
  }
  async function bootstrap(signal: AbortSignal) {
    if (!deps.storage.get(OWNER)) {
      const state = deps.memory.view();
      const hostTurns = state.turns;
      await db.call("life.importMemoryQueue", hostTurns.map(turn => ({ ...record(turn), processed: state.processed.includes(turn.id) })));
      check(signal);
      // Old JSON tasks are migrated only after exact source-bound reads.
      const queue = deps.storage.get<any>("native-integration-queue");
      if (queue?.pending?.length && !deps.settings().captureEnabled) { await refresh(); return; }
      for (const task of queue?.pending ?? []) {
        if (!task.mode && !await deps.legacyTaskIsChat(task, signal)) continue;
        const source = task.memorySource ?? await db.call("life.memorySource", task.conversationId, task.inputMessageId);
        const turn = await deps.read({ ...task, memorySource: source }, signal);
        check(signal);
        await db.call("life.recordMemoryTurn", record(turn));
      }
      deps.storage.set(OWNER, { version: 1 });
      deps.storage.set("native-integration-queue", { version: 1, pending: [], completed: [] });
    }
    await restoreCaptured(signal);
  }
  async function extract(signal: AbortSignal, manual = false) {
    let batches = 0;
    if (!manual && (!deps.settings().captureEnabled || !deps.settings().autoExtractEnabled)) return { batches, pending: status.pending };
    phase = "extract";
    const conversations: string[] = await db.call("memory.pendingConversations");
    for (const id of Object.keys(retries)) if (!conversations.includes(id)) { delete retries[id]; saveRetries(); }
    for (const conversationId of conversations) {
      const enabled = () => conversationId.startsWith("private:companion-chat:") ? manual : deps.settings().captureEnabled && (manual || deps.settings().autoExtractEnabled);
      while (enabled()) {
        check(signal);
        const batch = await db.call("memory.batch", conversationId);
        if (!batch) { if (retries[conversationId]) { delete retries[conversationId]; saveRetries(); } break; }
        const pending = batch.pending.map(decode);
        const seq = new Set(batch.pending.map((row: any) => row.seq));
        const before = batch.turns.filter((row: any) => !seq.has(row.seq)).map(decode);
        if (!await db.call("memory.current", batch.turns)) throw new Error("SQLITE_BATCH_SOURCE_STALE");
        const processed = new Set(deps.memory.view().processed);
        const count = pending.filter((turn: Turn) => processed.has(turn.id)).length;
        if (count !== 0 && count !== pending.length) throw new Error("SQLITE_PARTIAL_BATCH_RECEIPT");
        // The wrapper resumes a saved extraction's unfinished index/conflict phase.
        // Processed IDs alone are not a completed post-processing receipt.
        const key = createHash("sha256").update(JSON.stringify(batch.turns)).digest("hex");
        const previousRetry = retries[conversationId]?.batch === key ? retries[conversationId] : undefined;
        if (!manual && previousRetry && (previousRetry.attempts >= 2 || previousRetry.nextAt > Date.now())) break;
        const attempts = manual ? 1 : (previousRetry?.attempts ?? 0) + 1;
        // Persist before calling the model: a crash must not reset the automatic budget.
        retries[conversationId] = { batch: key, attempts, nextAt: Date.now() + 60_000, code: "SQLITE_EXTRACTION_INTERRUPTED" };
        saveRetries();
        try { await deps.maintain(before, pending, signal); }
        catch (error) {
          if (signal.aborted) {
            if (previousRetry) retries[conversationId] = previousRetry; else delete retries[conversationId];
          } else retries[conversationId] = { batch: key, attempts, nextAt: Date.now() + 60_000, code: errorCode(error) };
          saveRetries();
          if (manual || signal.aborted) throw error;
          // Capture has succeeded; leave extraction pending without poisoning delivery ACKs.
          break;
        }
        check(signal);
        if (!enabled()) return { batches, pending: status.pending };
        if (!await db.call("memory.consume", batch)) throw new Error("SQLITE_BATCH_SOURCE_STALE");
        delete retries[conversationId]; saveRetries();
        batches++;
        await refresh();
      }
    }
    scheduleRetry();
    return { batches, pending: status.pending };
  }
  function enqueue<T>(work: (signal: AbortSignal) => Promise<T>, eventId: string, kind: "read" | "extract", callerSignal?: AbortSignal) {
    const signal = callerSignal ? AbortSignal.any([deps.signal(), callerSignal]) : deps.signal();
    processing++;
    const next = tail.then(async () => {
      check(signal);
      phase = kind;
      const result = await work(signal);
      // An unrelated successful event must not erase an earlier durable-event failure.
      // Resume repairs extraction backlog; failed capture stays until that event is replayed.
      if (eventId === "resume" || eventId === "manual") {
        for (const [id, failed] of failures) {
          if (failed.kind === "extract" && deps.settings().captureEnabled && (eventId === "manual" || deps.settings().autoExtractEnabled)) failures.delete(id);
          else if ((id === "bootstrap" || id === "resume") && failed.kind === "read" && deps.storage.get(OWNER)) failures.delete(id);
        }
      } else failures.delete(eventId);
      return result;
    }).catch(error => {
      if (!signal.aborted && phase === "read") failures.set(eventId, { error, at: Date.now(), kind: phase });
      throw error;
    }).finally(() => { processing--; });
    tail = next.then(() => {}, () => {});
    return next;
  }
  const controller = {
    dispose() { disposed = true; if (retryTimer) clearTimeout(retryTimer); release?.(); },
    view: () => {
      const first = failures.entries().next().value;
      const error = first?.[1].error as { code?: unknown; message?: unknown } | undefined;
      const rawCode = error?.code ?? (typeof error?.message === "string" ? error.message.match(/\b(?:SQLITE|JOINT|E_PLUGIN)_[A-Z0-9_]+\b/)?.[0] : undefined);
      const code = typeof rawCode === "string" && /^[A-Z][A-Z0-9_]{2,80}$/.test(rawCode) ? rawCode : "UNKNOWN_ERROR";
      const [failedConversation, extractionFailure] = Object.entries(retries)[0] ?? [];
      return { ...status, retry: extractionFailure ? { attempts: extractionFailure.attempts, paused: extractionFailure.attempts >= 2 || Boolean(failedConversation?.startsWith("private:companion-chat:")), nextAt: extractionFailure.nextAt } : undefined, processing: processing > 0, lastError: first ? { eventId: first[0], at: first[1].at, kind: first[1].kind, code } : extractionFailure ? { eventId: "extraction", at: extractionFailure.nextAt - 60_000, kind: "extract", code: extractionFailure.code } : undefined };
    },
    async whenIdle() {
      // Work can enqueue another item while the previous tail is settling.
      for (;;) {
        const current = tail; await current;
        for (const [eventId, failure] of [...failures]) {
          if (failure.kind !== "read") continue;
          const proof = await db.call("life.eventLifecycle", eventId);
          // Absence, an unrelated success, or a mere missing conversation is not
          // evidence. Only the durable outbox's exact retirement can clear it.
          if (proof?.eventId === eventId && proof.state === "invalidated" && failures.get(eventId) === failure) failures.delete(eventId);
        }
        if (current === tail) break;
      }
      const first = failures.values().next().value;
      if (first) throw first.error;
    },
    bootstrap: () => enqueue(bootstrap, "bootstrap", "read"),
    refreshStatus: () => enqueue(refresh, "status", "read"),
    retry: (manual = false) => enqueue(async signal => { await bootstrap(signal); await extract(signal, manual); }, "resume", "extract"),
    maintain: (callerSignal?: AbortSignal, includePrivate = false) => enqueue(async signal => {
      if (!deps.settings().captureEnabled && !includePrivate) throw new Error("SQLITE_NATIVE_CAPTURE_DISABLED");
      await bootstrap(signal);
      return extract(signal, true);
    }, "manual", "extract", callerSignal),
    capturePrivate: (turn: Turn) => enqueue(async signal => {
      const bound: Turn = await db.call("private.bindTurn",turn);check(signal);
      await db.call("life.recordMemoryTurn",record(bound));
      await restoreCaptured(signal);
      return {accepted:true};
    }, `private:${turn.id}`, "read"),
    capture: (task: any) => enqueue(async signal => {
      await bootstrap(signal);
      if (!deps.settings().captureEnabled) return;
      const source = task.memorySource ?? await db.call("life.memorySource", task.conversationId, task.inputMessageId);
      const turn = await deps.read({ ...task, memorySource: source }, signal);
      check(signal);
      if (!deps.settings().captureEnabled) return;
      await db.call("life.recordMemoryTurn", record(turn));
      const before = new Set(deps.memory.view().turns.map(item => item.id));
      await restoreCaptured(signal);
      // This is the same non-blocking-on-failure social side path as native capture.
      if (deps.settings().socialContextEnabled && deps.social) {
        const rows = await db.call("memory.queueRows");
        const row = rows.find((item: any) => item.conversationId === turn.sessionId && item.userTurnId === turn.inputMessageId);
        if (row && !before.has(row.pluginTurn.id)) await deps.social(decode(row), signal);
      }
      await extract(signal);
    }, task.eventId, "read"),
  };
  const release: void | (() => void) = db.register(controller);
  return controller;
}
