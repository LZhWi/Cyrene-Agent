import { createHash } from "node:crypto";
import type { PluginEvents, PluginStorage, PluginTurnFinishedEvent } from "@playa0v0/cyrene-plugin-sdk";
import type { HostHistoryMessage } from "./host-history-source";
const KEY = "maintenance-cycle-state";
type DesktopTurn = Extract<PluginTurnFinishedEvent, { source: "desktop" }>;
type Phase = "review" | "compression" | "reflection";
interface Row { key: string; assistantId: string; signature: string; active: boolean }
interface Job { event: DesktopTurn; key: string; signature: string; phases: Phase[] }
interface State { version: 1; initialized: boolean; rows: Row[]; inbox: DesktopTurn[]; jobs: Job[]; lastError?: string }
function validEvent(value: unknown): value is DesktopTurn {
  if (!value || typeof value !== "object") return false;
  const event = value as PluginTurnFinishedEvent;
  return event.source === "desktop" && event.mode === "chat" && event.chatBackend === "companion" && event.status === "success"
    && [event.eventId,event.conversationId,event.inputMessageId,event.finalMessageId].every(id => typeof id === "string" && id.length > 0);
}
const keyOf = (conversationId: string, userId: string) => JSON.stringify([conversationId, userId]);
function pairs(messages: HostHistoryMessage[]): Row[] {
  const result: Row[] = [];
  let user: HostHistoryMessage | undefined;
  for (const message of messages) {
    if (message.role === "user") { user = message; continue; }
    if (!user || user.sessionId !== message.sessionId) continue;
    if (!user.text.trim() || !message.text.trim()) { user = undefined; continue; }
    result.push({ key: keyOf(user.sessionId, user.id), assistantId: message.id, active: true,
      signature: createHash("sha256").update(JSON.stringify([user.id, user.text, user.at, message.id, message.text, message.at])).digest("hex") });
    user = undefined;
  }
  return result;
}
/** One durable identity clock; failed phases keep their place, completed phases are not repeated. */
export function createMaintenanceCycles(storage: PluginStorage, events: PluginEvents,
  snapshot: (signal: AbortSignal) => Promise<HostHistoryMessage[]>, signal: AbortSignal,
  stages: Record<Phase, (event: PluginTurnFinishedEvent) => Promise<boolean>>,
  log: (message: string) => void = () => {}) {
  const saved = storage.get<State>(KEY);
  if (saved && (saved.version !== 1 || typeof saved.initialized !== "boolean" || !Array.isArray(saved.rows)
    || !Array.isArray(saved.inbox) || !Array.isArray(saved.jobs) || saved.inbox.some(event => !validEvent(event))
    || saved.rows.some(row => typeof row.key !== "string" || typeof row.assistantId !== "string" || typeof row.signature !== "string" || typeof row.active !== "boolean")
    || new Set(saved.rows.map(row => row.key)).size !== saved.rows.length
    || saved.jobs.some(job => !validEvent(job.event) || typeof job.key !== "string" || typeof job.signature !== "string" || !Array.isArray(job.phases) || !job.phases.length || job.phases.some(phase => !["review", "compression", "reflection"].includes(phase))))) throw new Error("维护轮次状态损坏");
  let state: State = saved ? structuredClone(saved) : {version:1,initialized:false,rows:[],inbox:[],jobs:[]};
  let stopped = false, running: Promise<void> | undefined, requested = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const persist = () => storage.set(KEY, structuredClone(state));
  async function refresh() {
    const current = pairs(await snapshot(signal));
    if (signal.aborted || stopped) throw new Error("维护轮次已停止");
    const byKey = new Map(current.map(row => [row.key, row]));
    if (!state.initialized) { state.rows = current; state.initialized = true; }
    else state.rows = state.rows.map(row => {
      const current = byKey.get(row.key);
      return current ? {...current,active:row.active && row.assistantId === current.assistantId} : {...row,active:false};
    });
    persist();
    return byKey;
  }
  async function drain() {
    let current = await refresh();
    while (state.inbox.length && !stopped && !signal.aborted) {
      const event = state.inbox[0], key = keyOf(event.conversationId,event.inputMessageId);
      const row = current.get(key), previous = state.rows.find(row => row.key === key);
      if (row && row.assistantId === event.finalMessageId) {
        if (previous) state.rows[state.rows.indexOf(previous)] = row;
        if (!previous) {
          state.rows.push(row);
          const round = state.rows.filter(row => row.active).length;
          const phases: Phase[] = round % 20 === 0 ? ["review","compression","reflection"] : round % 5 === 0 ? ["review"] : [];
          if (phases.length) state.jobs.push({event,key,signature:row.signature,phases});
        }
      }
      state.inbox.shift(); persist();
    }
    for (const job of [...state.jobs]) {
      if (stopped || signal.aborted) return;
      for (const phase of [...job.phases]) {
        current = await refresh();
        if (current.get(job.key)?.signature !== job.signature) { state.jobs = state.jobs.filter(item => item !== job); persist(); break; }
        let completed = false;
        try { completed = await stages[phase](job.event); }
        catch (error) { log(String(error)); }
        if (stopped || signal.aborted) return;
        if (completed) {
          job.phases = job.phases.filter(item => item !== phase);
          if (!job.phases.length) state.jobs = state.jobs.filter(item => item !== job);
          persist();
        }
      }

    }
    state.lastError = undefined; persist();
  }
  function retryLater() {
    if (stopped || signal.aborted || timer || (!state.jobs.length && !state.inbox.length && !state.lastError)) return;
    timer = setTimeout(() => { timer = undefined; void kick(); },60_000); timer.unref?.();
  }
  function kick(): Promise<void> {
    if (stopped || signal.aborted) return Promise.resolve();
    if (running) { requested = true; return running; }
    running = drain().catch(error => {
      if (!stopped && !signal.aborted) { state.lastError = "维护来源读取或阶段执行失败"; persist(); log(String(error)); }
    }).finally(() => {
      running = undefined;
      if (requested) { requested = false; void kick(); } else retryLater();
    });
    return running;
  }
  const offTurn = events.on<PluginTurnFinishedEvent>("host:turn:finished", event => {
    if (stopped || signal.aborted || !validEvent(event)) return;
    if (!state.inbox.some(item => item.eventId === event.eventId)) { state.inbox.push(structuredClone(event)); persist(); }
    return kick();
  });
  const offChange = events.on("host:conversation:changed", () => kick());
  const stop = () => { stopped = true; if (timer) clearTimeout(timer); offTurn(); offChange(); signal.removeEventListener("abort",stop); };
  signal.addEventListener("abort",stop,{once:true});
  return { start: kick, stop, view: () => structuredClone({...state,round:state.rows.filter(row=>row.active).length}) };
}
