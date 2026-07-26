import type {
  ProactiveCandidate,
  ProactiveCommitDecision,
  ProactiveRuntimeSnapshot,
  ProactiveState,
} from "./proactive-types";

/** 正常对话结束后的静默期：20 分钟。期间不累积 desire，
 *  避免静默期一结束 desire 已过高立刻触发主动消息。 */
export const NORMAL_QUIET_MS = 20 * 60 * 1000;
export const GLOBAL_PROACTIVE_INTERVAL_MS = 2 * 60 * 60 * 1000;
/** LLM 返回 silent 后的全局静默期：10 分钟。比真正发送消息的 2 小时冷却短，
 *  让 AI 能更快适应环境变化（如用户闲下来、到饭点等）。
 *  silent 时不设场景级冷却，10 分钟后任何场景都可再试。 */
export const SILENT_COOLDOWN_MS = 10 * 60 * 1000;
export const FOLLOWUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const NIGHT_ACTIVE_IDLE_LIMIT_SEC = 60;
export const FOLLOWUP_MIN_SCORE = 85;

const allow = (): ProactiveCommitDecision => ({ allowed: true, reason: "allowed" });
const block = (reason: ProactiveCommitDecision["reason"]): ProactiveCommitDecision => ({ allowed: false, reason });

export function createDefaultProactiveState(): ProactiveState {
  return {
    proactiveEpoch: 0,
    unansweredCount: 0,
    lastProactiveAt: null,
    lastProactiveScene: null,
    lastNormalConversationEndedAt: null,
    lastSilentAt: null,
    lastFeedbackJudgedAt: null,
    globalDesire: 0,
    affinity: {},
    lastFiredAt: {},
  };
}

function isNight(hour: number): boolean {
  return hour >= 22 || hour < 8;
}

export function canStartProactiveGeneration(
  snapshot: ProactiveRuntimeSnapshot,
  state: ProactiveState,
  candidate: ProactiveCandidate,
): ProactiveCommitDecision {
  if (!snapshot.enabled) return block("disabled");
  if (snapshot.screenLocked) return block("screen_locked");
  if (snapshot.conversationBusy) return block("conversation_busy");
  if (snapshot.generationBusy) return block("generation_busy");
  if (isNight(snapshot.localHour) && snapshot.idleSec >= NIGHT_ACTIVE_IDLE_LIMIT_SEC) return block("night_inactive");
  if (state.unansweredCount >= 2) return block("unanswered_limit");

  if (
    state.lastNormalConversationEndedAt !== null &&
    snapshot.now - state.lastNormalConversationEndedAt < NORMAL_QUIET_MS
  ) return block("normal_quiet_period");

  if (
    state.lastProactiveAt !== null &&
    snapshot.now - state.lastProactiveAt < GLOBAL_PROACTIVE_INTERVAL_MS
  ) return block("global_cooldown");

  // LLM 上次返回 silent 后的全局静默期（10 分钟），比真正发送消息的 2 小时冷却短
  // silent 时不设场景冷却，10 分钟后任何场景可再试
  if (
    state.lastSilentAt !== null &&
    snapshot.now - state.lastSilentAt < SILENT_COOLDOWN_MS
  ) return block("silent_cooldown");

  const sceneLastFiredAt = state.lastFiredAt[candidate.sceneId];
  if (
    typeof sceneLastFiredAt === "number" &&
    snapshot.now - sceneLastFiredAt < candidate.sceneCooldownMs
  ) return block("scene_cooldown");

  if (state.unansweredCount === 1) {
    if (
      state.lastProactiveAt !== null &&
      snapshot.now - state.lastProactiveAt < FOLLOWUP_INTERVAL_MS
    ) return block("followup_cooldown");
    if (state.lastProactiveScene === candidate.sceneId) return block("followup_same_scene");
    if (candidate.score < FOLLOWUP_MIN_SCORE) return block("followup_score_too_low");
  }

  return allow();
}

export function canCommitProactiveMessage(
  snapshot: ProactiveRuntimeSnapshot,
  state: ProactiveState,
  candidate: ProactiveCandidate,
  generationEpoch: number,
): ProactiveCommitDecision {
  if (generationEpoch !== state.proactiveEpoch) return block("stale_epoch");
  return canStartProactiveGeneration(snapshot, state, candidate);
}

export function markUserActivity(state: ProactiveState): void {
  state.proactiveEpoch += 1;
  state.unansweredCount = 0;
  state.lastSilentAt = null;
}

export function markNormalConversationStarted(state: ProactiveState): void {
  state.proactiveEpoch += 1;
}

export function markNormalConversationEnded(state: ProactiveState, now: number): void {
  state.proactiveEpoch += 1;
  state.lastNormalConversationEndedAt = now;
  state.globalDesire = 0;
  state.lastSilentAt = null;
}

export function markProactiveCommitted(
  state: ProactiveState,
  candidate: ProactiveCandidate,
  now: number,
): void {
  state.unansweredCount = Math.min(2, state.unansweredCount + 1) as 0 | 1 | 2;
  state.lastProactiveAt = now;
  state.lastProactiveScene = candidate.sceneId;
  state.lastFiredAt[candidate.sceneId] = now;
  state.globalDesire = 0;
  state.lastSilentAt = null;
}

/**
 * 回退最近一次主动消息的冷却状态。
 * 用于用户删除了 proactive-chat 会话中最后一条未回复的 AI 主动消息时。
 * 取消 2 小时全局冷却（lastProactiveAt），回退 unansweredCount，
 * 但保留场景冷却（lastFiredAt）和 silent 冷却（lastSilentAt）。
 * desire 保持 0 重新累积，提供自然的时间缓冲。
 */
export function rollbackLastProactive(state: ProactiveState): void {
  state.lastProactiveAt = null;
  state.lastProactiveScene = null;
  state.unansweredCount = Math.max(0, state.unansweredCount - 1) as 0 | 1 | 2;
}
