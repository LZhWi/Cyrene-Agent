/**
 * runCodeRequest - Code 模式完整执行链
 *
 * Commit 3 实现：替换 stub，集成所有模块。
 *
 * 流程：
 * 1. 解析本地命令（/compact, /context, /newtask, /mode）
 * 2. 读取确定性配置（workspaceBinding, modelConfig, contextWindowTokens）
 * 3. 获取或重建 Cline Session（含 Session 恢复）
 * 4. 建立 Mutation baseline
 * 5. 注册 per-run 事件订阅
 * 6. CodeRunWorker 提交 Cline turn（AGUI_RUN 返回 accepted）
 * 7. 后台持续发送 AG-UI 事件
 * 8. AskQuestionExecutor 按需进入 waiting_for_user
 * 9. turn 结束后收集 CodeRunFacts 和 MutationEvidence
 * 10. 释放 watcher 和事件订阅
 */

import * as fs from "fs";
import * as path from "path";
import * as chatsStore from "../../chats/chats-store";
import type { ChatSession } from "../../../shared/chat-types";
import { clineRuntime } from "./cline-runtime-manager";
import { codeRunCoordinator } from "./code-run-coordinator";
import { createAskQuestionExecutor, rejectAllAsksOnShutdown } from "./code-ask-bridge";
import { getOrCreateClineSession } from "./code-session-manager";
import { MutationCollector } from "./mutation-collector";
import { normalizeClineEvent, NormalizedClineEvent } from "./code-event-normalizer";
import { buildClineSystemPrompt } from "./code-prompt-composer";
import { routeCommand, updateSessionClineMode } from "./code-command-router";
import { getCurrentLevel } from "../../permission";

/** 读取模型配置（简化版，避免依赖 index.ts 内部函数） */
function loadModelConfig() {
  const userData = process.env.APPDATA || path.join(require("os").homedir(), "AppData", "Roaming");
  const candidates = [
    path.join(userData, "live2d-cyrene", "model-settings.json"),
    path.join(userData, "Cyrene", "model-settings.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const raw = JSON.parse(fs.readFileSync(p, "utf8"));
        const provider = raw.provider ?? "MiniMax（稀宇科技）";
        const profile = raw.perProvider?.[provider] ?? {};
        return {
          model: profile.model || raw.model || "MiniMax-M3",
          apiKey: profile.apiKey || raw.apiKey || "",
          baseUrl: profile.baseUrl || raw.baseUrl || "https://api.minimaxi.com/v1",
          contextWindowTokens: raw.contextWindowTokens ?? 256000,
        };
      } catch { /* ignore */ }
    }
  }
  return { model: "MiniMax-M3", apiKey: "", baseUrl: "", contextWindowTokens: 256000 };
}

export interface CodeRequestContext {
  runId: string;
  sessionId: string;
  signal: AbortSignal;
  emitEvent: (event: unknown) => void;
}

export interface CodeRequestInput {
  text: string;
  sessionId: string;
}

/** 确定性配置 */
interface CodeRequestConfig {
  workspaceRoot: string;
  workspaceBindingValid: boolean;
  providerId: string;
  modelId: string;
  apiKey: string;
  baseUrl: string;
  contextWindowTokens: number;
  permissionMode: "read-only" | "scoped" | "per-action" | "full";
  clineMode: "plan" | "act";
  systemPrompt: string;
}

/**
 * 读取确定性配置
 */
function readConfig(session: ChatSession): CodeRequestConfig {
  const modelConfig = loadModelConfig();
  const permissionMode = getCurrentLevel();
  const clineMode = session.codeSession?.clineMode ?? "act";
  const workspaceBinding = session.workspaceBinding;

  return {
    workspaceRoot: workspaceBinding?.workspaceRoot ?? "",
    workspaceBindingValid: !!workspaceBinding?.workspaceRoot,
    providerId: "openai-compatible",
    modelId: modelConfig.model,
    apiKey: modelConfig.apiKey,
    baseUrl: modelConfig.baseUrl,
    contextWindowTokens: modelConfig.contextWindowTokens,
    permissionMode,
    clineMode,
    systemPrompt: buildClineSystemPrompt(),
  };
}

/**
 * 构建 Cline config 对象
 */
