import {
  normalizeSegmentedOutputMode,
  type SegmentedOutputMode,
} from "../../../../../shared/preferences";
import {
  MAX_MESSAGE_SEGMENTS,
} from "../../../../../shared/message-segmentation";

export const MAX_ASSISTANT_REPLY_BUBBLES = MAX_MESSAGE_SEGMENTS;

export function shouldSegmentAssistantReply(
  mode: "chat" | "work" | "code" | "learn",
  preference: SegmentedOutputMode,
): boolean {
  const normalized = normalizeSegmentedOutputMode(preference);
  return normalized === "all" || (normalized === "chat" && mode === "chat");
}

export function segmentAssistantReply(text: string): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (hasStructuredContent(clean)) return [clean];

  const parts = clean
    .split(/\r?\n\s*\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 1) return [clean];

  while (parts.length > MAX_ASSISTANT_REPLY_BUBBLES) {
    const tail = parts.pop();
    if (tail === undefined) break;
    parts[parts.length - 1] += `\n\n${tail}`;
  }
  return parts;
}

export function getAssistantReplyBubbleTexts(
  text: string,
  mode: "chat" | "work" | "code" | "learn",
  preference: SegmentedOutputMode,
): string[] {
  if (!text.trim()) return [];
  return shouldSegmentAssistantReply(mode, preference)
    ? segmentAssistantReply(text)
    : [text];
}

function hasStructuredContent(text: string): boolean {
  if (text.includes("```")) return true;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  if (lines.filter((line) => /^([-*+]\s+|\d+[.)]\s+)/.test(line)).length >= 2) return true;
  if (lines.filter((line) => line.startsWith("|") && line.endsWith("|")).length >= 2) return true;
  return /^\s*[\[{][\s\S]*[\]}]\s*$/.test(text) && text.includes("\n");
}
