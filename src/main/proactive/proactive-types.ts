export interface ProactiveRuntimeSnapshot {
  now: number;
  localHour: number;
  idleSec: number;
  enabled: boolean;
  conversationBusy: boolean;
  generationBusy: boolean;
  screenLocked: boolean;
}

export interface ProactiveCandidate {
  sceneId: string;
  score: number;
  sceneCooldownMs: number;
}

export interface ProactiveState {
  proactiveEpoch: number;
  unansweredCount: 0 | 1 | 2;
  lastProactiveAt: number | null;
  lastProactiveScene: string | null;
  lastNormalConversationEndedAt: number | null;
  /** LLM 返回 silent 的时间戳，触发短暂静默期（10 分钟），区别于真正发送消息后的 2 小时冷却。 */
  lastSilentAt: number | null;
  globalDesire: number;
  affinity: Record<string, number>;
  lastFiredAt: Record<string, number | null>;
}

export type ProactiveBlockReason =
  | "allowed"
  | "disabled"
  | "screen_locked"
  | "conversation_busy"
  | "generation_busy"
  | "night_inactive"
  | "normal_quiet_period"
  | "global_cooldown"
  | "silent_cooldown"
  | "scene_cooldown"
  | "unanswered_limit"
  | "followup_cooldown"
  | "followup_same_scene"
  | "followup_score_too_low"
  | "stale_epoch";

export interface ProactiveCommitDecision {
  allowed: boolean;
  reason: ProactiveBlockReason;
}
