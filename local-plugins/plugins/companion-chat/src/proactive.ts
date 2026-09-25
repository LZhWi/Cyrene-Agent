import type { PluginLlmMessage, PluginStorage, PluginWeatherContextSnapshot } from "@playa0v0/cyrene-plugin-sdk";
import { buildProactiveMessages, NIGHT_ACTIVE_IDLE_LIMIT_SECONDS, parseProactiveDecision, type ProactiveHistoryTurn } from "./proactive-prompt";
export { NIGHT_ACTIVE_IDLE_LIMIT_SECONDS } from "./proactive-prompt";
import {
  FOLLOWUP_MIN_SCORE,
  isWeatherSceneHour,
  markPlannerCommitted,
  sampleAndPlan,
  sceneCooldownMs,
  settleIgnoreFeedback,
  settleReplyFeedback,
  validatePlannerState,
  type ProactiveCandidate,
  type ProactivePlannerState,
  type ProactiveScene,
} from "./proactive-planner";

const STATE_KEY = "proactive-controller";
export const PROACTIVE_CHECK_INTERVAL_MS = 60 * 1000;
export const PROACTIVE_QUIET_MS = 20 * 60 * 1000;
export const PROACTIVE_GLOBAL_COOLDOWN_MS = 2 * 60 * 60 * 1000;
export const PROACTIVE_FOLLOWUP_COOLDOWN_MS = 3 * 60 * 60 * 1000;
export const PROACTIVE_SILENT_COOLDOWN_MS = 10 * 60 * 1000;
export const MAX_UNANSWERED_PROACTIVE = 2;
const MAX_PROACTIVE_TEXT_LENGTH = 500;
export type ProactivePace = "quiet" | "normal" | "lively";
const DESIRE_RATE: Record<ProactivePace, number> = { quiet: 1, normal: 2, lively: 4 };

export interface UserPresenceSnapshot {
  at: string;
  idleSeconds: number;
  screenLocked: boolean;
  localHour?: number;
  localMinute?: number;
  lastUserMessageAt?: number | null;
}

interface ProactiveState {
  version: 1;
  enabled: boolean;
  feedbackLearningEnabled?: boolean;
  pace?: ProactivePace;
  epoch: number;
  unansweredCount: number;
  lastActivityAt: number;
  lastNormalConversationEndedAt?: number | null;
  lastSentAt: number | null;
  lastSilentAt?: number | null;
  lastScene?: ProactiveScene | null;
  planner?: ProactivePlannerState;
  lastDeliveredText?: string | null;
  lastDeliveredMessageId?: string | null;
  lastDeliveredConversationId?: string | null;
  deliveredHistory?: Array<{ text: string; at: number }>;
}

export interface ProactiveControllerDeps {
  storage: PluginStorage;
  retrieve(query: string, signal: AbortSignal, runId: string): Promise<string>;
  recentContext?: () => Promise<{ ordinaryHistory: ProactiveHistoryTurn[]; proactiveHistory: ProactiveHistoryTurn[]; recentTopic: string }>;
  profileContext?: (query: string, lastAssistant: string, signal: AbortSignal, runId: string) => Promise<string>;
  commitContext?: (runId: string) => Promise<void>;
  discardContext?: (runId: string) => Promise<void>;
  lifeContext?: (query: string) => string;
  toneRules?: () => string;
  generate(messages: PluginLlmMessage[], signal: AbortSignal): Promise<string>;
  systemPrompt(): string;
  screenContext?(): string;
  presence?(): Promise<UserPresenceSnapshot>;
  weather?(): Promise<PluginWeatherContextSnapshot | null>;
  canStartDelivery?(): Promise<boolean>;
  deliver(text: string, options: { allowIgnoreFeedback: boolean }): Promise<{ conversationId: string; messageId: string; at: string; deliveredText?: string }>;
  stopSignal: AbortSignal;
  now?: () => number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  random?: () => number;
  planCandidate?: typeof sampleAndPlan;
}

