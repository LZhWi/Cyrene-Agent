import { enqueueLLMTask } from "../llm-queue";
import { invokeMemoryStructuredOutput } from "./memory-llm-client";
import {
  parseWikiExtractionResult,
  validateWikiExtractionBusiness,
  type WikiExtractionCandidate,
  type WikiExtractionResult,
} from "./memory-schemas";
import type { WikiChatSourceConversation, WikiChatSourceMessage, WikiChatSourceTurn } from "./wiki-source";
import type { WikiClaimCandidate, WikiTag } from "./wiki-types";
import { workspaceScope } from "./wiki-paths";

const MAX_SLICE_CHARS = 10_000;
const SLICE_OVERLAP_CHARS = 200;
const MAX_BATCH_CHARS = 20_000;
const VALID_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/;

interface SourceSlice {
  sourceId: string;
  role: "user" | "assistant";
  at: number;
  text: string;
  part: number;
}

function isDate(value: string): boolean {
  return !value || (VALID_DATE.test(value) && !Number.isNaN(Date.parse(value)));
}

function sourceSlices(messages: WikiChatSourceMessage[]): SourceSlice[] {
  const slices: SourceSlice[] = [];
  for (const message of messages) {
    if (message.text.length <= MAX_SLICE_CHARS) {
      slices.push({ sourceId: message.sourceId, role: message.role, at: message.at, text: message.text, part: 1 });
      continue;
    }
    let part = 1;
    for (let start = 0; start < message.text.length; start += MAX_SLICE_CHARS - SLICE_OVERLAP_CHARS) {
      slices.push({
        sourceId: message.sourceId,
        role: message.role,
        at: message.at,
        text: message.text.slice(start, start + MAX_SLICE_CHARS),
        part: part++,
      });
    }
  }
  return slices;
}

function batchSlices(slices: SourceSlice[]): SourceSlice[][] {
  const batches: SourceSlice[][] = [];
  let current: SourceSlice[] = [];
  let chars = 0;
  for (const slice of slices) {
    if (current.length > 0 && chars + slice.text.length > MAX_BATCH_CHARS) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(slice);
    chars += slice.text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function toClaimCandidate(
  candidate: WikiExtractionCandidate,
  message: WikiChatSourceMessage,
  conversation: WikiChatSourceConversation,
): WikiClaimCandidate | null {
  if (!message.text.includes(candidate.evidenceQuote)) return null;
  if (Array.from(candidate.evidenceQuote).length > 240) return null;
  if (!isDate(candidate.validFrom) || !isDate(candidate.validTo)) return null;
  if (candidate.scope === "workspace" && !conversation.workspaceRoot) return null;
  if (message.role === "assistant" && (candidate.pageType === "self" || candidate.pageType === "person")) return null;
  const scope = candidate.scope === "workspace"
    ? workspaceScope(conversation.workspaceRoot!)
    : { kind: "global" as const };
  const tags = Array.from(new Set<WikiTag>([conversation.mode, ...candidate.tags]));
  return {
    subject: candidate.pageType === "self" ? "用户本人" : candidate.subject,
    predicate: candidate.predicate,
    value: candidate.value,
    scope,
    statementKind: candidate.statementKind,
    ...(candidate.validFrom ? { validFrom: candidate.validFrom } : {}),
    ...(candidate.validTo ? { validTo: candidate.validTo } : {}),
    tags,
    aliases: candidate.aliases,
    pageType: candidate.pageType,
    source: {
      kind: "chat",
      sourceId: message.sourceId,
      conversationId: message.conversationId,
      messageId: message.entryId,
      revision: String(message.revision),
      assertedAt: message.at,
      sourceRole: message.role,
      evidenceQuote: candidate.evidenceQuote,
    },
    sourceText: message.text,
  };
}

function modelMessages(turns: WikiChatSourceTurn[]): WikiChatSourceMessage[] {
  return turns.flatMap((turn) => [turn.user, ...turn.assistants]);
}

const SYSTEM_PROMPT = [
  "你负责从 Cyrene 的有效聊天中提取可长期复用的知识候选，只返回 JSON。没有值得长期保留的内容时返回 {\"candidates\":[]}。",
  "每条候选必须引用输入中的 sourceId，并逐字摘录该消息中的一小段 evidenceQuote；不能改写引文、编造来源、扩写用户没说过的事实。",
  "用户本人事实以用户发言为证据。助手回复只可作为概念/主题的待核实材料，不能成为用户个人事实；助手建议只有得到用户明确接受，才可提取为项目决策。",
  "区分常住地、此刻所在地、旅行地点和搬家计划。‘我现在在旧金山出差’对应当前所在地，不对应常住地；‘我搬到旧金山了’才更新常住地。",
  "区分当前状态、历史、计划、明确纠错与不确定说法。statementKind 仅用 assertion/change/correction/tentative/historical；明确说‘之前说错了’才用 correction。",
  "subject 是稳定实体名；用户本人用‘用户本人’，项目用规范项目名。predicate 是简短稳定属性名，同义说法使用同一名称，如‘常住地’、‘当前所在地’。",
  "aliases 填聊天原文明确出现的同一实体别名，没有就填空数组；不要推测昵称。",
  "scope 为 global 或 workspace；项目事实、项目决策、工作区代码约定用 workspace。用户偏好和跨项目知识可用 global。没有工作区时只能 global。",
  "pageType 仅用 self/person/concept/topic/project/experience；tags 仅用 chat/learn/work/code。validFrom/validTo 只填原文明确支持的 ISO 日期或日期时间，未知填空字符串。",
  "不要记录寒暄、凭据、令牌、一次性信息、未确认的助手猜测。value 用一句准确的话表达，不引入原文之外的细节。",
].join("\n");

/** Extracts source-grounded candidates. WikiStore owns page mutation and conflict resolution. */
export async function extractWikiClaims(input: {
  conversation: WikiChatSourceConversation;
  turns: WikiChatSourceTurn[];
  signal?: AbortSignal;
}): Promise<WikiClaimCandidate[]> {
  const { conversation, turns, signal } = input;
  if (turns.length === 0) return [];
  const messages = modelMessages(turns);
  const bySourceId = new Map(messages.map((message) => [message.sourceId, message]));
  const output: WikiClaimCandidate[] = [];
  const seen = new Set<string>();
  for (const batch of batchSlices(sourceSlices(messages))) {
    if (signal?.aborted) throw signal.reason ?? new Error("wiki extraction aborted");
    const userPrompt = JSON.stringify({
      conversationId: conversation.conversationId,
      mode: conversation.mode,
      hasWorkspace: Boolean(conversation.workspaceRoot),
      messages: batch.map((item) => ({
        sourceId: item.sourceId,
        role: item.role,
        at: new Date(item.at).toISOString(),
        part: item.part,
        text: item.text,
      })),
    });
    const result = await enqueueLLMTask("WikiMemory", () => invokeMemoryStructuredOutput<WikiExtractionResult>({
      operation: "wiki",
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      maxOutputTokens: 5000,
      signal,
      parseSchema: parseWikiExtractionResult,
      validateBusiness: validateWikiExtractionBusiness,
    }));
    for (const candidate of result.candidates) {
      const message = bySourceId.get(candidate.sourceId);
      if (!message) continue;
      const mapped = toClaimCandidate(candidate, message, conversation);
      if (!mapped) continue;
      const key = JSON.stringify([
        message.sourceId, mapped.subject, mapped.predicate, mapped.value, mapped.statementKind,
      ]);
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(mapped);
    }
  }
  return output;
}
