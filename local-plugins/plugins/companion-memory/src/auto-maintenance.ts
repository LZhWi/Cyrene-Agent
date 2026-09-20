import type { PluginEvents, PluginStorage, PluginTurnFinishedEvent } from "@playa0v0/cyrene-plugin-sdk";

const SETTINGS_KEY = "auto-maintenance-enabled";
const STATE_KEY = "auto-maintenance-state";
const INTERVAL_MS = 24 * 60 * 60 * 1000;
interface AutoState { version: 1; lastScanAt?: number; lastAdded?: number; lastErrorAt?: number }

function load(storage: PluginStorage): AutoState {
  const raw = storage.get<unknown>(STATE_KEY);
  if (raw === undefined) return { version: 1 };
  if (!raw || typeof raw !== "object") throw new Error("自动维护状态损坏");
  const state = raw as Partial<AutoState>;
  if (state.version !== 1 || [state.lastScanAt, state.lastErrorAt].some((value) => value !== undefined && (!Number.isFinite(value) || value < 0)) || (state.lastAdded !== undefined && (!Number.isSafeInteger(state.lastAdded) || state.lastAdded < 0 || state.lastAdded > 100))) throw new Error("自动维护状态损坏");
  return structuredClone(state as AutoState);
}

/** 只借宿主成功桌面轮次作低频时钟；事件正文不可见，也不会创建 Scheduler 聊天任务。 */
export function createAutoMaintenance(storage: PluginStorage, events: PluginEvents, scan: () => number, now: () => number = Date.now) {
  let enabled = storage.get<boolean>(SETTINGS_KEY) ?? false;
  if (typeof enabled !== "boolean") throw new Error("自动维护设置损坏");
  let state = load(storage), stopped = false;
  const save = (next: AutoState) => { storage.set(STATE_KEY, next); state = next; };
  const onTurn = (event: PluginTurnFinishedEvent) => {
    if (stopped || !enabled || event.mode !== "chat" || event.source !== "desktop" || event.status !== "success") return;
    const at = now(); if (state.lastScanAt !== undefined && at - state.lastScanAt < INTERVAL_MS) return;
    save({ version: 1, lastScanAt: at });
    try { const added = scan(); save({ version: 1, lastScanAt: at, lastAdded: added }); }
    catch { save({ version: 1, lastScanAt: at, lastAdded: 0, lastErrorAt: at }); }
  };
  const off = events.on<PluginTurnFinishedEvent>("host:turn:finished", onTurn);
  return {
    view() { return { enabled, ...structuredClone(state) }; },
    set(value: unknown) { if (typeof value !== "boolean") throw new Error("自动维护设置无效"); storage.set(SETTINGS_KEY, value); enabled = value; return this.view(); },
    stop() { if (stopped) return; stopped = true; off(); },
  };
}
