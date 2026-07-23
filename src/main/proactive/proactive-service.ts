import type { ChatMessage } from "../orchestrator/vendors/types";
import {
  canCommitProactiveMessage,
  canStartProactiveGeneration,
  markNormalConversationEnded,
  markNormalConversationStarted,
  markProactiveCommitted,
  markUserActivity,
} from "./proactive-policy";
import type { ProactiveModelResult } from "./proactive-model";
import type { ProactiveCandidate, ProactiveRuntimeSnapshot, ProactiveState } from "./proactive-types";

// 归一化：去除空白与标点（Unicode 感知，含中英文标点），并转小写。仅用于去重判定，不改动落库文本。
export function normalizeForDedup(text: string): string {
  return text.replace(/[\s\p{P}]/gu, "").toLowerCase();
}

// 判定候选文本是否与最近历史逐字重复（归一化后完全相等）。空文本不参与；正常改写过的跟进不会命中。
export function isDuplicateProactiveText(candidate: string, recent: string[]): boolean {
  const norm = normalizeForDedup(candidate);
  if (!norm) return false;
  return recent.some((entry) => normalizeForDedup(entry) === norm);
}

export interface ProactiveFallback {
  text: string;
  payload?: unknown;
}

export interface ProactiveCommitInput {
  candidate: ProactiveCandidate;
  text: string;
  source: "model" | "fallback";
  fallbackPayload?: unknown;
  generationEpoch: number;
}

export type ProactiveCommitResult =
  | { kind: "committed" }
  | { kind: "cancelled"; reason: string };

export interface ProactiveChatServiceDeps {
  loadState: () => ProactiveState;
  saveState: (state: ProactiveState) => void;
  getSnapshot: () => ProactiveRuntimeSnapshot;
  buildMessages: (candidate: ProactiveCandidate, state: ProactiveState) => Promise<ChatMessage[]>;
  runModel: (messages: ChatMessage[]) => Promise<ProactiveModelResult>;
  getFallback: (candidate: ProactiveCandidate) => Promise<ProactiveFallback | null>;
  commitMessage: (input: ProactiveCommitInput) => Promise<ProactiveCommitResult>;
  canStartDelivery?: () => boolean;
  // 去重护栏数据源：返回最近历史里用于比对的文本（当前为普通/主动会话各自的最后一条 assistant）。
  getRecentTextsForDedup?: () => string[];
  log?: (event: string, detail?: unknown) => void;
}

export interface ProactiveChatService {
  evaluateCandidate(candidate: ProactiveCandidate): Promise<void>;
  invalidateForUserMessage(): void;
  normalConversationStarted(): void;
  normalConversationEnded(now?: number): void;
  invalidate(): void;
  isGenerating(): boolean;
}

