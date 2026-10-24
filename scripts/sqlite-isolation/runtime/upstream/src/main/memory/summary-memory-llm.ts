import { invokeMemoryStructuredOutput } from "./memory-llm-client";
import { enqueueLLMTask } from "../llm-queue";
import {
  parseSummaryMemoryResult,
  validateSummaryMemoryBusiness,
  type SummaryMemoryResult,
} from "./memory-schemas";

export interface SummaryMemoryTurnInput {
  userText: string;
  assistantText: string;
}

export async function summarizeMemory(input: {
  sessionSummary: string;
  workspaceSummary: string;
  turns: SummaryMemoryTurnInput[];
  hasWorkspace: boolean;
  signal?: AbortSignal;
}): Promise<SummaryMemoryResult> {
  const systemPrompt = [
    "你负责维护 Cyrene 的 Markdown 记忆文件。只总结输入中明确出现的事实，不推测、不补全未知信息。",
    "sessionSummary 记录当前会话的目标、已完成事项、重要决定、未完成事项和必要上下文；去掉闲聊、重复内容与已经失效的信息。",
    input.hasWorkspace
      ? "workspaceSummary 只记录可供同一项目其他会话复用的稳定项目事实、约定和进展。没有新增长期有效的跨会话事实时，原样保留已有工作区摘要；没有旧摘要且没有新事实时返回空字符串。"
      : "当前没有工作区，workspaceSummary 必须返回空字符串。",
    "输出必须是完整 JSON，包含 sessionSummary 和 workspaceSummary 两个字符串字段。",
    "sessionSummary 最多 800 个 Unicode 字符，workspaceSummary 最多 1200 个 Unicode 字符；不要为了凑长度填充内容。",
  ].join("\n");
  const userPrompt = JSON.stringify({
    currentSessionSummary: input.sessionSummary,
    currentWorkspaceSummary: input.workspaceSummary,
    completedTurns: input.turns.map((turn) => ({ user: turn.userText, assistant: turn.assistantText })),
  });

  return enqueueLLMTask("SummaryMemory", () => invokeMemoryStructuredOutput<SummaryMemoryResult>({
    operation: "summary",
    systemPrompt,
    userPrompt,
    maxOutputTokens: 3000,
    signal: input.signal,
    parseSchema: parseSummaryMemoryResult,
    validateBusiness: (value) => validateSummaryMemoryBusiness(value, {
      sessionChars: 800,
      workspaceChars: input.hasWorkspace ? 1200 : 0,
    }),
  }));
}
