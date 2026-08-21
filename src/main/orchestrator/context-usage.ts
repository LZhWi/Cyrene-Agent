// 上下文容量快照计算：把一轮请求的上下文按 5 类拆分 token 估算。
//
// 设计要点（docs/context-usage-viewer-construction-plan.md）：
// - 复用 context-manager 的 estimateTokens，与 computeTokenBudget 同公式，不做精确 tokenizer；
//   快照仅用于展示，不参与任何截断/压缩决策。
// - 消息分类判定优先级（钉死，勿改顺序）：
//   1. compaction checkpoint → conversation（优先级最高，杜绝与 internal 规则打架）
//   2. role === "tool" → runtimeAndToolLogs
//   3. visibility === "internal" → runtimeAndToolLogs
//   4. user / assistant / 其余 system → conversation
//   5. 未识别形状 → other（仅格式开销兜底计入）
// - chat 模式不变量：messages 不得包含 composePromptLayers 追加的 <runtime_context>
//   尾部消息，runtimeContext 由独立参数计量，否则双重计数。

import type { ChatMessage } from "./vendors/types";
import { estimateTokens } from "./context-manager";
import { isCompactionCheckpointMessage } from "./harness/compaction";
import type {
  ContextUsageCategory,
  ContextUsageCategoryKey,
  ContextUsagePhase,
  ContextUsageSnapshot,
} from "../../shared/context-usage";

const CATEGORY_KEYS: readonly ContextUsageCategoryKey[] = [
  "systemPrompt",
  "toolDefinitions",
  "runtimeAndToolLogs",
  "conversation",
  "other",
];

export interface ContextUsageSnapshotInput {
  phase: ContextUsagePhase;
  runId?: string;
  round?: number;
  contextWindowTokens: number;
  /** 人设层文本（系统提示词类）。 */
  personaContent: string;
  /** 工具规则/目录/使用规范文本；缺省为空。 */
  toolLayerContent?: string;
  /** 工具 schema 列表；chat 模式不传。 */
  toolSpecs?: Array<{ name: string; description: string; parameters: object }>;
  /** chat 模式请求尾部注入的 runtime context 文本；harness 模式不传（已物化进消息）。 */
  runtimeContext?: string;
  /**
   * 本轮基础消息列表。
   * 不变量：chat 模式不得包含 composePromptLayers 追加的 <runtime_context> 尾部消息，
   * runtimeContext 由独立参数计量，避免双重计数。
   */
  messages: ChatMessage[];
}

function classifyMessage(message: ChatMessage): ContextUsageCategoryKey {
  if (isCompactionCheckpointMessage(message)) return "conversation";
  if (message.role === "tool") return "runtimeAndToolLogs";
  if (message.visibility === "internal") return "runtimeAndToolLogs";
  if (message.role === "user" || message.role === "assistant" || message.role === "system") {
    return "conversation";
  }
  return "other";
}

export function buildContextUsageSnapshot(input: ContextUsageSnapshotInput): ContextUsageSnapshot {
  const buckets: Record<ContextUsageCategoryKey, number> = {
    systemPrompt: 0,
    toolDefinitions: 0,
    runtimeAndToolLogs: 0,
    conversation: 0,
    other: 0,
  };

  buckets.systemPrompt += estimateTokens(input.personaContent);
  buckets.toolDefinitions += estimateTokens(input.toolLayerContent ?? "");
  for (const spec of input.toolSpecs ?? []) {
    // 与 computeTokenBudget 同公式。
    buckets.toolDefinitions += estimateTokens(spec.name + spec.description + JSON.stringify(spec.parameters));
  }
  if (input.runtimeContext?.trim()) {
    // 与 composePromptLayers 的 wire 包装一致，含标签开销。
    buckets.runtimeAndToolLogs += estimateTokens(
      `<runtime_context>\n${input.runtimeContext.trim()}\n</runtime_context>`,
    );
  }

  for (const message of input.messages) {
    const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    // +4 为角色/格式开销，与 estimateMessageTokens 一致。
    buckets[classifyMessage(message)] += estimateTokens(text) + 4;
  }

  const categories: ContextUsageCategory[] = CATEGORY_KEYS.map((key) => ({ key, tokens: buckets[key] }));
  return {
    phase: input.phase,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(typeof input.round === "number" ? { round: input.round } : {}),
    contextWindowTokens: input.contextWindowTokens,
    totalTokens: categories.reduce((sum, category) => sum + category.tokens, 0),
    categories,
    messageCount: input.messages.length,
    updatedAt: Date.now(),
  };
}