export function createProactiveChatService(deps: ProactiveChatServiceDeps): ProactiveChatService {
  let generating = false;

  const persistMutation = (mutate: (state: ProactiveState) => void): void => {
    const state = deps.loadState();
    mutate(state);
    deps.saveState(state);
  };

  return {
    async evaluateCandidate(candidate): Promise<void> {
      const initialState = deps.loadState();
      const rawInitialSnapshot = deps.getSnapshot();
      const initialSnapshot = { ...rawInitialSnapshot, generationBusy: rawInitialSnapshot.generationBusy || generating };
      const startDecision = canStartProactiveGeneration(initialSnapshot, initialState, candidate);
      if (!startDecision.allowed) {
        deps.log?.("candidate_blocked", { scene: candidate.sceneId, reason: startDecision.reason });
        return;
      }
      if (deps.canStartDelivery && !deps.canStartDelivery()) {
        deps.log?.("candidate_blocked", { scene: candidate.sceneId, reason: "delivery_unavailable" });
        return;
      }

      generating = true;
      const generationEpoch = initialState.proactiveEpoch;
      // silent 与「去重命中」共用的收尾：归 0 globalDesire、进入 10 分钟全局静默；
      // 不设 lastFiredAt/lastProactiveAt（不触发场景级/2 小时冷却），过静默窗后可再尝试生成新内容。
      const applySilentLikeOutcome = (logEvent: string): void => {
        const silentState = deps.loadState();
        if (silentState.proactiveEpoch === generationEpoch) {
          silentState.globalDesire = 0;
          silentState.lastSilentAt = deps.getSnapshot().now;
          deps.saveState(silentState);
        }
        deps.log?.(logEvent, { scene: candidate.sceneId });
      };
      try {
        const messages = await deps.buildMessages(candidate, initialState);
        const result = await deps.runModel(messages);
        const stateAfterModel = deps.loadState();
        if (stateAfterModel.proactiveEpoch !== generationEpoch) {
          deps.log?.("generation_discarded", { scene: candidate.sceneId, reason: "stale_epoch" });
          return;
        }

        let text: string;
        let source: "model" | "fallback";
        let fallbackPayload: unknown;
        if (result.kind === "silent") {
          applySilentLikeOutcome("model_silent");
          return;
        }
        if (result.kind === "send") {
          // 去重护栏：模型偶发把历史里它自己上一条消息原样复述出来（归一化后完全相同）。
          // 视同 silent 跳过——此刻尚未写历史/记忆/冷却，无副作用需要回滚。
          if (isDuplicateProactiveText(result.text, deps.getRecentTextsForDedup?.() ?? [])) {
            applySilentLikeOutcome("duplicate_suppressed");
            return;
          }
          text = result.text;
          source = "model";
        } else {
          // 技术失败或无效输出才允许寻找旧预设；Epoch 失效已在上方提前拦截。
          const fallback = await deps.getFallback(candidate);
          if (!fallback?.text.trim()) {
            deps.log?.("fallback_unavailable", { scene: candidate.sceneId, result: result.kind });
            return;
          }
          text = fallback.text.trim();
          fallbackPayload = fallback.payload;
          source = "fallback";
        }

        const commitState = deps.loadState();
        const commitSnapshot = deps.getSnapshot();
        const commitDecision = canCommitProactiveMessage(
          commitSnapshot,
          commitState,
          candidate,
          generationEpoch,
        );
        if (!commitDecision.allowed) {
          deps.log?.("commit_blocked", { scene: candidate.sceneId, reason: commitDecision.reason, source });
          return;
        }

        const commitResult = await deps.commitMessage({ candidate, text, source, fallbackPayload, generationEpoch });
        if (commitResult.kind === "cancelled") {
          deps.log?.("commit_cancelled", {
            scene: candidate.sceneId,
            reason: commitResult.reason,
            source,
          });
          return;
        }
        const latestState = deps.loadState();
        if (latestState.proactiveEpoch === generationEpoch) {
          markProactiveCommitted(latestState, candidate, commitSnapshot.now);
        } else {
          // 文本已经成功写入，但用户可能在后续 TTS 等待期间发来消息。
          // 保留更新后的 Epoch/unansweredCount，只补记这次真实发送的硬冷却时间。
          latestState.lastProactiveAt = commitSnapshot.now;
          latestState.lastProactiveScene = candidate.sceneId;
          latestState.lastFiredAt[candidate.sceneId] = commitSnapshot.now;
          latestState.globalDesire = 0;
        }
        deps.saveState(latestState);
        deps.log?.("message_committed", { scene: candidate.sceneId, source });
      } finally {
        generating = false;
      }
    },

    invalidateForUserMessage(): void {
      persistMutation(markUserActivity);
    },

    normalConversationStarted(): void {
      persistMutation(markNormalConversationStarted);
    },

    normalConversationEnded(now = Date.now()): void {
      persistMutation((state) => markNormalConversationEnded(state, now));
    },

    invalidate(): void {
      persistMutation((state) => { state.proactiveEpoch += 1; });
    },

    isGenerating(): boolean {
      return generating;
    },
  };
}