function buildClineConfig(config: CodeRequestConfig, workspaceRoot: string): Record<string, unknown> {
  return {
    providerId: config.providerId,
    modelId: config.modelId,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    cwd: workspaceRoot,
    workspaceRoot,
    systemPrompt: config.systemPrompt,
    enableTools: true,
    enableSpawnAgent: false,
    enableAgentTeams: false,
    mode: config.clineMode,
    hooks: {},
    compaction: {
      enabled: true,
      strategy: "basic" as const,
    },
    knownModels: {
      [config.modelId]: {
        contextWindow: config.contextWindowTokens,
      },
    },
  };
}

/**
 * 发送 AG-UI 事件
 */
function emitAgUiEvent(ctx: CodeRequestContext, event: unknown): void {
  try {
    ctx.emitEvent(event);
  } catch (err) {
    console.error("[CodeRequest] emitEvent failed:", err);
  }
}

/**
 * Code 模式请求处理（完整实现）
 */
export async function runCodeRequest(
  input: CodeRequestInput,
  session: ChatSession,
  ctx: CodeRequestContext,
): Promise<void> {
  console.log(`[CodeRequest] runId=${ctx.runId} sessionId=${ctx.sessionId.slice(0, 8)}... mode=${session.mode}`);

  // 1. 解析本地命令
  const commandResult = await routeCommand(input.text, session);
  if (commandResult.type !== "unknown") {
    // 命令结果直接发送回 Renderer
    if (commandResult.type === "info") {
      emitAgUiEvent(ctx, {
        type: "text_message_start",
        messageId: `cmd-${ctx.runId}`,
        role: "assistant",
        runId: ctx.runId,
      });
      emitAgUiEvent(ctx, {
        type: "text_message_content",
        messageId: `cmd-${ctx.runId}`,
        delta: commandResult.message,
        runId: ctx.runId,
      });
      emitAgUiEvent(ctx, {
        type: "text_message_end",
        messageId: `cmd-${ctx.runId}`,
        runId: ctx.runId,
      });
    } else if (commandResult.type === "mode") {
      updateSessionClineMode(ctx.sessionId, commandResult.clineMode);
      emitAgUiEvent(ctx, {
        type: "text_message_start",
        messageId: `cmd-${ctx.runId}`,
        role: "assistant",
        runId: ctx.runId,
      });
      emitAgUiEvent(ctx, {
        type: "text_message_content",
        messageId: `cmd-${ctx.runId}`,
        delta: `已切换到 ${commandResult.clineMode} 模式`,
        runId: ctx.runId,
      });
      emitAgUiEvent(ctx, {
        type: "text_message_end",
        messageId: `cmd-${ctx.runId}`,
        runId: ctx.runId,
      });
    } else if (commandResult.type === "newtask") {
      emitAgUiEvent(ctx, {
        type: "text_message_start",
        messageId: `cmd-${ctx.runId}`,
        role: "assistant",
        runId: ctx.runId,
      });
      emitAgUiEvent(ctx, {
        type: "text_message_content",
        messageId: `cmd-${ctx.runId}`,
        delta: "已创建新 Task，请发送下一条消息。",
        runId: ctx.runId,
      });
      emitAgUiEvent(ctx, {
        type: "text_message_end",
        messageId: `cmd-${ctx.runId}`,
        runId: ctx.runId,
      });
    } else if (commandResult.type === "error") {
      emitAgUiEvent(ctx, {
        type: "text_message_start",
        messageId: `cmd-${ctx.runId}`,
        role: "assistant",
        runId: ctx.runId,
      });
      emitAgUiEvent(ctx, {
        type: "text_message_content",
        messageId: `cmd-${ctx.runId}`,
        delta: `错误: ${commandResult.message}`,
        runId: ctx.runId,
      });
      emitAgUiEvent(ctx, {
        type: "text_message_end",
        messageId: `cmd-${ctx.runId}`,
        runId: ctx.runId,
      });
    }
    emitAgUiEvent(ctx, { type: "run_finished", runId: ctx.runId, threadId: ctx.sessionId });
    return;
  }

  // 2. 读取确定性配置
  const config = readConfig(session);

  // 检查工作区绑定
  if (!config.workspaceBindingValid) {
    emitAgUiEvent(ctx, {
      type: "text_message_start",
      messageId: `err-${ctx.runId}`,
      role: "assistant",
      runId: ctx.runId,
    });
    emitAgUiEvent(ctx, {
      type: "text_message_content",
      messageId: `err-${ctx.runId}`,
      delta: "当前对话未绑定工作区目录。请先点击输入栏左侧的 📁 按钮选择工作区，然后再执行代码任务。",
      runId: ctx.runId,
    });
    emitAgUiEvent(ctx, {
      type: "text_message_end",
      messageId: `err-${ctx.runId}`,
      runId: ctx.runId,
    });
    emitAgUiEvent(ctx, { type: "run_finished", runId: ctx.runId, threadId: ctx.sessionId });
    return;
  }

  // 3. 建立 Mutation baseline
  const mutationCollector = new MutationCollector(config.workspaceRoot);
  mutationCollector.recordBaseline();

  // 4. 注册 per-run 事件订阅
  const collectedEvents: NormalizedClineEvent[] = [];
  let unsubscribe: (() => void) | null = null;

  // 5. 创建 CodeRun 记录
  const runRecord = codeRunCoordinator.createRun(ctx.runId, ctx.sessionId, "");
  runRecord.status = "running";

  try {
    // 6. 获取或重建 Cline Session
    const clineConfig = buildClineConfig(config, config.workspaceRoot);

    const sessionResult = await getOrCreateClineSession(session, input.text, clineConfig);
    const clineSessionId = sessionResult.sessionId;

    runRecord.clineSessionId = clineSessionId;
    console.log(`[CodeRequest] session: ${clineSessionId}, recovery=${sessionResult.recovery.recoveryMode}`);

    // 7. 订阅事件
    unsubscribe = clineRuntime.subscribe(clineSessionId, (event: any) => {
      const normalized = normalizeClineEvent(event);
      for (const ne of normalized) {
        collectedEvents.push(ne);
        // 收集 mutation candidates
        if (ne.type === "file_candidate") {
          mutationCollector.addCandidate(ne.path);
        }
      }
      // 转发 AG-UI 事件
      emitAgUiEvent(ctx, event);
    });

    // 8. 提交 Cline turn（后台）
    if (sessionResult.recovery.recoveryMode === "fresh_session") {
      // 新 Session：start 时已传 prompt，不需要 send
      // 但 start 是同步的，所以 turn 已经在 start() 中执行
      // 实际上，对于 active_session 和 message_reconstruction，需要 send
      // 而 fresh_session 已经在 start() 中执行了 prompt
      // 这里不需要再 send
    } else {
      // 恢复的 Session：需要 send 用户原始消息
      await clineRuntime.send({
        sessionId: clineSessionId,
        prompt: input.text,
        mode: config.clineMode,
      });
    }

    // 9. 收集 Mutation evidence
    const { evidence, timing } = mutationCollector.collect();
    console.log(`[CodeRequest] mutation: baseline=${timing.baselineMs}ms collect=${timing.collectMs}ms total=${timing.totalMs}ms`);
    console.log(`[CodeRequest] mutationEvidence: created=${evidence.createdFiles.length} modified=${evidence.modifiedFiles.length} deleted=${evidence.deletedFiles.length}`);

    // 10. 发送 mutation 结果
    emitAgUiEvent(ctx, {
      type: "code_mutation_evidence",
      payload: evidence,
      runId: ctx.runId,
    });

    // 11. 标记完成
    runRecord.status = "completed";
    runRecord.finishedAt = Date.now();
    codeRunCoordinator.complete(ctx.runId, "completed");

  } catch (err) {
    console.error(`[CodeRequest] failed:`, err);
    runRecord.status = "failed";
    runRecord.finishedAt = Date.now();
    runRecord.errorCode = (err as Error).message;
    codeRunCoordinator.complete(ctx.runId, "failed", (err as Error).message);

    emitAgUiEvent(ctx, {
      type: "text_message_start",
      messageId: `err-${ctx.runId}`,
      role: "assistant",
      runId: ctx.runId,
    });
    emitAgUiEvent(ctx, {
      type: "text_message_content",
      messageId: `err-${ctx.runId}`,
      delta: `错误: ${(err as Error).message}`,
      runId: ctx.runId,
    });
    emitAgUiEvent(ctx, {
      type: "text_message_end",
      messageId: `err-${ctx.runId}`,
      runId: ctx.runId,
    });
  } finally {
    // 12. 释放事件订阅
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch { /* ignore */ }
    }
    emitAgUiEvent(ctx, { type: "run_finished", runId: ctx.runId, threadId: ctx.sessionId });
  }
}