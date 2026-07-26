// LLM 主动消息路径的 affinity 反馈闭环。
// legacy 预设气泡路径的反馈（startResponseWindow / handleBubbleClick / handleChatWindowOpened）
// 依赖 lastTriggeredScene / responseTimer，只在 tryFire 里设置，对 LLM 路径不生效——
// 本模块为 LLM 路径（markProactiveCommitted 设置的 lastProactiveScene/lastProactiveAt）补上这条线。
//
// 判定规则（每条主动消息最多判定一次，先到先得，用 lastFeedbackJudgedAt 去重）：
//   - 用户回复主动会话 → settleReplyFeedback → applyClickFeedback（正反馈）
//   - 用户点消息下的"忽略"按钮 / 她下一次想开口时发现仍未被回复 → settleIgnoreFeedback（负反馈）
//   - 用户在别处活跃（invalidateForUserMessage 清零 unansweredCount）→ 不判定，中性
//   - 用户删除该条主动消息（rollbackLastProactive 置空 lastProactiveScene）→ 不判定，中性
import type { OpenerState } from "./opener-types";
import { applyClickFeedback, applyIgnoreFeedback } from "./desire-engine";

/** 取待判定反馈的场景 id；无待判定（已回复/已判定/已删除）时返回 null。 */
function getPendingScene(state: OpenerState): string | null {
  if (state.unansweredCount === 0) return null;
  if (state.lastProactiveScene === null || state.lastProactiveAt === null) return null;
  if (state.lastFeedbackJudgedAt === state.lastProactiveAt) return null;
  return state.lastProactiveScene;
}

/** 是否存在待判定反馈的主动消息（已发送、未回复、尚未判定过）。UI 决定是否显示"忽略"按钮用。 */
export function hasPendingFeedback(state: OpenerState): boolean {
  return getPendingScene(state) !== null;
}

/** 用户回复了主动会话 → 正反馈。返回是否实际记账（重复调用/无待判定时为 false）。 */
export function settleReplyFeedback(state: OpenerState): boolean {
  const scene = getPendingScene(state);
  if (scene === null) return false;
  applyClickFeedback(state, scene);
  state.lastFeedbackJudgedAt = state.lastProactiveAt;
  return true;
}

/** 用户点"忽略" / 下一次想开口时发现上一条仍未被回复 → 负反馈。返回是否实际记账。 */
export function settleIgnoreFeedback(state: OpenerState): boolean {
  const scene = getPendingScene(state);
  if (scene === null) return false;
  applyIgnoreFeedback(state, scene);
  state.lastFeedbackJudgedAt = state.lastProactiveAt;
  return true;
}
