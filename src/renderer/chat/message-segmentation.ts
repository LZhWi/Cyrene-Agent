import {
  normalizeSegmentedOutputMode,
  type DefaultChatMode,
  type SegmentedOutputMode,
} from "../../shared/preferences";

const SHORT_REPLY_LIMIT = 90;
const MIN_PART_LENGTH = 35;
const IDEAL_MIN = 55;
const HARD_MAX = 130;
const STRONG_PAUSE = /[。！？!?♪～~]/;
const WEAK_PAUSE = /[，,；;：:]/;

export function shouldSegmentAssistantReply(
  chatMode: DefaultChatMode,
  preference: SegmentedOutputMode,
): boolean {
  const mode = normalizeSegmentedOutputMode(preference);
  return mode === "all" || (mode === "chat" && chatMode === "talk");
}

export function segmentAssistantReply(text: string): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length < SHORT_REPLY_LIMIT || hasStructuredContent(clean)) return [clean];

  const maxParts = chooseMaxParts(clean.length);
  const targetLength = Math.ceil(clean.length / maxParts);
  const roughParts = splitByNaturalPauses(clean, targetLength, maxParts);
  const merged = mergeTinyParts(roughParts, maxParts);
  return merged.length > 1 ? merged : [clean];
}

function chooseMaxParts(length: number): number {
  if (length <= 220) return 2;
  if (length <= 380) return 3;
  return 4;
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

function splitByNaturalPauses(text: string, targetLength: number, maxParts: number): string[] {
  const parts: string[] = [];
  let buffer = "";

  for (const char of text) {
    buffer += char;
    const remainingSlots = maxParts - parts.length - 1;
    if (remainingSlots <= 0) continue;

    const len = buffer.length;
    const canSplitStrong = len >= IDEAL_MIN && STRONG_PAUSE.test(char);
    const canSplitWeak = len >= targetLength && WEAK_PAUSE.test(char);
    const mustSplit = len >= HARD_MAX && (STRONG_PAUSE.test(char) || WEAK_PAUSE.test(char));

    if (canSplitStrong || canSplitWeak || mustSplit) {
      parts.push(buffer);
      buffer = "";
    }
  }

  if (buffer) parts.push(buffer);
  return parts;
}

function mergeTinyParts(parts: string[], maxParts: number): string[] {
  const merged: string[] = [];
  for (const part of parts) {
    const previous = merged.at(-1);
    if (previous !== undefined && (part.length < MIN_PART_LENGTH || previous.length < MIN_PART_LENGTH)) {
      merged[merged.length - 1] = previous + part;
    } else {
      merged.push(part);
    }
  }

  while (merged.length > maxParts) {
    const tail = merged.pop();
    if (tail === undefined) break;
    merged[merged.length - 1] += tail;
  }

  return merged;
}
