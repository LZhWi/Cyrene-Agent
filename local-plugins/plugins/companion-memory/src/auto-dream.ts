import type { PluginEvents, PluginStorage, PluginTurnFinishedEvent } from "@playa0v0/cyrene-plugin-sdk";

const SETTINGS_KEY = "auto-dream-enabled";
const APPLY_SETTINGS_KEY = "auto-dream-apply-enabled";
const STATE_KEY = "auto-dream-state";
const IDLE_MS = 15 * 60 * 1000;
const MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface AutoDreamState {
  version: 1;
  lastActivityAt?: number;
  lastAttemptAt?: number;
  lastCompletedAt?: number;
  lastErrorAt?: number;
  lastAutoAppliedAt?: number;
  lastAutoAppliedReviewId?: string;
  lastDemotedToAging?: number;
  lastDemotedToArchived?: number;
  lastCompressionReviewed?: number;
  lastCompressionApplied?: number;
  lastFailedStage?: "capacity" | "dream" | "compression";
}

interface DreamCycleTailResult {
  demotedToAging?: number;
  demotedToArchived?: number;
  compressionReviewed?: number;
  compressionApplied?: number;
}

function load(storage: PluginStorage): AutoDreamState {
  const raw = storage.get<unknown>(STATE_KEY);
  if (raw === undefined) return { version: 1 };
  if (!raw || typeof raw !== "object") throw new Error("后台梦境状态损坏");
  const state = raw as Partial<AutoDreamState>;
  if (state.version !== 1 || [state.lastActivityAt, state.lastAttemptAt, state.lastCompletedAt, state.lastErrorAt, state.lastAutoAppliedAt].some((value) => value !== undefined && (!Number.isFinite(value) || value < 0))
    || [state.lastDemotedToAging, state.lastDemotedToArchived, state.lastCompressionReviewed, state.lastCompressionApplied].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0))
    || (state.lastFailedStage !== undefined && !["capacity", "dream", "compression"].includes(state.lastFailedStage))
    || (state.lastAutoAppliedReviewId !== undefined && (typeof state.lastAutoAppliedReviewId !== "string" || !state.lastAutoAppliedReviewId))) throw new Error("后台梦境状态损坏");
  return structuredClone(state as AutoDreamState);
}

/**
 * 与本地版一致，把原生桌面 Chat 无新活动 15 分钟视为空闲窗口。
 * 容量迁移、叙事与 aging 蒸馏合并由调用方组成同一完整 Dream 周期；
 * 是否自动采用模型结果由独立开关控制，并保留复核及撤销记录。
 */
export function createAutoDream(
  storage: PluginStorage,
  events: PluginEvents,
  listCandidateIds: () => string[],
  review: (entryIds: string[], signal: AbortSignal) => Promise<unknown>,
  now: () => number = Date.now,
  apply?: (review: unknown) => { applied: boolean; reviewId?: string },
  runTail?: (signal: AbortSignal) => Promise<DreamCycleTailResult | undefined>,
) {
  let enabled = storage.get<boolean>(SETTINGS_KEY) ?? false;
  if (typeof enabled !== "boolean") throw new Error("后台梦境设置损坏");
  let applyEnabled = storage.get<boolean>(APPLY_SETTINGS_KEY) ?? false;
  if (typeof applyEnabled !== "boolean") throw new Error("梦境自动采用设置损坏");
  let state = load(storage), stopped = false, running = false;
  let phase: "idle" | "capacity" | "dream" | "compression" = "idle";
  let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined;
  const save = (next: AutoDreamState) => { storage.set(STATE_KEY, next); state = next; };
  const cancelTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    cancelTimer();
    if (stopped || !enabled || state.lastActivityAt === undefined) return;
    const idleDue = state.lastActivityAt + IDLE_MS, intervalDue = (state.lastCompletedAt ?? 0) + MIN_INTERVAL_MS;
    const delay = Math.max(0, Math.max(idleDue, intervalDue) - now());
    timer = setTimeout(run, Math.min(delay, 2_147_483_647));
  };
  const run = async () => {
    timer = undefined;
    if (stopped || !enabled || running || state.lastActivityAt === undefined) return;
    const at = now();
    if (at - state.lastActivityAt < IDLE_MS || (state.lastCompletedAt !== undefined && at - state.lastCompletedAt < MIN_INTERVAL_MS)) { schedule(); return; }
    save({ ...state, lastAttemptAt: at });
    running = true; controller = new AbortController();
    try {
      phase = "capacity";
      const entryIds = listCandidateIds();
      if (entryIds.length > 20) throw new Error("梦境周期叙事候选超过 20 条");
      let applied: { applied: boolean; reviewId?: string } | undefined;
      let nonFatalFailure: "dream" | undefined;
      if (entryIds.length >= 2) {
        phase = "dream";
        try {
          const result = await review(entryIds, controller.signal);
          if (stopped || controller.signal.aborted) return;
          applied = applyEnabled ? apply?.(result) : undefined;
          if (applyEnabled && !apply) throw new Error("宿主未提供梦境自动采用器");
        } catch {
          if (stopped || controller.signal.aborted) return;
          nonFatalFailure = "dream";
        }
      } else if (!runTail) return;
      phase = "compression";
      const tail = await runTail?.(controller.signal);
      if (stopped || controller.signal.aborted) return;
      const completedAt = now();
      save({ ...state, lastCompletedAt: completedAt, lastErrorAt: nonFatalFailure ? completedAt : undefined, lastFailedStage: nonFatalFailure,
        ...(tail ? { lastDemotedToAging: tail.demotedToAging ?? 0, lastDemotedToArchived: tail.demotedToArchived ?? 0, lastCompressionReviewed: tail.compressionReviewed ?? 0, lastCompressionApplied: tail.compressionApplied ?? 0 } : {}),
        ...(applied?.applied ? { lastAutoAppliedAt: completedAt, lastAutoAppliedReviewId: applied.reviewId } : {}) });
    } catch {
      if (!stopped && !controller.signal.aborted) {
        const lastFailedStage = phase === "idle" ? "capacity" : phase;
        save({ ...state, lastErrorAt: now(), lastFailedStage });
      }
    } finally {
      running = false; controller = undefined; phase = "idle";
    }
  };
  const onTurn = (event: PluginTurnFinishedEvent) => {
    if (stopped || event.mode !== "chat" || event.source !== "desktop") return;
    controller?.abort();
    save({ ...state, lastActivityAt: now() });
    schedule();
  };
  const off = events.on<PluginTurnFinishedEvent>("host:turn:finished", onTurn);
  if (enabled) schedule();
  return {
    view() { return { enabled, applyEnabled, running, phase, idleMs: IDLE_MS, minIntervalMs: MIN_INTERVAL_MS, ...structuredClone(state) }; },
    set(value: unknown) {
      if (typeof value !== "boolean") throw new Error("后台梦境设置无效");
      storage.set(SETTINGS_KEY, value); enabled = value;
      if (!enabled) {
        cancelTimer(); controller?.abort();
        if (applyEnabled) { storage.set(APPLY_SETTINGS_KEY, false); applyEnabled = false; }
      }
      else schedule();
      return this.view();
    },
    setApply(value: unknown) {
      if (typeof value !== "boolean") throw new Error("梦境自动采用设置无效");
      if (value && !enabled) throw new Error("请先启用后台梦境");
      storage.set(APPLY_SETTINGS_KEY, value); applyEnabled = value;
      return this.view();
    },
    stop() { if (stopped) return; stopped = true; cancelTimer(); controller?.abort(); off(); },
  };
}