function validateState(value: unknown, at: number): ProactiveState {
  if (!value || typeof value !== "object") throw new Error("主动消息状态损坏，拒绝覆盖");
  const state = value as Record<string, unknown>;
  if (state.version !== 1 || typeof state.enabled !== "boolean"
    || (state.pace !== undefined && !["quiet", "normal", "lively"].includes(state.pace as string))
    || !Number.isSafeInteger(state.epoch) || (state.epoch as number) < 0
    || !Number.isInteger(state.unansweredCount) || (state.unansweredCount as number) < 0 || (state.unansweredCount as number) > MAX_UNANSWERED_PROACTIVE
    || !Number.isFinite(state.lastActivityAt) || (state.lastActivityAt as number) < 0
    || (state.lastNormalConversationEndedAt !== undefined && state.lastNormalConversationEndedAt !== null
      && (!Number.isFinite(state.lastNormalConversationEndedAt) || (state.lastNormalConversationEndedAt as number) < 0))
    || (state.lastSentAt !== null && (!Number.isFinite(state.lastSentAt) || (state.lastSentAt as number) < 0))
    || (state.lastDeliveredText !== undefined && state.lastDeliveredText !== null && typeof state.lastDeliveredText !== "string")
    || (state.lastDeliveredMessageId !== undefined && state.lastDeliveredMessageId !== null && typeof state.lastDeliveredMessageId !== "string")
    || (state.lastDeliveredConversationId !== undefined && state.lastDeliveredConversationId !== null && typeof state.lastDeliveredConversationId !== "string")
    || (state.lastSilentAt !== undefined && state.lastSilentAt !== null && (!Number.isFinite(state.lastSilentAt) || (state.lastSilentAt as number) < 0))) {
    throw new Error("主动消息状态损坏，拒绝覆盖");
  }
  const normalized = structuredClone(value as ProactiveState);
  normalized.feedbackLearningEnabled ??= false;
  normalized.pace ??= "normal";
  normalized.lastScene ??= null;
  normalized.lastNormalConversationEndedAt ??= null;
  normalized.lastDeliveredText ??= null;
  normalized.lastDeliveredMessageId ??= null;
  normalized.lastDeliveredConversationId ??= null;
  normalized.deliveredHistory ??= [];
  if (!Array.isArray(normalized.deliveredHistory)
    || normalized.deliveredHistory.length > 20
    || normalized.deliveredHistory.some((item) => !item || typeof item.text !== "string" || !item.text.trim()
      || item.text.length > MAX_PROACTIVE_TEXT_LENGTH || !Number.isFinite(item.at) || item.at < 0)) {
    throw new Error("主动消息历史损坏，拒绝覆盖");
  }
  normalized.planner = validatePlannerState(normalized.planner, at);
  return normalized;
}

function isQuietHour(now: number): boolean {
  const hour = new Date(now).getHours();
  return hour >= 23 || hour < 8;
}

