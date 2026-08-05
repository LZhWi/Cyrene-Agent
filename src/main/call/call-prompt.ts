import type { ChatMessage } from "../orchestrator/vendors/types";

export interface CallPromptContent {
  system: string;
  tailAnchor?: string;
  toolSystem?: string;
  /** 主动会话（proactive-chat）最近 N 条历史，拼在通话历史之前作为额外上下文。 */
  proactiveHistory?: ChatMessage[];
}

export function buildCallConversation(
  history: ReadonlyArray<ChatMessage>,
  userText: string,
): ChatMessage[] {
  return [
    ...history,
    { role: "user", content: userText },
  ];
}

export function buildCallMessages(
  prompt: CallPromptContent,
  history: ReadonlyArray<ChatMessage>,
  userText: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "system", content: prompt.system },
    ...history,
    { role: "user", content: userText },
  ];
  const tailAnchor = prompt.tailAnchor?.trim();
  if (tailAnchor) messages.push({ role: "system", content: tailAnchor });
  return messages;
}

export function findLatestChatContextSessionId(
  sessions: ReadonlyArray<{ id: string; updatedAt: number; purpose?: string }>,
): string | null {
  return [...sessions]
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ?? null;
}

export function trimSoulForCall(soul: string): string {
  return soul.split("\n## Live2D 与聊天文字的分工")[0].trim();
}
