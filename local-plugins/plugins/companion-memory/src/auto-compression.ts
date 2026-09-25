import type { PluginEvents, PluginStorage, PluginTurnFinishedEvent } from "@playa0v0/cyrene-plugin-sdk";

const SETTINGS_KEY = "auto-compression-enabled";
const APPLY_SETTINGS_KEY = "auto-compression-apply-enabled";
const STATE_KEY = "auto-compression-state";
const TURN_INTERVAL = 20;
const MIN_INTERVAL_MS = 60_000;
const HANDLED_MAX = 200;

export interface AutoCompressionCandidate {
  id: string;
  entryIds: string[];
}

interface AutoCompressionState {
  version: 1;
  pendingTurns: number;
  handledCandidateIds: string[];
  lastAttemptAt?: number;
  lastCompletedAt?: number;
  lastErrorAt?: number;
  lastReviewedCandidateId?: string;
  lastAutoAppliedAt?: number;
  lastAutoAppliedReviewId?: string;
}

function load(storage: PluginStorage): AutoCompressionState {
  const raw = storage.get<unknown>(STATE_KEY);
  if (raw === undefined) return { version: 1, pendingTurns: 0, handledCandidateIds: [] };
  if (!raw || typeof raw !== "object") throw new Error("后台压缩状态损坏");
  const state = raw as Partial<AutoCompressionState>;
  const timestamps = [state.lastAttemptAt, state.lastCompletedAt, state.lastErrorAt, state.lastAutoAppliedAt];
  if (
    state.version !== 1
    || !Number.isSafeInteger(state.pendingTurns)
    || state.pendingTurns! < 0
    || state.pendingTurns! > TURN_INTERVAL
    || !Array.isArray(state.handledCandidateIds)
    || state.handledCandidateIds.length > HANDLED_MAX
    || state.handledCandidateIds.some((id) => typeof id !== "string" || !id)
    || new Set(state.handledCandidateIds).size !== state.handledCandidateIds.length
    || timestamps.some((value) => value !== undefined && (!Number.isFinite(value) || value < 0))
    || (state.lastReviewedCandidateId !== undefined && (typeof state.lastReviewedCandidateId !== "string" || !state.lastReviewedCandidateId))
    || (state.lastAutoAppliedReviewId !== undefined && (typeof state.lastAutoAppliedReviewId !== "string" || !state.lastAutoAppliedReviewId))
  ) throw new Error("后台压缩状态损坏");
  return structuredClone(state as AutoCompressionState);
}

/**
 * 每 20 个成功桌面 Chat 轮次处理一次当前全部互不重叠候选组。模型结果只进入既有待确认列表，
 * 自动应用需要另一项独立授权；具体安全判定和原子事务仍由记忆层负责。
 */
export function createAutoCompression(
  storage: PluginStorage,
  events: PluginEvents,
  listCandidates: () => AutoCompressionCandidate[],
  review: (candidate: AutoCompressionCandidate, signal: AbortSignal) => Promise<unknown>,
  now: () => number = Date.now,
  apply?: (review: unknown) => { applied: boolean; reviewId?: string } | Promise<{ applied: boolean; reviewId?: string }>,
  isSuppressed: () => boolean = () => false,
) {
  let enabled = storage.get<boolean>(SETTINGS_KEY) ?? false;
  if (typeof enabled !== "boolean") throw new Error("后台压缩设置损坏");
  let applyEnabled = storage.get<boolean>(APPLY_SETTINGS_KEY) ?? false;
  if (typeof applyEnabled !== "boolean") throw new Error("后台压缩自动应用设置损坏");
  let state = load(storage);
  let stopped = false;
  let running = false;
  let controller: AbortController | undefined;
  const save = (next: AutoCompressionState) => { storage.set(STATE_KEY, next); state = next; };

  const onTurn = async (event: PluginTurnFinishedEvent) => {
    if (stopped || !enabled || event.mode !== "chat" || event.source !== "desktop" || event.status !== "success") return;
    if (isSuppressed()) { if (state.pendingTurns) save({ ...state, pendingTurns: 0 }); return; }
    const pendingTurns = Math.min(TURN_INTERVAL, state.pendingTurns + 1);
    save({ ...state, pendingTurns });
    if (pendingTurns < TURN_INTERVAL || running) return;

    const at = now();
    if (state.lastAttemptAt !== undefined && at - state.lastAttemptAt < MIN_INTERVAL_MS) return;
    const handled = new Set(state.handledCandidateIds);
    const candidates = listCandidates().filter((item) => !handled.has(item.id));
    if (!candidates.length) {
      save({ ...state, pendingTurns: 0, lastAttemptAt: at });
      return;
    }

    save({ ...state, pendingTurns: 0, lastAttemptAt: at });
    running = true;
    controller = new AbortController();
    let lastReviewedItemId: string | undefined, lastAutoAppliedAt: number | undefined, lastAutoAppliedReviewId: string | undefined, lastErrorAt: number | undefined;
    try {
      for (const candidate of candidates) {
        try {
          const result = await review(candidate, controller.signal);
          if (stopped || controller.signal.aborted) return;
          const applied = applyEnabled ? await apply?.(result) : undefined;
          if (applyEnabled && !apply) throw new Error("宿主未提供后台压缩自动应用器");
          handled.add(candidate.id);
          lastReviewedItemId = candidate.id;
          if (applied?.applied) { lastAutoAppliedAt = now(); lastAutoAppliedReviewId = applied.reviewId; }
        } catch {
          if (stopped || controller.signal.aborted) return;
          lastErrorAt = now();
        }
      }
      const completedAt = now();
      save({ ...state, handledCandidateIds: [...handled].slice(-HANDLED_MAX), lastCompletedAt: completedAt,
        ...(lastReviewedItemId ? { lastReviewedCandidateId: lastReviewedItemId } : {}),
        ...(lastAutoAppliedAt !== undefined ? { lastAutoAppliedAt, lastAutoAppliedReviewId } : {}), lastErrorAt });
    } finally {
      running = false;
      controller = undefined;
    }
  };

  const off = events.on<PluginTurnFinishedEvent>("host:turn:finished", onTurn);
  return {
    view() { return { enabled, applyEnabled, running, suppressed: isSuppressed(), turnInterval: TURN_INTERVAL, ...structuredClone(state) }; },
    set(value: unknown) {
      if (typeof value !== "boolean") throw new Error("后台压缩设置无效");
      storage.set(SETTINGS_KEY, value);
      enabled = value;
      if (!enabled) {
        controller?.abort();
        if (applyEnabled) { storage.set(APPLY_SETTINGS_KEY, false); applyEnabled = false; }
        save({ ...state, pendingTurns: 0 });
      }
      return this.view();
    },
    setApply(value: unknown) {
      if (typeof value !== "boolean") throw new Error("后台压缩自动应用设置无效");
      if (value && !enabled) throw new Error("请先启用后台压缩建议");
      storage.set(APPLY_SETTINGS_KEY, value); applyEnabled = value;
      return this.view();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      controller?.abort();
      off();
    },
  };
}
