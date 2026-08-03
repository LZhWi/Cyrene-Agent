/**
 * CodeAskBridge - AskQuestionExecutor + 应用级 Deferred Registry
 *
 * PoC 1 确认：
 * - 真正的 Ask 入口是 AskQuestionExecutor，不是 pending_prompts
 * - delivery: "steer" 不是回答 Ask 的接口
 * - AskQuestionExecutor 会阻塞 turn，需要 Deferred + 跨 IPC 桥接
 */

import { codeRunCoordinator } from "./code-run-coordinator";

interface ActiveAsk {
  chatSessionId: string;
  clineSessionId: string;
  runId: string;
  promptId: string;
  question: string;
  options?: string[];
  createdAt: number;
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
}

interface AskCancellationFact {
  promptId: string;
  cancelledBy: "user" | "shutdown" | "session_abort";
  cancelledAt: number;
}

export interface CodeAskPresentation {
  chatSessionId: string;
  clineSessionId: string;
  runId: string;
  promptId: string;
  question: string;
  options: string[];
  createdAt: number;
}

const askRegistry: Map<string, ActiveAsk> = new Map();
const cancelledAsks: Map<string, AskCancellationFact> = new Map();
let askCounter = 0;

/** 生成 promptId */
function generatePromptId(): string {
  return `ask-${++askCounter}-${Date.now()}`;
}

/** 创建 Ask Deferred（由 AskQuestionExecutor 调用） */
export function createAskDeferred(
  chatSessionId: string,
  clineSessionId: string,
  runId: string,
  question: string,
  options?: string[],
): { promptId: string; promise: Promise<string> } {
  const promptId = generatePromptId();
  const promise = new Promise<string>((resolve, reject) => {
    askRegistry.set(promptId, {
      chatSessionId, clineSessionId, runId, promptId, question, options,
      createdAt: Date.now(),
      resolve, reject,
    });
  });
  return { promptId, promise };
}

/** 回答 Ask（由 IPC handler 调用） */
export function respondToAsk(promptId: string, answer: string): boolean {
  const ask = askRegistry.get(promptId);
  if (!ask) return false;
  askRegistry.delete(promptId);
  ask.resolve(answer);
  return true;
}

/** 取消 Ask（用户主动取消） */
export function cancelAsk(promptId: string, cancelledBy: "user" | "shutdown" | "session_abort"): boolean {
  const ask = askRegistry.get(promptId);
  if (!ask) return false;
  askRegistry.delete(promptId);
  cancelledAsks.set(promptId, {
    promptId,
    cancelledBy,
    cancelledAt: Date.now(),
  });
  ask.reject(new Error(`ASK_CANCELLED:${cancelledBy}`));
  return true;
}

/** 检查 Ask 是否被取消 */
export function isAskCancelled(promptId: string): boolean {
  return cancelledAsks.has(promptId);
}

/** 获取 Ask 取消事实 */
export function getAskCancellation(promptId: string): AskCancellationFact | undefined {
  return cancelledAsks.get(promptId);
}

/** 应用退出时统一 reject 所有 pending Ask */
export function rejectAllAsksOnShutdown(): number {
  let count = 0;
  for (const [promptId, ask] of askRegistry) {
    cancelledAsks.set(promptId, {
      promptId,
      cancelledBy: "shutdown",
      cancelledAt: Date.now(),
    });
    // 标记为 interrupted（不是错误），避免 unhandled rejection
    ask.resolve("");
    askRegistry.delete(promptId);
    count++;
  }
  return count;
}

/** 根据 chatSessionId + clineSessionId 查找 pending Ask */
export function findPendingAsk(chatSessionId: string, clineSessionId: string): ActiveAsk | undefined {
  for (const ask of askRegistry.values()) {
    if (ask.chatSessionId === chatSessionId && ask.clineSessionId === clineSessionId) {
      return ask;
    }
  }
  return undefined;
}

/** 获取指定 session 的所有 pending asks */
export function listPendingAsks(chatSessionId?: string): ActiveAsk[] {
  const all = Array.from(askRegistry.values());
  if (!chatSessionId) return all;
  return all.filter(a => a.chatSessionId === chatSessionId);
}

function normalizeAskOptions(options: string[]): string[] {
  const normalized = Array.from(new Set(options.map((option) => option.trim()).filter(Boolean)));
  for (const fallback of ["继续", "暂不处理"]) {
    if (normalized.length >= 2) break;
    if (!normalized.includes(fallback)) normalized.push(fallback);
  }
  return normalized;
}

/** 返回可安全暴露给 Renderer 的 pending Ask 快照。 */
export function listPendingAskPresentations(chatSessionId?: string): CodeAskPresentation[] {
  return listPendingAsks(chatSessionId).map((ask) => ({
    chatSessionId: ask.chatSessionId,
    clineSessionId: ask.clineSessionId,
    runId: ask.runId,
    promptId: ask.promptId,
    question: ask.question,
    options: [...(ask.options ?? [])],
    createdAt: ask.createdAt,
  }));
}

/** 重置（测试用） */
export function resetAskRegistry(): void {
  for (const ask of askRegistry.values()) {
    ask.reject(new Error("ASK_CANCELLED:reset"));
  }
  askRegistry.clear();
  cancelledAsks.clear();
  askCounter = 0;
}

/** 创建 AskQuestionExecutor，注入到 Cline */
export function createAskQuestionExecutor(
  chatSessionId: string,
  clineSessionId: string | (() => string),
  runId: string,
  onAsk?: (ask: CodeAskPresentation) => void,
): (question: string, options: string[]) => Promise<string> {
  return async (question: string, options: string[]): Promise<string> => {
    const resolvedClineSessionId = typeof clineSessionId === "function" ? clineSessionId() : clineSessionId;
    const normalizedOptions = normalizeAskOptions(options ?? []);
    const { promptId, promise } = createAskDeferred(chatSessionId, resolvedClineSessionId, runId, question, normalizedOptions);
    codeRunCoordinator.setWaitingForUser(runId);
    console.log(`[CodeAsk] Ask created: promptId=${promptId} question=${question.slice(0, 50)}`);
    onAsk?.({
      chatSessionId,
      clineSessionId: resolvedClineSessionId,
      runId,
      promptId,
      question,
      options: normalizedOptions,
      createdAt: Date.now(),
    });
    // 持久化 pendingPrompt（应在 ChatSession.codeSession.pendingPrompt 中保存）
    try {
      return await promise;
    } finally {
      codeRunCoordinator.setRunning(runId);
    }
  };
}