export function createProactiveController(deps: ProactiveControllerDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setInterval ?? globalThis.setInterval;
  const clearTimer = deps.clearInterval ?? globalThis.clearInterval;
  const stored = deps.storage.get<unknown>(STATE_KEY);
  let state = stored === undefined ? {
    version: 1 as const,
    enabled: false,
    feedbackLearningEnabled: false,
    pace: "normal" as const,
    epoch: 0,
    unansweredCount: 0,
    lastActivityAt: 0,
    lastNormalConversationEndedAt: null,
    lastSentAt: null,
    lastSilentAt: null,
    lastScene: null,
    planner: validatePlannerState(undefined, now()),
    lastDeliveredText: null,
    lastDeliveredMessageId: null,
    lastDeliveredConversationId: null,
    deliveredHistory: [],
  } : validateState(stored, now());
  let timer: ReturnType<typeof globalThis.setInterval> | undefined;
  let current: AbortController | undefined;
  let currentDone: Promise<void> | undefined;
  let resolveCurrentDone: (() => void) | undefined;
  let stopped = false;
  let conversationBusy = false;

  function save(next: ProactiveState): void {
    deps.storage.set(STATE_KEY, next);
    state = next;
  }

  function policyAllows(at: number, presence?: UserPresenceSnapshot): boolean {
    const cooldown = state.unansweredCount > 0 ? PROACTIVE_FOLLOWUP_COOLDOWN_MS : PROACTIVE_GLOBAL_COOLDOWN_MS;
    return state.enabled && !stopped && !deps.stopSignal.aborted
      && !presence?.screenLocked && !conversationBusy
      && (!isQuietHour(at) || (presence !== undefined && presence.idleSeconds < NIGHT_ACTIVE_IDLE_LIMIT_SECONDS))
      && state.unansweredCount < MAX_UNANSWERED_PROACTIVE
      && (state.lastNormalConversationEndedAt == null || at - state.lastNormalConversationEndedAt >= PROACTIVE_QUIET_MS)
      && (state.lastSentAt === null || at - state.lastSentAt >= cooldown)
      && (state.lastSilentAt == null || at - state.lastSilentAt >= PROACTIVE_SILENT_COOLDOWN_MS);
  }

  function normalizeForDedup(text: string): string {
    return text.replace(/[\s\p{P}]/gu, "").toLowerCase();
  }

  function canStart(at: number, presence?: UserPresenceSnapshot): boolean {
    return !current && policyAllows(at, presence);
  }

  function candidateAllows(candidate: ProactiveCandidate, at: number): boolean {
    const last = state.planner!.lastFiredAt[candidate.scene];
    return (last === undefined || at - last >= sceneCooldownMs(candidate.scene))
      && (state.unansweredCount !== 1 || (candidate.scene !== state.lastScene && candidate.score >= FOLLOWUP_MIN_SCORE));
  }

  function ensureTimer(): void {
    if (!state.enabled || stopped || timer) return;
    timer = setTimer(() => {
      void evaluate().catch((error) => {
        console.warn("[Proactive] 定时检查失败:", error instanceof Error ? error.message : String(error));
      });
    }, PROACTIVE_CHECK_INTERVAL_MS);
    timer.unref?.();
    console.log("[Proactive] 启动，检查间隔", PROACTIVE_CHECK_INTERVAL_MS / 1_000, "s");
  }

  function clearScheduledTimer(): void {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  }

  async function generateAndDeliver(force: boolean) {
    const startedAt = now();
    const initialPresence = force ? undefined : await deps.presence?.();
    let candidate: ProactiveCandidate | null = null;
    let weather: PluginWeatherContextSnapshot | null | undefined;
    if (!force && initialPresence && !current) {
      const allowed = canStart(startedAt, initialPresence);
      const localHour = initialPresence.localHour ?? new Date(startedAt).getHours();
      weather = isWeatherSceneHour(localHour) ? await deps.weather?.() : null;
      candidate = (deps.planCandidate ?? sampleAndPlan)({
        state: state.planner!,
        presence: initialPresence,
        at: startedAt,
        lastActivityAt: initialPresence.lastUserMessageAt ?? state.lastActivityAt,
        lastNormalConversationEndedAt: state.lastNormalConversationEndedAt,
        quietMs: PROACTIVE_QUIET_MS,
        baseDesireRate: DESIRE_RATE[state.pace ?? "normal"],
        weather,
        allowAttempt: true,
        random: deps.random,
      });
      if (candidate && state.feedbackLearningEnabled && state.unansweredCount > 0) settleIgnoreFeedback(state.planner!);
      if (!allowed || !candidate || !candidateAllows(candidate, startedAt)) {
        console.log("[Proactive] 本轮跳过:", JSON.stringify({
          allowed,
          hasCandidate: Boolean(candidate),
          candidateScene: candidate?.scene ?? null,
          candidateScore: candidate ? Number(candidate.score.toFixed(1)) : null,
          unansweredCount: state.unansweredCount,
        }));
        save({ ...state });
        return { kind: "skipped" as const };
      }
      if (deps.canStartDelivery && !(await deps.canStartDelivery())) {
        save({ ...state });
        return { kind: "skipped" as const };
      }
      save({ ...state });
    }
    if ((!force && (!initialPresence || !candidate)) || stopped || deps.stopSignal.aborted || current) return { kind: "skipped" as const };
    const generationEpoch = state.epoch;
    const controller = new AbortController();
    current = controller;
    currentDone = new Promise<void>((resolve) => { resolveCurrentDone = resolve; });
    console.log("[Proactive] 开始生成:", JSON.stringify({
      force,
      scene: candidate?.scene ?? "manual-test",
      score: candidate ? Number(candidate.score.toFixed(1)) : null,
      unansweredCount: state.unansweredCount,
    }));
    const signal = AbortSignal.any([deps.stopSignal, controller.signal]);
    const contextRunId = `proactive-${startedAt}-${generationEpoch}`;
    try {
      const recent = await deps.recentContext?.() ?? { ordinaryHistory: [], proactiveHistory: [], recentTopic: "" };
      const sceneId = candidate?.scene ?? "manual-test";
      const query = `${sceneId}\n${recent.recentTopic}`.trim();
      const [memory, profile] = await Promise.all([
        deps.retrieve(query, signal, contextRunId),
        deps.profileContext?.(query, [...recent.ordinaryHistory].reverse().find((turn) => turn.role === "model")?.content ?? "", signal, contextRunId) ?? Promise.resolve(""),
      ]);
      if (signal.aborted || generationEpoch !== state.epoch) return { kind: "stale" as const };
      const screen = deps.screenContext?.().trim() ?? "";
      const rawDecision = await deps.generate(buildProactiveMessages({
        basePersona: deps.systemPrompt(),
        userProfile: profile,
        relevantMemory: memory,
        lifeContext: deps.lifeContext?.(query),
        screenActivity: screen,
        ordinaryHistory: recent.ordinaryHistory,
        proactiveHistory: recent.proactiveHistory,
        sceneId,
        localNow: new Date(startedAt),
        idleSec: initialPresence?.idleSeconds ?? Number.POSITIVE_INFINITY,
        unansweredCount: state.unansweredCount as 0 | 1 | 2,
        toneRules: deps.toneRules?.(),
      }), signal);
      const commitPresence = force ? undefined : await deps.presence?.();
      if (signal.aborted || generationEpoch !== state.epoch || (!force && (!policyAllows(now(), commitPresence) || !candidateAllows(candidate!, now())))) return { kind: "stale" as const };
      const decision = parseProactiveDecision(rawDecision);
      if (decision.kind === "invalid") {
        console.log("[Proactive] 模型决策: invalid", decision.reason);
        return { kind: "invalid" as const };
      }
      if (decision.kind === "silent") {
        state.planner!.globalDesire = 0;
        save({ ...state, epoch: state.epoch + 1, lastSilentAt: now() });
        console.log("[Proactive] 模型决策:", decision.kind);
        return { kind: decision.kind } as const;
      }
      const recentAssistantTexts = [recent.ordinaryHistory, recent.proactiveHistory]
        .map((history) => [...history].reverse().find((turn) => turn.role === "model")?.content)
        .filter((text): text is string => Boolean(text));
      if ([...recentAssistantTexts, state.lastDeliveredText ?? ""].some((text) => text && normalizeForDedup(text) === normalizeForDedup(decision.text))) {
        state.planner!.globalDesire = 0;
        save({ ...state, epoch: state.epoch + 1, lastSilentAt: now() });
        console.log("[Proactive] 模型决策: duplicate");
        return { kind: "duplicate" as const };
      }
      const delivered = await deps.deliver(decision.text, {
        allowIgnoreFeedback: state.feedbackLearningEnabled === true && candidate !== null,
      });
      const actualText = delivered.deliveredText ?? decision.text;
      const committedAt = now();
      if (candidate) {
        markPlannerCommitted(state.planner!, candidate, committedAt);
        if (!state.feedbackLearningEnabled) state.planner!.pendingFeedback = null;
      }
      // deliver() 返回表示消息已经持久化；此后即使用户活动恰好发生，也必须记录真实发送，
      // 否则下一次扫描可能因缺少冷却状态而重复投递。
      save({
        ...state,
        epoch: state.epoch + 1,
        unansweredCount: Math.min(MAX_UNANSWERED_PROACTIVE, state.unansweredCount + 1),
        lastSentAt: committedAt,
        lastSilentAt: null,
        lastScene: candidate?.scene ?? state.lastScene,
        lastDeliveredText: actualText,
        lastDeliveredMessageId: delivered.messageId,
        lastDeliveredConversationId: delivered.conversationId,
        deliveredHistory: [...(state.deliveredHistory ?? []), { text: actualText, at: committedAt }].slice(-16),
      });
      try { await deps.commitContext?.(contextRunId); }
      catch (error) { console.warn("[Proactive] 已投递消息的上下文记账失败:", error); }
      console.log("[Proactive] 已发送:", JSON.stringify({
        scene: candidate?.scene ?? "manual-test",
        messageId: delivered.messageId,
        textChars: decision.text.length,
        durationMs: now() - startedAt,
      }));
      return { kind: "committed" as const, ...delivered };
    } finally {
      try { await deps.discardContext?.(contextRunId); }
      catch (error) { console.warn("[Proactive] 清理未提交上下文失败:", error); }
      current = undefined;
      resolveCurrentDone?.();
      resolveCurrentDone = undefined;
      currentDone = undefined;
    }
  }

  async function evaluate() {
    return generateAndDeliver(false);
  }

  if (state.enabled) ensureTimer();

  return {
    view() { return structuredClone({ ...state, busy: Boolean(current) }); },
    configure(enabled: boolean, feedbackLearningEnabled = false, pace: ProactivePace = state.pace ?? "normal") {
      if (typeof enabled !== "boolean" || typeof feedbackLearningEnabled !== "boolean"
        || !["quiet", "normal", "lively"].includes(pace)
        || stopped || (current && enabled)) throw new Error("主动消息设置无效或当前正忙");
      if (!enabled) current?.abort();
      const at = now();
      state.planner!.lastSampleAt = at;
      if (!feedbackLearningEnabled) state.planner!.pendingFeedback = null;
      save({ ...state, enabled, feedbackLearningEnabled, pace, epoch: state.epoch + 1, unansweredCount: enabled ? state.unansweredCount : 0 });
      if (enabled) ensureTimer(); else clearScheduledTimer();
      console.log("[Proactive] 配置更新:", JSON.stringify({ enabled, feedbackLearningEnabled }));
      return this.view();
    },
    async noteUserActivity(feedbackReply = true) {
      if (stopped) return;
      conversationBusy = true;
      current?.abort();
      const at = now();
      if (feedbackReply && state.feedbackLearningEnabled) settleReplyFeedback(state.planner!);
      state.planner!.globalDesire = 0;
      save({ ...state, epoch: state.epoch + 1, unansweredCount: 0, lastActivityAt: at, lastSilentAt: null });
      console.log("[Proactive] 用户活动：取消当前生成并清零未回复计数");
      await currentDone;
    },
    noteConversationEnded() {
      if (stopped) return;
      conversationBusy = false;
      const at = now();
      state.planner!.globalDesire = 0;
      save({ ...state, epoch: state.epoch + 1, lastActivityAt: at, lastNormalConversationEndedAt: at, lastSilentAt: null });
    },
    ignoreMessage(messageId: string) {
      if (!state.feedbackLearningEnabled || messageId !== state.lastDeliveredMessageId
        || !settleIgnoreFeedback(state.planner!)) return false;
      save({ ...state });
      return true;
    },
    invalidateDeliveredMessage(conversationId: string, allMessages: boolean, invalidatedMessageIds: string[]) {
      if (state.unansweredCount === 0 || !state.lastDeliveredMessageId || !state.lastDeliveredConversationId
        || state.lastDeliveredConversationId !== conversationId
        || (!allMessages && !invalidatedMessageIds.includes(state.lastDeliveredMessageId))) return false;
      const history = (state.deliveredHistory ?? []).slice(0, -1);
      state.planner!.pendingFeedback = null;
      save({ ...state, epoch: state.epoch + 1,
        unansweredCount: Math.max(0, state.unansweredCount - 1),
        lastSentAt: null, lastScene: null,
        lastDeliveredText: history.at(-1)?.text ?? null,
        lastDeliveredMessageId: null, lastDeliveredConversationId: null,
        deliveredHistory: history });
      return true;
    },
    evaluate,
    manualTest() { return generateAndDeliver(true); },
    cancel() { current?.abort(); },
    stop() {
      if (stopped) return;
      stopped = true;
      current?.abort();
      clearScheduledTimer();
      console.log("[Proactive] 停止");
    },
  };
}
