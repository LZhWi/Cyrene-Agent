import type { PluginEvents, PluginStorage, PluginTurnFinishedEvent } from "@playa0v0/cyrene-plugin-sdk";

const SETTINGS_KEY = "auto-reflection-enabled";
const STATE_KEY = "auto-reflection-state";
const TURN_INTERVAL = 20;
const MIN_INTERVAL_MS = 60_000;

interface AutoReflectionState {
  version: 1;
  pendingTurns: number;
  lastAttemptAt?: number;
  lastCompletedAt?: number;
  lastErrorAt?: number;
  lastSuggested?: number;
  lastApplied?: number;
}

function load(storage: PluginStorage): AutoReflectionState {
  const raw = storage.get<unknown>(STATE_KEY);
  if (raw === undefined) return { version: 1, pendingTurns: 0 };
  if (!raw || typeof raw !== "object") throw new Error("后台画像反思状态损坏");
  const state = raw as Partial<AutoReflectionState>;
  if (state.version !== 1 || !Number.isSafeInteger(state.pendingTurns) || state.pendingTurns! < 0 || state.pendingTurns! > TURN_INTERVAL
    || [state.lastAttemptAt, state.lastCompletedAt, state.lastErrorAt].some((value) => value !== undefined && (!Number.isFinite(value) || value < 0))
    || [state.lastSuggested, state.lastApplied].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > 8))) throw new Error("后台画像反思状态损坏");
  return structuredClone(state as AutoReflectionState);
}

/** 每 20 个成功桌面 Chat 轮次生成一批画像变更，再由调用方按本地规则原子应用并保留撤销记录。 */
export function createAutoReflection(
  storage: PluginStorage,
  events: PluginEvents,
  review: (signal: AbortSignal) => Promise<{ suggested: number; applied?: number }>,
  now: () => number = Date.now,
) {
  let enabled = storage.get<boolean>(SETTINGS_KEY) ?? false;
  if (typeof enabled !== "boolean") throw new Error("后台画像反思设置损坏");
  let state = load(storage), stopped = false, running = false;
  let controller: AbortController | undefined;
  const save = (next: AutoReflectionState) => { storage.set(STATE_KEY, next); state = next; };
  const onTurn = async (event: PluginTurnFinishedEvent) => {
    if (stopped || !enabled || event.mode !== "chat" || event.source !== "desktop" || event.status !== "success") return;
    const pendingTurns = Math.min(TURN_INTERVAL, state.pendingTurns + 1); save({ ...state, pendingTurns });
    if (pendingTurns < TURN_INTERVAL || running) return;
    const at = now(); if (state.lastAttemptAt !== undefined && at - state.lastAttemptAt < MIN_INTERVAL_MS) return;
    save({ ...state, pendingTurns: 0, lastAttemptAt: at }); running = true; controller = new AbortController();
    try {
      const result = await review(controller.signal);
      if (stopped || controller.signal.aborted) return;
      save({ ...state, lastCompletedAt: now(), lastSuggested: result.suggested, lastApplied: result.applied ?? 0, lastErrorAt: undefined });
    } catch {
      if (!stopped && !controller.signal.aborted) save({ ...state, lastErrorAt: now() });
    } finally { running = false; controller = undefined; }
  };
  const off = events.on<PluginTurnFinishedEvent>("host:turn:finished", onTurn);
  return {
    view() { return { enabled, running, turnInterval: TURN_INTERVAL, ...structuredClone(state) }; },
    set(value: unknown) {
      if (typeof value !== "boolean") throw new Error("后台画像反思设置无效");
      storage.set(SETTINGS_KEY, value); enabled = value;
      if (!enabled) { controller?.abort(); save({ ...state, pendingTurns: 0 }); }
      return this.view();
    },
    stop() { if (stopped) return; stopped = true; controller?.abort(); off(); },
  };
}
