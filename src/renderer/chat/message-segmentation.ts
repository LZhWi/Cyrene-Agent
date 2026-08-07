import {
  normalizeSegmentedOutputMode,
  type DefaultChatMode,
  type SegmentedOutputMode,
} from "../../shared/preferences";
import {
  MAX_MESSAGE_SEGMENTS,
  shouldSkipMessageSegmentLeadingChar,
} from "../../shared/message-segmentation";

export const MAX_ASSISTANT_REPLY_BUBBLES = MAX_MESSAGE_SEGMENTS;

export function shouldSegmentAssistantReply(
  chatMode: DefaultChatMode,
  preference: SegmentedOutputMode,
): boolean {
  const mode = normalizeSegmentedOutputMode(preference);
  return mode === "all" || (mode === "chat" && chatMode === "talk");
}

export function shouldSkipStreamingBubbleLeadingChar(char: string, isAtBubbleStart: boolean): boolean {
  return shouldSkipMessageSegmentLeadingChar(char, isAtBubbleStart);
}

/**
 * 流式气泡分段只认「空行」：已缓冲的空白段里含 ≥2 个换行，才算 LLM
 * 自己给出的段落边界。单个换行只是气泡内换行，不触发分段——避免旧的
 * 标点启发式把一句话从中间切断。
 */
export function isStreamingBubbleBoundary(pendingWhitespace: string): boolean {
  let newlines = 0;
  for (const char of pendingWhitespace) {
    if (char === "\n") newlines += 1;
  }
  return newlines >= 2;
}

export function segmentAssistantReply(text: string): string[] {
  const clean = text.trim();
  if (!clean) return [];
  // 代码块/列表/表格等结构化内容不拆，避免破坏排版
  if (hasStructuredContent(clean)) return [clean];

  // 只在「空行」（两个及以上换行，中间允许纯空白行）处分段；
  // 没有空行就整条一个气泡，不再按标点猜句界
  const parts = clean
    .split(/\r?\n\s*\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 1) return [clean];

  // 超出气泡数上限时，把多出的段落并进最后一个气泡
  while (parts.length > MAX_ASSISTANT_REPLY_BUBBLES) {
    const tail = parts.pop();
    if (tail === undefined) break;
    parts[parts.length - 1] += `\n\n${tail}`;
  }
  return parts;
}

export function getAssistantReplyBubbleTexts(
  text: string,
  chatMode: DefaultChatMode,
  preference: SegmentedOutputMode,
  options: { preserveEmpty?: boolean } = {},
): string[] {
  if (!text.trim()) return options.preserveEmpty ? [""] : [];
  return shouldSegmentAssistantReply(chatMode, preference)
    ? segmentAssistantReply(text)
    : [text];
}

function hasStructuredContent(text: string): boolean {
  if (text.includes("```")) return true;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  const listLines = lines.filter((line) => /^([-*+]\s+|\d+[.)]\s+)/.test(line)).length;
  if (listLines >= 2) return true;
  const tableLines = lines.filter((line) => line.startsWith("|") && line.endsWith("|")).length;
  if (tableLines >= 2) return true;
  if (/^\s*[\[{][\s\S]*[\]}]\s*$/.test(text) && text.includes("\n")) return true;
  return false;
}
