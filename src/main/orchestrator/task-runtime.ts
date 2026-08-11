import type { TaskSessionStatus, TaskSubagentType, TaskTranscriptMessage } from "../../shared/task-session";
import { TaskSessionStore } from "../tasks/task-session-store";
import { projectTaskTraceEvent } from "./task-events";
import { getTaskAgentProfile, resolveTaskTools } from "./task-profiles";
import { runCyreneHarness } from "./harness/cyrene-harness";
import type { HarnessInput, HarnessResult } from "./harness/types";
import type { ToolDefinition } from "./tool-registry";
import type { VendorConfig, ChatMessage } from "./vendors/types";
import type { ToolContext } from "./tool-context";

export interface TaskExecuteRequest {
  description: string;
  prompt: string;
  subagentType: TaskSubagentType;
  taskId?: string;
}

export interface TaskExecuteResult {
  taskId: string;
  status: TaskSessionStatus;
  text: string;
}

export interface TaskRuntimeParentContext {
  parentConversationId: string;
  parentRunId: string;
  mode: "work" | "code";
  systemPrompt: string;
  vendorConfig: VendorConfig;
  tools: ToolDefinition[];
  resolvedWorkspaceRoot?: string;
  signal?: AbortSignal;
  checkPermission?: HarnessInput["checkPermission"];
}

function taskStatus(result: HarnessResult): { status: TaskSessionStatus; error?: { code: string; message: string } } {
  const terminal = result.terminal?.status;
  if (terminal === "cancelled" || result.terminateReason === "cancelled") return { status: "cancelled" };
  if (terminal === "timeout" || result.terminateReason === "timeout" || result.terminateReason === "max_rounds") {
    return { status: "failed", error: { code: "TASK_TIMEOUT", message: "子任务超过执行时间或轮数上限" } };
  }
  if (terminal === "runtime_error" || result.terminateReason === "error") {
    return { status: "failed", error: { code: "TASK_RUNTIME_ERROR", message: result.finalAnswer || "子任务运行失败" } };
  }
  return { status: "completed" };
}

function childSystemPrompt(parent: TaskRuntimeParentContext, profilePrompt: string): string {
  const workspace = parent.resolvedWorkspaceRoot
    ? `可信工作目录：${parent.resolvedWorkspaceRoot}`
    : "当前没有绑定工作目录。";
  return `${profilePrompt}\n\n${workspace}\n会话模式：${parent.mode}`;
}

export function createTaskExecutor(input: {
  parent: TaskRuntimeParentContext;
  store: TaskSessionStore;
  runHarness?: typeof runCyreneHarness;
}): (request: TaskExecuteRequest) => Promise<TaskExecuteResult> {
  const runHarness = input.runHarness ?? runCyreneHarness;
  return async (request) => {
    const profile = getTaskAgentProfile(request.subagentType);
    const session = request.taskId
      ? input.store.resume(request.taskId, {
          parentConversationId: input.parent.parentConversationId,
          parentRunId: input.parent.parentRunId,
          subagentType: request.subagentType,
          prompt: request.prompt,
        })
      : input.store.create({
          parentConversationId: input.parent.parentConversationId,
          parentRunId: input.parent.parentRunId,
          description: request.description,
          prompt: request.prompt,
          subagentType: request.subagentType,
          mode: input.parent.mode,
          resolvedWorkspaceRoot: input.parent.resolvedWorkspaceRoot,
        });

    const toolContext: ToolContext = {
      userQuery: request.prompt,
      conversationId: input.parent.parentConversationId,
      runId: session.childRunId,
      signal: input.parent.signal,
      resolvedWorkspaceRoot: input.parent.resolvedWorkspaceRoot,
      mode: input.parent.mode,
    };

    try {
      const result = await runHarness({
        systemPrompt: childSystemPrompt(input.parent, profile.systemPrompt),
        messages: session.messages as ChatMessage[],
        tools: resolveTaskTools(profile, input.parent.tools),
        vendorConfig: input.parent.vendorConfig,
        config: { maxRounds: profile.maxRounds, totalTimeoutMs: profile.timeoutMs },
        signal: input.parent.signal,
        toolContext,
        checkPermission: input.parent.checkPermission,
        onEvent: (event) => {
          const trace = projectTaskTraceEvent(event);
          if (trace) {
            const current = input.store.get(session.id);
            if (current) input.store.checkpoint(session.id, { trace: [...current.trace, trace] });
          }
        },
        onCheckpoint: (checkpoint) => {
          input.store.checkpoint(session.id, {
            messages: checkpoint.messages as TaskTranscriptMessage[],
          });
        },
      });
      const mapped = taskStatus(result);
      input.store.checkpoint(session.id, {
        status: mapped.status,
        resultText: result.finalAnswer,
        ...(mapped.error ? { error: mapped.error } : {}),
        completedAt: Date.now(),
      });
      return { taskId: session.id, status: mapped.status, text: result.finalAnswer };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.store.checkpoint(session.id, {
        status: input.parent.signal?.aborted ? "cancelled" : "failed",
        error: { code: input.parent.signal?.aborted ? "TASK_CANCELLED" : "TASK_RUNTIME_ERROR", message },
        completedAt: Date.now(),
      });
      throw error;
    }
  };
}
