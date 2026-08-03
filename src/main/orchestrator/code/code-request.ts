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
import { clineRuntime, type AgentResult } from "./cline-runtime-manager";
import { codeRunCoordinator } from "./code-run-coordinator";
import { codeRunWorker } from "./code-run-worker";
import { getOrCreateClineSession } from "./code-session-manager";
import { MutationCollector } from "./mutation-collector";
import { normalizeClineEvent } from "./code-event-normalizer";
import { buildClineSystemPromptWithPreferences } from "./code-user-preferences";
import { routeCommand, updateSessionClineMode } from "./code-command-router";
import { getCurrentLevel } from "../../permission";
import { loadModelSettings } from "../../index";
import { ClineResultAdapter, CodeRunFacts } from "./cline-result-adapter";
import { VerificationPlanResolver } from "./verification-plan-resolver";
import { VerificationRunner } from "./verification-runner";
import { resolveCodeRunFinalState, type CodeVerificationCard } from "./code-final-state";
import { codeRunStore } from "./code-run-store";
import { createAskQuestionExecutor } from "./code-ask-bridge";

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
      let activeClineSessionId = session.codeSession?.activeClineSessionId ?? "";
      const askQuestion = createAskQuestionExecutor(
        ctx.sessionId,
        () => activeClineSessionId,
        ctx.runId,
        (ask) => emitAgUiEvent(ctx, {
          type: "code_ask",
          payload: ask,
          runId: ctx.runId,
        }),
      );

      // 重要：必须在 getOrCreateClineSession 之前订阅，因为 Cline 的 start(prompt)
      // 会在 startSession() 内部同步执行第一个 turn（executeTurn），turn 期间发出的事件
      // 若此时还没有 listener 就会被丢弃。这里用全局订阅（不按 sessionId 过滤），拿到
      // sessionId 后再在 listener 内按 event.payload.sessionId 过滤。
      let resolvedClineSessionId = "";
      const pendingEvents: any[] = [];
      let capturing = true;
      let resultAdapter: ClineResultAdapter | null = null;
      // assistant 流式输出状态：start/end 必须配对，renderer 才能正确闭合气泡
      const assistantMessageId = `assistant-${ctx.runId}`;
      let assistantStreamStarted = false;
      let assistantStreamEnded = false;
      const startAssistantStream = () => {
        if (assistantStreamStarted) return;
        assistantStreamStarted = true;
        emitAgUiEvent(ctx, {
          type: "text_message_start",
          messageId: assistantMessageId,
          role: "assistant",
          runId: ctx.runId,
        });
      };
      const emitAssistantText = (delta: string) => {
        if (!delta) return;
        startAssistantStream();
        emitAgUiEvent(ctx, {
          type: "text_message_content",
          messageId: assistantMessageId,
          delta,
          runId: ctx.runId,
        });
      };
      const endAssistantStream = () => {
        if (!assistantStreamStarted || assistantStreamEnded) return;
        assistantStreamEnded = true;
        emitAgUiEvent(ctx, {
          type: "text_message_end",
          messageId: assistantMessageId,
          runId: ctx.runId,
        });
      };
      const unsubscribe = clineRuntime.subscribe((event: any) => {
        // sessionId 解析前先缓冲，解析后回放并切到直通模式
        if (capturing || !resultAdapter) {
          pendingEvents.push(event);
          return;
        }
        const evtSessionId = event?.payload?.sessionId ?? event?.sessionId;
        if (evtSessionId && evtSessionId !== resolvedClineSessionId) return;
        const normalized = normalizeClineEvent(event);
        for (const ne of normalized) {
          resultAdapter.ingest(ne);
          if (ne.type === "file_candidate") {
            mutationCollector.addCandidate(ne.path);
          }
          if (ne.type === "text_delta") {
            // 把 Cline 的文本增量直接转成 AG-UI 流式事件，让 renderer 实时看到
            emitAssistantText(ne.text);
          }
        }
        // 监听 agent_event 的 content_end(text)：标记 assistant 流结束
        const ae = event?.payload?.event;
        if (event?.type === "agent_event" && ae?.type === "content_end" && ae?.contentType === "text") {
          endAssistantStream();
        }
        emitAgUiEvent(ctx, event);
      });

      try {
      const sessionResult = await getOrCreateClineSession(
        session,
        input.text,
        clineConfig,
        { toolExecutors: { askQuestion } },
      );
      const clineSessionId = sessionResult.sessionId;
      activeClineSessionId = clineSessionId;
      resolvedClineSessionId = clineSessionId;

      const persistedSession = chatsStore.getSession(ctx.sessionId) ?? session;
      const previousTasks = persistedSession.codeSession?.tasks ?? [];
      const now = Date.now();
      const tasks = previousTasks.map((task) => (
        task.clineSessionId !== clineSessionId && !task.closedAt
          ? { ...task, closedAt: now }
          : task
      ));
      if (!tasks.some((task) => task.clineSessionId === clineSessionId)) {
        tasks.push({ clineSessionId, createdAt: now });
      }
      chatsStore.updateCodeSession(ctx.sessionId, {
        activeClineSessionId: clineSessionId,
        clineMode: config.clineMode,
        tasks,
      });

      // 原子更新 clineSessionId 与活跃映射，避免查询仍指向占位 Session。
      if (!codeRunCoordinator.bindClineSession(ctx.runId, clineSessionId)) {
        throw new Error(`CLINE_SESSION_BIND_FAILED:${clineSessionId}`);
      }

      // 创建 result adapter
      resultAdapter = new ClineResultAdapter(ctx.runId, ctx.sessionId, clineSessionId);

      // 回放在订阅注册后、sessionId 解析前缓冲的事件（仅保留本 session 的）
      capturing = false;
      for (const event of pendingEvents) {
        const evtSessionId = event?.payload?.sessionId ?? event?.sessionId;
        if (evtSessionId && evtSessionId !== resolvedClineSessionId) continue;
        const normalized = normalizeClineEvent(event);
        for (const ne of normalized) {
          resultAdapter.ingest(ne);
          if (ne.type === "file_candidate") {
            mutationCollector.addCandidate(ne.path);
          }
          if (ne.type === "text_delta") {
            emitAssistantText(ne.text);
          }
        }
        const ae = event?.payload?.event;
        if (event?.type === "agent_event" && ae?.type === "content_end" && ae?.contentType === "text") {
          endAssistantStream();
        }
        emitAgUiEvent(ctx, event);
      }
      pendingEvents.length = 0;

      // 8. 提交 Cline turn（后台）
        let turnResult: AgentResult | undefined;
        if (sessionResult.recovery.recoveryMode === "fresh_session") {
          // 新 Session：start 时已传 prompt，第一个 turn 已经在 getOrCreateClineSession 内部跑完
          turnResult = sessionResult.firstTurnResult;
        } else {
          // 恢复的 Session：需要 send 用户原始消息
          turnResult = await clineRuntime.send({
            sessionId: clineSessionId,
            prompt: input.text,
            mode: config.clineMode,
          });
        }
        // 把 turn 结果应用到 facts（finishReason/usage）
        resultAdapter.applyTurnResult(turnResult);

        // Fallback：如果 Cline 没产出 text_delta（例如非流式 provider）但 turnResult 有 text，
        // 就用 AgentResult.text 一次性发给 renderer。
        if (turnResult?.text && !assistantStreamStarted) {
          emitAssistantText(turnResult.text);
        }
        // 收尾 assistant 流（如果 Cline 没通过 content_end(text) 关闭）
        endAssistantStream();

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

        // 11. 验证阶段：解析 + 执行 + 最终裁决
        codeRunCoordinator.setVerifying(ctx.runId);

        const planResolver = new VerificationPlanResolver();
        const plan = planResolver.resolve({
          workspaceRoot: config.workspaceRoot,
          createdFiles: evidence.createdFiles,
          modifiedFiles: evidence.modifiedFiles,
          deletedFiles: evidence.deletedFiles,
          touchedPreExistingFiles: evidence.touchedPreExistingFiles,
        });

        let verificationSummary = null;
        if (plan.errorCode === "VERIFICATION_PLAN_NOT_FOUND") {
          console.log(`[CodeRequest] VERIFICATION_PLAN_NOT_FOUND, diagnostics:`, plan.diagnostics);
          verificationSummary = {
            status: "plan_not_found" as const,
            passed: false,
            steps: [],
            errorCode: "VERIFICATION_PLAN_NOT_FOUND" as const,
          };
        } else if (plan.steps.length > 0) {
          const runner = new VerificationRunner();
          verificationSummary = await runner.runPlan(plan.steps, {
            permissionLevel: config.permissionMode,
            signal: ctx.signal,
            onApprovalRequest: async (step) => {
              codeRunCoordinator.setApprovalRequired(ctx.runId);
              const { approval, decision } = codeRunStore.requestApproval({
                runId: ctx.runId,
                chatSessionId: ctx.sessionId,
                clineSessionId,
                stepId: step.id,
                trust: step.trust as "workspace_script" | "custom",
                executable: step.executable,
                args: step.args,
                cwd: step.cwd,
                source: step.source,
              });
              emitAgUiEvent(ctx, {
                type: "code_verification_approval",
                payload: approval,
                runId: ctx.runId,
              });

              try {
                return await decision;
              } finally {
                if (codeRunCoordinator.isActive(ctx.runId)) {
                  codeRunCoordinator.setVerifying(ctx.runId);
                }
                emitAgUiEvent(ctx, {
                  type: "code_verification_approval",
                  payload: codeRunStore.getApproval(approval.approvalId) ?? approval,
                  runId: ctx.runId,
                });
              }
            },
          });
          console.log(`[CodeRequest] verification: status=${verificationSummary.status} steps=${verificationSummary.steps.length}`);
        }

        // 12. 最终状态裁决
        const finalState = resolveCodeRunFinalState({
          codeRunFacts: facts,
          mutationEvidence: evidence,
          verificationSummary,
        });
        console.log(`[CodeRequest] final: status=${finalState.status}`);

        // 13. 发送确定性结果卡片
        const card: CodeVerificationCard = {
          ...finalState.card,
          workspaceRoot: config.workspaceRoot,
        };
        emitAgUiEvent(ctx, {
          type: "code_verification_card",
          payload: card,
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
