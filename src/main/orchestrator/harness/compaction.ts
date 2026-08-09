/**
 * 循环内上下文压缩（v3 §10.6）
 *
 * 三件事：
 * 1. 循环内检查点（每轮 callLLM 前检查，阈值 0.7）
 * 2. 配对安全切点（不切断 tool_call / tool_result 配对）
 * 3. agent 导向压缩 prompt
 *
 * 底座复用 context-manager.ts 的 estimateTokens / estimateMessageTokens。
 */

import type { ChatMessage } from "../vendors/types";
import { estimateTokens, estimateMessageTokens } from "../context-manager";

// ── Token 预算计算（v3 §10.6）─────────────────────────────

export interface TokenBudget {
  /** 可用输入预算 = contextWindow - reservedOutput - safetyMargin */
  usableInputBudget: number;
  /** 估算的输入 token（system + toolSchemas + messages） */
  estimatedInput: number;
  /** 是否需要压缩 */
  needsCompaction: boolean;
}

/**
 * 计算 token 预算并判断是否需要压缩（v3 §10.6）。
 *
 * @param systemPrompt 系统提示词
 * @param toolSchemas 工具 schema 列表
 * @param messages 消息列表
 * @param contextWindow 上下文窗口大小
 * @param reservedOutput 为 LLM 回复预留的 token
 * @param safetyMargin 固定安全余量
 * @param threshold 压缩触发阈值（默认 0.7）
 */
export function computeTokenBudget(
  systemPrompt: string,
  toolSchemas: Array<{ name: string; description: string; parameters: object }>,
  messages: ChatMessage[],
  contextWindow: number,
  reservedOutput: number,
  safetyMargin: number,
  threshold = 0.7,
): TokenBudget {
  const systemTokens = estimateTokens(systemPrompt);
  const schemaTokens = toolSchemas.reduce(
    (sum, s) => sum + estimateTokens(s.name + s.description + JSON.stringify(s.parameters)),
    0,
  );
  const messageTokens = estimateMessageTokens(messages);

  const usableInputBudget = contextWindow - reservedOutput - safetyMargin;
  const estimatedInput = systemTokens + schemaTokens + messageTokens;

  return {
    usableInputBudget,
    estimatedInput,
    needsCompaction: estimatedInput >= usableInputBudget * threshold,
  };
}

// ── 配对安全切点（v3 §10.6 第2点）────────────────────────

/**
 * 找到配对安全的压缩切点。
 *
 * 规则：从保留边界往前退，直到落在 "user 消息" 或 "无 tool_calls 的 assistant" 上。
 * 保证 assistant.tool_calls 和对应的 tool result 永远在同一块里。
 *
 * @param messages 完整消息列表
 * @param keepRecentCount 保留最近 N 条消息
 * @returns 被压缩段的结束索引（ exclusive），messages[0:cutIndex] 被压缩
 */
export function findSafeCutPoint(
  messages: ChatMessage[],
  keepRecentCount: number,
): number {
  if (messages.length <= keepRecentCount) return 0;

  // 初始切点：保留最近 keepRecentCount 条
  let cutIndex = messages.length - keepRecentCount;

  // 往前退，直到落在安全位置
  while (cutIndex > 0) {
    const msg = messages[cutIndex];

    // 安全位置 1: user 消息
    if (msg.role === "user") break;

    // 安全位置 2: 无 tool_calls 的 assistant 消息
    if (msg.role === "assistant" && (!msg.toolCalls || msg.toolCalls.length === 0)) break;

    // 安全位置 3: system 消息（不太可能，但理论上安全）
    if (msg.role === "system") break;

    // 不安全：tool 消息或带 tool_calls 的 assistant → 继续往前退
    cutIndex--;
  }

  return cutIndex;
}

// ── Agent 导向压缩 prompt（v3 §10.6 第3点）───────────────

export const AGENT_COMPACTION_PROMPT = `你正在帮 Agent 整理执行历史的摘要。请把下面这段较早的执行历史总结成一段简洁的摘要，供后续继续执行参考。

要求：
1. 保留用户的核心目标、当前任务、未完成的待办事项。
2. **保留已执行的工具操作序列及其确定性结果**（文件路径、命令、退出码、错误信息）。
3. 保留已确认的事实和数据（如路径、文件名、参数值）。
4. 保留 todo 状态和未确认的 uncertain effects（已发起但结果未知的副作用）。
5. 删除模型自言自语、重复确认、过渡性语句。
6. 如果对话中包含代码/命令，只保留最终生效的版本和用途说明。
7. 摘要控制在 400~600 字以内，用中文输出。

执行历史：
{history}

请直接输出摘要内容，不要加任何前缀说明。`;

// ── 压缩执行 ─────────────────────────────────────────────

export interface CompactionOptions {
  systemPrompt: string;
  toolSchemas: Array<{ name: string; description: string; parameters: object }>;
  messages: ChatMessage[];
  contextWindow: number;
  reservedOutput: number;
  safetyMargin: number;
  threshold: number;
  keepRecentCount: number;
  /** 压缩回调：把待压缩的文本摘要成一段 */
  summarize: (history: string) => Promise<string>;
}

/**
 * 执行循环内压缩（v3 §10.6）。
 *
 * 1. 找配对安全切点
 * 2. 被压缩段走摘要
 * 3. 保留段原样
 * 4. 永远不存在孤儿 tool_call 或孤儿 tool result
 */
export async function compressForAgentLoop(
  options: CompactionOptions,
): Promise<ChatMessage[]> {
  const { messages, keepRecentCount, summarize } = options;

  if (messages.length <= keepRecentCount) return messages;

  // 找配对安全切点
  const cutIndex = findSafeCutPoint(messages, keepRecentCount);
  if (cutIndex === 0) return messages; // 无法安全切分

  const toCompress = messages.slice(0, cutIndex);
  const toKeep = messages.slice(cutIndex);

  // 格式化待压缩段
  const history = toCompress
    .map((m) => {
      const role = m.role === "user" ? "用户" : m.role === "assistant" ? "Agent" : m.role;
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      let line = `--- ${role} ---\n${text}`;
      if (m.toolCalls?.length) {
        line += `\n[工具调用: ${m.toolCalls.map((t) => t.name).join(", ")}]`;
      }
      return line;
    })
    .join("\n\n");

  try {
    const summary = await summarize(history);
    const summaryMessage: ChatMessage = {
      role: "system",
      content: `[执行历史摘要]\n${summary}`,
    };
    return [summaryMessage, ...toKeep];
  } catch {
    // 压缩失败：兜底丢弃最旧（保留 recent）
    return toKeep;
  }
}
