import type { PluginEvents, PluginStorage, PluginTurnFinishedEvent } from "@playa0v0/cyrene-plugin-sdk";

const SETTINGS_KEY = "auto-review-enabled";
const APPLY_SETTINGS_KEY = "auto-review-apply-enabled";
const STATE_KEY = "auto-review-state";
const TURN_INTERVAL = 5;
const MIN_INTERVAL_MS = 60_000;
const HANDLED_MAX = 500;

export interface AutoReviewCandidate {
  id: string;
  leftId: string;
  rightId: string;
  status: "open" | "dismissed";
  stale: boolean;
}

interface AutoReviewState {
  version: 1;
  pendingTurns: number;
  handledItemIds: string[];
  lastAttemptAt?: number;
  lastCompletedAt?: number;
  lastErrorAt?: number;
  lastReviewedItemId?: string;
  lastAutoAppliedAt?: number;
  lastAutoAppliedReviewId?: string;
}

function load(storage: PluginStorage): AutoReviewState {
  const raw = storage.get<unknown>(STATE_KEY);
  if (raw === undefined) return { version: 1, pendingTurns: 0, handledItemIds: [] };
  if (!raw || typeof raw !== "object") throw new Error("后台复核状态损坏");
  const state = raw as Partial<AutoReviewState>;
  const timestamps = [state.lastAttemptAt, state.lastCompletedAt, state.lastErrorAt, state.lastAutoAppliedAt];
  if (
    state.version !== 1
    || !Number.isSafeInteger(state.pendingTurns)
    || state.pendingTurns! < 0
    || state.pendingTurns! > TURN_INTERVAL
    || !Array.isArray(state.handledItemIds)
    || state.handledItemIds.length > HANDLED_MAX
    || state.handledItemIds.some((id) => typeof id !== "string" || !id)
    || new Set(state.handledItemIds).size !== state.handledItemIds.length
    || timestamps.some((value) => value !== undefined && (!Number.isFinite(value) || value < 0))
    || (state.lastReviewedItemId !== undefined && (typeof state.lastReviewedItemId !== "string" || !state.lastReviewedItemId))
    || (state.lastAutoAppliedReviewId !== undefined && (typeof state.lastAutoAppliedReviewId !== "string" || !state.lastAutoAppliedReviewId))
  ) throw new Error("后台复核状态损坏");
  return structuredClone(state as AutoReviewState);
}

/**
 * 借成功桌面 Chat 轮次推进后台复核水位线。每 5 轮最多处理一个收件箱候选，
 * 模型结果仍由 memory.reviewEntries 保存为待确认建议，不在这里改变任何记忆状态。
 */
export function createAutoReview(
  storage: PluginStorage,
  events: PluginEvents,
  listCandidates: () => AutoReviewCandidate[],
  review: (candidate: AutoReviewCandidate, signal: AbortSignal) => Promise<unknown>,
  now: () => number = Date.now,
  apply?: (review: unknown) => { applied: boolean; reviewId?: string },
) {
  let enabled = storage.get<boolean>(SETTINGS_KEY) ?? false;
  if (typeof enabled !== "boolean") throw new Error("后台复核设置损坏");
  let applyEnabled = storage.get<boolean>(APPLY_SETTINGS_KEY) ?? false;
  if (typeof applyEnabled !== "boolean") throw new Error("Resolver 自动应用设置损坏");
  let state = load(storage);
  let stopped = false;
  let running = false;
  let controller: AbortController | undefined;
  const save = (next: AutoReviewState) => { storage.set(STATE_KEY, next); state = next; };

  const onTurn = async (event: PluginTurnFinishedEvent) => {
    if (stopped || !enabled || event.mode !== "chat" || event.source !== "desktop" || event.status !== "success") return;
    const pendingTurns = Math.min(TURN_INTERVAL, state.pendingTurns + 1);
    save({ ...state, pendingTurns });
    if (pendingTurns < TURN_INTERVAL || running) return;

    const at = now();
    if (state.lastAttemptAt !== undefined && at - state.lastAttemptAt < MIN_INTERVAL_MS) return;
    const handled = new Set(state.handledItemIds);
    const candidate = listCandidates().find((item) => item.status === "open" && !item.stale && !handled.has(item.id));
    if (!candidate) {
      save({ ...state, pendingTurns: 0, lastAttemptAt: at });
      return;
    }

    save({ ...state, pendingTurns: 0, lastAttemptAt: at });
    running = true;
    controller = new AbortController();
    try {
      const result = await review(candidate, controller.signal);
      if (stopped || controller.signal.aborted) return;
      const applied = applyEnabled ? apply?.(result) : undefined;
      if (applyEnabled && !apply) throw new Error("宿主未提供 Resolver 自动应用器");
      const handledItemIds = [...state.handledItemIds.filter((id) => id !== candidate.id), candidate.id].slice(-HANDLED_MAX);
      const completedAt = now();
      save({ ...state, handledItemIds, lastCompletedAt: completedAt, lastReviewedItemId: candidate.id, ...(applied?.applied ? { lastAutoAppliedAt: completedAt, lastAutoAppliedReviewId: applied.reviewId } : {}), lastErrorAt: undefined });
    } catch {
      if (!stopped && !controller.signal.aborted) save({ ...state, lastErrorAt: now() });
    } finally {
      running = false;
      controller = undefined;
    }
  };

  const off = events.on<PluginTurnFinishedEvent>("host:turn:finished", onTurn);
  return {
    view() { return { enabled, applyEnabled, running, turnInterval: TURN_INTERVAL, ...structuredClone(state) }; },
    set(value: unknown) {
      if (typeof value !== "boolean") throw new Error("后台复核设置无效");
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
      if (typeof value !== "boolean") throw new Error("Resolver 自动应用设置无效");
      if (value && !enabled) throw new Error("请先启用后台 Resolver 复核");
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
