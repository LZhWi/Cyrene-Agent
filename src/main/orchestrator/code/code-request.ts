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

import * as chatsStore from "../../chats/chats-store";
import type { ChatSession } from "../../../shared/chat-types";
import { clineRuntime } from "./cline-runtime-manager";
import { codeRunCoordinator } from "./code-run-coordinator";
import { codeRunWorker } from "./code-run-worker";
import { rejectAllAsksOnShutdown } from "./code-ask-bridge";
import { getOrCreateClineSession } from "./code-session-manager";
import { MutationCollector } from "./mutation-collector";
import { normalizeClineEvent, NormalizedClineEvent } from "./code-event-normalizer";
import { buildClineSystemPromptWithPreferences } from "./code-user-preferences";
import { routeCommand, updateSessionClineMode } from "./code-command-router";
import { getCurrentLevel } from "../../permission";
import { loadModelSettings } from "../../index";
import { ClineResultAdapter, CodeRunFacts } from "./cline-result-adapter";

/**
 * 从统一 ModelSettings 读取运行时配置。
 * 默认值补全由 ModelSettingsStore/normalizeModelSettings 负责，Code 层不做二次兜底。
 */
function loadModelRuntimeConfig() {
  const s = loadModelSettings();
  return {
    model: s.model,
    apiKey: s.apiKey,
    baseUrl: s.baseUrl,
    contextWindowTokens: s.contextWindowTokens,
  };
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
  const modelConfig = loadModelRuntimeConfig();
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
    systemPrompt: buildClineSystemPromptWithPreferences(),
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

  // 3. 建立 Mutation baseline + 启动 watcher
  const mutationCollector = new MutationCollector(config.workspaceRoot);
  mutationCollector.recordBaseline();

  // 4. 准备 ClineResultAdapter 用于结构化事实累计
  //（注：事实 adapter 在获取 clineSessionId 后实例化）

  // 5. 通过 codeRunWorker 提交后台任务
  try {
    await codeRunWorker.submit(ctx.runId, ctx.sessionId, "", async () => {
      // 6. 获取或重建 Cline Session
      const clineConfig = buildClineConfig(config, config.workspaceRoot);

      const sessionResult = await getOrCreateClineSession(session, input.text, clineConfig);
      const clineSessionId = sessionResult.sessionId;

      // 更新 clineSessionId 到 record
      codeRunCoordinator.getRun(ctx.runId)!.clineSessionId = clineSessionId;

      // 创建 result adapter
      const resultAdapter = new ClineResultAdapter(ctx.runId, ctx.sessionId, clineSessionId);

      console.log(`[CodeRequest] session: ${clineSessionId}, recovery=${sessionResult.recovery.recoveryMode}`);

      // 7. 订阅事件
      const unsubscribe = clineRuntime.subscribe(clineSessionId, (event: any) => {
        const normalized = normalizeClineEvent(event);
        for (const ne of normalized) {
          resultAdapter.ingest(ne);
          // 收集 mutation candidates
          if (ne.type === "file_candidate") {
            mutationCollector.addCandidate(ne.path);
          }
        }
        // 转发 AG-UI 事件
        emitAgUiEvent(ctx, event);
      });

      try {
        // 8. 提交 Cline turn（后台）
        if (sessionResult.recovery.recoveryMode === "fresh_session") {
          // 新 Session：start 时已传 prompt，不需要 send
        } else {
          // 恢复的 Session：需要 send 用户原始消息（只提交一次）
          await clineRuntime.send({
            sessionId: clineSessionId,
            prompt: input.text,
            mode: config.clineMode,
          });
        }

        const facts = resultAdapter.getFacts();
        console.log(`[CodeRequest] facts: status=${facts.status} commands=${facts.commands.length} hostCancelled=${facts.hostCancelled} hostInterrupted=${facts.hostInterrupted}`);

        // 9. 收集 Mutation evidence（close watcher 在 collect 内部）
        const { evidence, timing } = mutationCollector.collect();
        console.log(`[CodeRequest] mutation: baseline=${timing.baselineMs}ms collect=${timing.collectMs}ms total=${timing.totalMs}ms`);
        console.log(`[CodeRequest] mutationEvidence: created=${evidence.createdFiles.length} modified=${evidence.modifiedFiles.length} deleted=${evidence.deletedFiles.length}`);

        // 10. 发送 mutation 结果
        emitAgUiEvent(ctx, {
          type: "code_mutation_evidence",
          payload: { mutation: evidence, facts },
          runId: ctx.runId,
        });
      } finally {
        unsubscribe();
      }
    });

  } catch (err) {
    console.error(`[CodeRequest] failed:`, err);
    const errMsg = (err as Error).message ?? String(err);
    emitAgUiEvent(ctx, {
      type: "text_message_start",
      messageId: `err-${ctx.runId}`,
      role: "assistant",
      runId: ctx.runId,
    });
    emitAgUiEvent(ctx, {
      type: "text_message_content",
      messageId: `err-${ctx.runId}`,
      delta: `错误: ${errMsg}`,
      runId: ctx.runId,
    });
    emitAgUiEvent(ctx, {
      type: "text_message_end",
      messageId: `err-${ctx.runId}`,
      runId: ctx.runId,
    });
  } finally {
    emitAgUiEvent(ctx, { type: "run_finished", runId: ctx.runId, threadId: ctx.sessionId });
  }
}