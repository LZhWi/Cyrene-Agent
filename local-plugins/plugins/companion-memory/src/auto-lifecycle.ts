import type { PluginEvents, PluginStorage, PluginTurnFinishedEvent } from "@playa0v0/cyrene-plugin-sdk";

const SETTINGS_KEY = "auto-lifecycle-enabled";
const APPLY_SETTINGS_KEY = "auto-lifecycle-apply-enabled";
const STATE_KEY = "auto-lifecycle-state";
const INTERVAL_MS = 24 * 60 * 60 * 1000;

interface AutoLifecycleState {
  version: 1;
  lastScanAt?: number;
  agingCandidates: number;
  archivedCandidates: number;
  lastAppliedAt?: number;
  lastAppliedAging?: number;
  lastAppliedArchived?: number;
  lastWeightDecayCount?: number;
  lastErrorAt?: number;
}

function load(storage: PluginStorage): AutoLifecycleState {
  const raw = storage.get<unknown>(STATE_KEY);
  if (raw === undefined) return { version: 1, agingCandidates: 0, archivedCandidates: 0 };
  if (!raw || typeof raw !== "object") throw new Error("后台生命周期状态损坏");
  const state = raw as Partial<AutoLifecycleState>;
  if (
    state.version !== 1
    || !Number.isSafeInteger(state.agingCandidates) || state.agingCandidates! < 0 || state.agingCandidates! > 200
    || !Number.isSafeInteger(state.archivedCandidates) || state.archivedCandidates! < 0 || state.archivedCandidates! > 200
    || [state.lastScanAt, state.lastAppliedAt, state.lastErrorAt].some((value) => value !== undefined && (!Number.isFinite(value) || value < 0))
    || [state.lastAppliedAging, state.lastAppliedArchived].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > 200))
    || (state.lastWeightDecayCount !== undefined && (!Number.isSafeInteger(state.lastWeightDecayCount) || state.lastWeightDecayCount < 0 || state.lastWeightDecayCount > 20_000))
  ) throw new Error("后台生命周期状态损坏");
  return structuredClone(state as AutoLifecycleState);
}

/**
 * 成功桌面 Chat 轮次只作为每日扫描时钟。后台仅保存候选数量，具体条目仍需用户重新预检、
 * 选择并确认；这里没有任何状态变更入口，不能自动老化或归档记忆。
 */
export function createAutoLifecycle(
  storage: PluginStorage,
  events: PluginEvents,
  scan: () => { agingCandidates: number; archivedCandidates: number },
  now: () => number = Date.now,
  apply?: () => { agingApplied: number; archivedApplied: number; agingCandidates: number; archivedCandidates: number; weightDecayed: number },
) {
  let enabled = storage.get<boolean>(SETTINGS_KEY) ?? false;
  if (typeof enabled !== "boolean") throw new Error("后台生命周期设置损坏");
  let applyEnabled = storage.get<boolean>(APPLY_SETTINGS_KEY) ?? false;
  if (typeof applyEnabled !== "boolean") throw new Error("自动生命周期执行设置损坏");
  let state = load(storage);
  let stopped = false;
  const save = (next: AutoLifecycleState) => { storage.set(STATE_KEY, next); state = next; };
  const onTurn = (event: PluginTurnFinishedEvent) => {
    if (stopped || !enabled || event.mode !== "chat" || event.source !== "desktop" || event.status !== "success") return;
    const at = now();
    if (state.lastScanAt !== undefined && at - state.lastScanAt < INTERVAL_MS) return;
    try {
      let result = scan();
      if (!Number.isSafeInteger(result.agingCandidates) || result.agingCandidates < 0 || result.agingCandidates > 200 || !Number.isSafeInteger(result.archivedCandidates) || result.archivedCandidates < 0 || result.archivedCandidates > 200) throw new Error("候选数量无效");
      let applied: { agingApplied: number; archivedApplied: number; weightDecayed: number } | undefined;
      if (applyEnabled) {
        if (!apply) throw new Error("宿主未提供自动生命周期执行器");
        const appliedResult = apply();
        if ([appliedResult.agingApplied, appliedResult.archivedApplied, appliedResult.agingCandidates, appliedResult.archivedCandidates].some((value) => !Number.isSafeInteger(value) || value < 0 || value > 200) || !Number.isSafeInteger(appliedResult.weightDecayed) || appliedResult.weightDecayed < 0 || appliedResult.weightDecayed > 20_000) throw new Error("自动生命周期执行结果无效");
        applied = appliedResult;
        result = { agingCandidates: appliedResult.agingCandidates, archivedCandidates: appliedResult.archivedCandidates };
      }
      save({ ...state, version: 1, lastScanAt: at, agingCandidates: result.agingCandidates, archivedCandidates: result.archivedCandidates, ...(applied ? { lastAppliedAt: at, lastAppliedAging: applied.agingApplied, lastAppliedArchived: applied.archivedApplied, lastWeightDecayCount: applied.weightDecayed } : {}), lastErrorAt: undefined });
    } catch {
      save({ ...state, lastScanAt: at, lastErrorAt: at });
    }
  };
  const off = events.on<PluginTurnFinishedEvent>("host:turn:finished", onTurn);
  return {
    view() { return { enabled, applyEnabled, intervalMs: INTERVAL_MS, ...structuredClone(state) }; },
    set(value: unknown) {
      if (typeof value !== "boolean") throw new Error("后台生命周期设置无效");
      storage.set(SETTINGS_KEY, value); enabled = value;
      if (!enabled && applyEnabled) { storage.set(APPLY_SETTINGS_KEY, false); applyEnabled = false; }
      return this.view();
    },
    setApply(value: unknown) {
      if (typeof value !== "boolean") throw new Error("自动生命周期执行设置无效");
      if (value && !enabled) throw new Error("请先启用每日生命周期扫描");
      storage.set(APPLY_SETTINGS_KEY, value); applyEnabled = value;
      return this.view();
    },
    stop() { if (stopped) return; stopped = true; off(); },
  };
}
