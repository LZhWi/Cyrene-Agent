// AG-UI IPC 桥：按会话模式选择执行链并把事件透传给渲染进程。
//
// 架构：
//   Chat  ──> CyreneAgent ──> 无工具 ChatLoop
//   Work  ──> CyreneAgent ──> LangGraph Runtime
//   Daily ──> CyreneAgent ──> legacy TwoPhaseFC Runtime
//   Code  ──> runCodeRequest() ──> 原生 Cline Runtime
//   Learn ──> legacy TwoPhaseFC Runtime（同 Daily + Obsidian 工具）
//   各链路事件都由本桥通过 AGUI_EVENT 转发给渲染进程。
//
// Chat / Work 的 Observable 是内存流、跨不过进程边界；Code 的后台任务也不能依赖
// WebContents 生命周期。因此主进程统一持有运行并仅把事件发送给 Renderer。
import { ipcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { IPC } from "../shared/ipc-channels";
import { Subscription } from "rxjs";
import { AgentRuntimeError } from "./orchestrator/agent-runtime-error";
import {
  CyreneAgent,
  type AgentExecutionMode,
  type CyreneRunOptions,
  type CyreneRunResult,
} from "./orchestrator/cyrene-agent";
import { indexConversationTurn } from "./orchestrator/history-tools";
import type { RelationshipChannel } from "./relationship/relationship-log";
import { createThinkFilter, type ThinkStreamFilter, type ThinkFilterMode } from "./chat/think-filter";
import { runLearnPostTurnHook } from "./learn/progress/learn-post-turn";
import { obsidianWorkspace } from "./learn/obsidian/obsidian-workspace-service";
import { registerObsidianTools, unregisterObsidianTools } from "./learn/obsidian/obsidian-tools";
import { getAdapterForConfig } from "./orchestrator/vendors";
import { perf } from "./perf-trace";
import type { StyleId } from "../shared/style-sampling";
import { codeRunStore } from "./orchestrator/code/code-run-store";
import { codeRunCoordinator } from "./orchestrator/code/code-run-coordinator";
import * as chatsStore from "./chats/chats-store";
import type { ConversationMode } from "../shared/chat-types";
import { requestUserClarification } from "./user-choice";
import {
  cancelAsk,
  listPendingAskPresentations,
  respondToAsk,
} from "./orchestrator/code/code-ask-bridge";

type RunCodeRequest = typeof import("./orchestrator/code/code-request").runCodeRequest;

/**
 * Code 模式才加载完整 Cline 链。
 * 避免其他模式启动和 AG-UI 单测沿 code-request -> index 形成循环导入。
 */
async function runCodeRequest(...args: Parameters<RunCodeRequest>): Promise<void> {
  const codeRequest = await import("./orchestrator/code/code-request");
  return codeRequest.runCodeRequest(...args);
}

const CODE_RENDERER_EVENT_TYPES: Record<string, string> = {
  text_message_start: "TEXT_MESSAGE_START",
  text_message_content: "TEXT_MESSAGE_CONTENT",
  text_message_end: "TEXT_MESSAGE_END",
  run_finished: "RUN_FINISHED",
  run_error: "RUN_ERROR",
};

export function normalizeCodeRendererEvent(event: unknown, runId?: string): unknown {
  if (!event || typeof event !== "object") return event;
  const typed = event as { type?: string; payload?: unknown };
  if (typed.type === "code_verification_card" || typed.type === "code_verification_approval" || typed.type === "code_mutation_evidence" || typed.type === "code_ask") {
    return {
      type: "CUSTOM",
      name: typed.type,
      value: typed.payload,
      ...("runId" in typed ? { runId: typed.runId } : {}),
    };
  }
  if (typed.type === "agent_event" && typed.payload && typeof typed.payload === "object") {
    const agentEvent = (typed.payload as { event?: unknown }).event;
    if (agentEvent && typeof agentEvent === "object") {
      const content = agentEvent as {
        type?: string;
        contentType?: string;
        text?: string;
        reasoning?: string;
        toolName?: string;
        toolCallId?: string;
        output?: unknown;
        error?: string;
      };
      if (content.type === "content_start" || content.type === "content_update") {
        if (content.contentType === "text" && content.text) {
          return { type: "TEXT_MESSAGE_CONTENT", messageId: runId ? `code-text-${runId}` : undefined, delta: content.text };
        }
        if (content.contentType === "reasoning" && content.reasoning) {
          return { type: "REASONING_MESSAGE_CONTENT", messageId: runId ? `code-reasoning-${runId}` : undefined, delta: content.reasoning };
        }
        if (content.type === "content_start" && content.contentType === "tool") {
          return {
            type: "TOOL_CALL_START",
            toolCallId: content.toolCallId,
            toolCallName: content.toolName,
          };
        }
      }
      if (content.type === "content_end") {
        if (content.contentType === "text") return { type: "TEXT_MESSAGE_END" };
        if (content.contentType === "reasoning") return { type: "REASONING_MESSAGE_END" };
        if (content.contentType === "tool") {
          const result = content.error ?? (
            typeof content.output === "string"
              ? content.output
              : content.output === undefined
                ? ""
                : JSON.stringify(content.output)
          );
          return {
            type: "TOOL_CALL_RESULT",
            toolCallId: content.toolCallId,
            content: result,
            status: content.error ? "failed" : "success",
          };
        }
      }
    }
  }
  const normalizedType = typed.type ? CODE_RENDERER_EVENT_TYPES[typed.type] : undefined;
  return normalizedType ? { ...typed, type: normalizedType } : event;
}

/** 渲染进程发起 run 时传的输入。 */
export interface AguiRunInput {
  messages: unknown[];   // 原始 {role, content}[]，主进程会 normalize
  /** Renderer 已落库的稳定 turn ID；用于 Chat 社交原子的证据锚点。 */
  userTurnId?: string;
  /** 本轮 assistant 占位消息的稳定 turn ID。 */
  assistantTurnId?: string;
  /** 旧版人格 style 文件名；仅保留兼容，不再承担运行模式语义。 */
  style?: string;
  /** 本轮表达风格，与 executionMode 正交。 */
  styleId?: StyleId | string;
  sessionId?: string;    // 会话 ID；桌面运行模式只信任该会话持久化的 mode
  /** 外部渠道入口。桌面聊天不传；微信/飞书用于注入渠道语气规则。 */
  channel?: RelationshipChannel;
  /** @deprecated 仅保留 Renderer 兼容；主进程按 ChatSession.mode 分流并忽略该值。 */
  executionMode?: ConversationMode | "soul-only" | "collaboration";
  /** 主进程内部使用：由 ChatSession.mode 注入，用于选择对应模式的 system prompt。 */
  mode?: ConversationMode;
  /** 本轮附件（文本内容，临时注入系统上下文，不存历史）。 */
  attachments?: { name: string; text: string }[];
  /** 本轮图片附件。主进程会安全读取并转成 OpenAI-compatible image_url content block。 */
  imageAttachments?: { name: string; filePath: string; mime?: string }[];
}

/** 调用方（index.ts）注入：把输入转成 agent 需要的 options（含 system prompt 拼接）。 */
export type BuildOptionsFn = (input: AguiRunInput) => Promise<{
  options: CyreneRunOptions;
  /** 跑完后副作用需要的信息。 */
  latestUserText: string;
}>;

/** 调用方注入：agent 跑完后的副作用（记忆/sticker/表情/广播）。 */
export interface RunFinishedEffects {
  /** 由 bridge 发给本次 AG-UI run 的发起窗口，保证不会落到旧 chatWindow。 */
  sticker?: string | null;
}
export type OnRunFinishedFn = (
  result: CyreneRunResult,
  latestUserText: string,
) => Promise<void | RunFinishedEffects> | void | RunFinishedEffects;

/** 调用方注入：拿聊天窗口（广播副作用用，可空）。 */
export type GetChatWindowFn = () => { webContents: WebContents; isDestroyed(): boolean } | null;

export interface AguiConversationLifecycle {
  onUserMessage(): void;
  onConversationStarted(): void;
  onConversationEnded(): void;
}

/** 单次对话的活跃订阅（用于取消）。键 = runId。 */
const activeRuns = new Map<string, { subscription: Subscription; endLifecycle: () => void }>();

let buildOptionsFn: BuildOptionsFn | null = null;
let getChatWindowFn: GetChatWindowFn = () => null;

/**
 * 注册 AG-UI IPC。由 index.ts 在 app.whenReady() 调一次。
 *
 * @param buildOptions 把渲染进程输入转成 agent options（含上下文构建）
 * @param onRunFinished agent 跑完的副作用（记忆/sticker 等）
 * @param getChatWindow 聊天窗口（事件要发到这里）
 */
export function registerAgUiIpc(
  buildOptions: BuildOptionsFn,
  onRunFinished: OnRunFinishedFn,
  getChatWindow: GetChatWindowFn,
  lifecycle?: AguiConversationLifecycle,
): void {
  buildOptionsFn = buildOptions;
  getChatWindowFn = getChatWindow;

  const onFinished = onRunFinished;
  ipcMain.handle(IPC.AGUI_RUN, async (event: IpcMainInvokeEvent, rawInput: unknown) => {
    if (!buildOptionsFn || !onFinished) {
      throw new Error("AG-UI 桥未初始化");
    }
    lifecycle?.onUserMessage();
    lifecycle?.onConversationStarted();
    perf.beginTurn("desktop");
    const input = rawInput as AguiRunInput;

    // 事件转发目标：优先用 invoke 的 sender（发起 run 的窗口），兜底用聊天窗口
    const sender = event.sender;
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const send = (baseEvent: unknown): void => {
      const targets: WebContents[] = [];
      if (!sender.isDestroyed()) targets.push(sender);
      const chatWin = getChatWindowFn();
      if (chatWin && !chatWin.isDestroyed() && chatWin.webContents !== sender) {
        targets.push(chatWin.webContents);
      }
      for (const t of targets) {
        try {
          t.send(IPC.AGUI_EVENT, baseEvent);
        } catch (err) {
          console.error("[AgUiBridge] send 失败:", (err instanceof Error ? err.message : String(err)), "事件类型=", (baseEvent as { type?: string })?.type);
        }
      }
    };

    // ── 顶层模式分流：读取 ChatSession.mode（唯一可信来源） ──
    // Code 模式完全绕过 CyreneAgent、CITA、WorkLoop
    const sessionId = input.sessionId;
    if (!sessionId) {
      lifecycle?.onConversationEnded();
      throw new Error("AGUI_RUN 缺少 sessionId");
    }
    const session = chatsStore.getSession(sessionId);
    if (!session) {
      lifecycle?.onConversationEnded();
      throw new Error(`AGUI_RUN 会话不存在: ${sessionId}`);
    }
    const mode = session.mode ?? (session.purpose === "proactive-chat" ? "chat" : "work");
    if ((mode === "work" || mode === "code" || mode === "daily" || mode === "learn") && !session.workspaceBinding?.workspaceRoot) {
      lifecycle?.onConversationEnded();
      throw new Error(`${mode} 模式需要先绑定项目工作区`);
    }

    if (mode === "code") {
      console.log("[AgUiBridge] mode=code, dispatching to runCodeRequest (bypass CyreneAgent)");
      const userText = (() => {
        const msgs = input.messages;
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i] as { role?: string; content?: string };
          if (m?.role === "user") return m.content ?? "";
        }
        return "";
      })();
      send({ type: "RUN_STARTED", runId, threadId: sessionId });
      const codeSend = (codeEvent: unknown): void => send(normalizeCodeRendererEvent(codeEvent, runId));
      void runCodeRequest(
        { text: userText, sessionId },
        session,
        { runId, sessionId, signal: new AbortController().signal, emitEvent: codeSend },
      ).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        codeSend({ type: "run_error", message, runId, threadId: sessionId });
      }).finally(() => {
        lifecycle?.onConversationEnded();
      });

      // CodeRunWorker 持有后台任务；Renderer/WebContents 仅接收事件，不拥有任务生命周期。
      return { success: true, runId };
    }

    // ── Chat / Work / Daily / Learn：共用 CyreneAgent 外壳，固定选择各自 runtime ──
    // Chat 走无工具 chat-loop；Work 强制 LangGraph；Daily / Learn 强制 legacy TwoPhaseFC。
    const agentExecutionMode: AgentExecutionMode = mode === "chat" ? "chat" : "work";
    let built;
    try {
    built = await perf.track("build_options", () => buildOptionsFn!({
      ...input,
      mode,
      executionMode: agentExecutionMode,
    }));
    } catch (error) {
      perf.dump();
      lifecycle?.onConversationEnded();
      throw error;
    }
    const { options, latestUserText } = built;
    options.executionMode = agentExecutionMode;
    options.conversationMode = mode;
    options.agentRuntime = (mode === "daily" || mode === "learn") ? "legacy" : "langgraph";
    options.requestUserClarification = (card) => requestUserClarification(card, (cardData) => {
      send({ type: "CUSTOM", name: "cyrene.choice", value: cardData, threadId, runId });
    }, (settlement) => {
      send({ type: "CUSTOM", name: "cyrene.choice.dismiss", value: settlement, threadId, runId });
    }, { runId, revision: 1 });

    // Learn 模式：配置 Obsidian Vault 并注册工具
    if (mode === "learn" && session.workspaceBinding?.workspaceRoot) {
      obsidianWorkspace.configure({
        enabled: true,
        vaultPath: session.workspaceBinding.workspaceRoot,
      });
      try {
        registerObsidianTools();
      } catch (err) {
        console.warn("[Learn] Obsidian 工具注册失败：", err);
      }
    }

    const threadId = `thread-${Date.now()}`;
    const agent = new CyreneAgent({ threadId, description: "Cyrene 主聊天" });

    let pendingRunFinishedEvent: unknown | null = null;
    let lifecycleEnded = false;
    const endLifecycle = (): void => {
      if (lifecycleEnded) return;
      lifecycleEnded = true;
      // Learn 模式：注销 Obsidian 工具
      if (mode === "learn") {
        try { unregisterObsidianTools(); } catch { /* ignore */ }
      }
      lifecycle?.onConversationEnded();
    };

    // <think> 标签过滤器：按单条 assistant message 隔离（TEXT_MESSAGE_START ~ END）
    // leading-only 模式：只在消息开头以 <think> 开头时才过滤，避免误删正文中的 <think> 讨论
    let thinkFilter: ThinkStreamFilter | null = null;
    const thinkFilterMode: ThinkFilterMode = "leading-only";
    let pendingTextStart: { type: string; messageId?: string; [key: string]: unknown } | null = null;
    let textStartForwarded = false;
    let embeddedReasoningStarted = false;
    let embeddedReasoningMessageId = "";
    const forwardTextStart = (): void => {
      if (!pendingTextStart || textStartForwarded) return;
      textStartForwarded = true;
      send(pendingTextStart);
    };
    const forwardEmbeddedReasoning = (delta: string): void => {
      if (!delta) return;
      if (!embeddedReasoningStarted) {
        embeddedReasoningStarted = true;
        embeddedReasoningMessageId = `${pendingTextStart?.messageId ?? runId}-reasoning`;
        send({
          type: "REASONING_MESSAGE_START",
          messageId: embeddedReasoningMessageId,
          role: "reasoning",
          threadId,
          runId,
        });
      }
      send({
        type: "REASONING_MESSAGE_CONTENT",
        messageId: embeddedReasoningMessageId,
        delta,
        threadId,
        runId,
      });
    };
    const endEmbeddedReasoning = (): void => {
      if (!embeddedReasoningStarted) return;
      send({ type: "REASONING_MESSAGE_END", messageId: embeddedReasoningMessageId, threadId, runId });
      embeddedReasoningStarted = false;
    };

    // 订阅 agent 事件流：每个事件透传渲染端；
    // TEXT_MESSAGE_CONTENT 经 <think> 过滤后再转发；
    // complete/error 时做副作用，并补发一个终态事件让渲染端知道这轮结束。
    perf.mark("agent_run_start");
    const sub = agent.runWithEvents(options).subscribe({
      next: (baseEvent) => {
        const eventType = (baseEvent as { type?: string })?.type;

        // sticker / memory 等副作用在 complete 回调里执行。前端收到 RUN_FINISHED 后会收尾并取消监听，
        // 所以必须把 RUN_FINISHED 延后到副作用事件之后发送，否则 cyrene.sticker 会晚到而被丢掉。
        if (eventType === "RUN_FINISHED") {
          // 兜底清理：如果 filter 仍存在（TEXT_MESSAGE_END 缺失），销毁
          endEmbeddedReasoning();
          thinkFilter = null;
          pendingTextStart = null;
          textStartForwarded = false;
          pendingRunFinishedEvent = baseEvent;
          return;
        }

        // <think> 过滤：拦截 TEXT_MESSAGE_* 事件
        if (eventType === "TEXT_MESSAGE_START") {
          thinkFilter = createThinkFilter(thinkFilterMode);
          pendingTextStart = baseEvent as typeof pendingTextStart;
          textStartForwarded = false;
          embeddedReasoningStarted = false;
          embeddedReasoningMessageId = "";
          return;
        }

        if (eventType === "TEXT_MESSAGE_CONTENT") {
          if (!thinkFilter) {
            // 没有 START 边界（异常），原样转发
            send(baseEvent);
            return;
          }
          const event = baseEvent as { type: string; delta?: string };
          const rawDelta = typeof event.delta === "string" ? event.delta : "";
          const visibleDelta = thinkFilter.push(rawDelta);
          forwardEmbeddedReasoning(thinkFilter.takeThinking());
          if (visibleDelta) {
            endEmbeddedReasoning();
            forwardTextStart();
            send({ ...event, delta: visibleDelta });
          }
          // visibleDelta 为空时跳过发送（不产生空 CONTENT 事件）
          return;
        }

        if (eventType === "TEXT_MESSAGE_END") {
          if (thinkFilter) {
            const tail = thinkFilter.flush();
            forwardEmbeddedReasoning(thinkFilter.takeThinking());
            if (tail) {
              endEmbeddedReasoning();
              forwardTextStart();
              // flush 出的尾部文本作为最后一个 CONTENT 发送，确保在 END 之前到达
              send({ type: "TEXT_MESSAGE_CONTENT", delta: tail, threadId, runId });
            }
            thinkFilter = null;
          }
          endEmbeddedReasoning();
          if (textStartForwarded) send(baseEvent);
          pendingTextStart = null;
          textStartForwarded = false;
          return;
        }

        // 其他事件原样透传
        send(baseEvent);
      },
      error: (err) => {
        endEmbeddedReasoning();
        thinkFilter = null; // 错误时丢弃残留 filter 状态
        pendingTextStart = null;
        textStartForwarded = false;
        let message = err instanceof Error ? err.message : String(err);
        // 安全兜底：确保不泄漏原始 DOMException / AbortError 文本
        if (!message || message.includes("This operation was aborted") || message.includes("AbortError")) {
          message = "操作已中断，请重试。";
        }
        console.error("[AgUiBridge] run 失败:", message);
        perf.dump();
        const code = err instanceof AgentRuntimeError ? err.code : undefined;
        // 补发 RUN_ERROR 事件，渲染端据此收尾（invoke 早已 resolve，靠事件驱动）
        send({ type: "RUN_ERROR", message, code, threadId, runId });
        activeRuns.delete(runId);
        endLifecycle();
      },
      complete: async () => {
        perf.mark("agent_run_complete");
        activeRuns.delete(runId);
        try {
          if (agent.lastResult) {
            const lastResult = agent.lastResult;
            const effects = await perf.track("on_run_finished", async () => onFinished(lastResult, latestUserText));
            if (effects?.sticker !== undefined) {
              send({
                type: "CUSTOM",
                name: "cyrene.sticker",
                value: effects.sticker,
                threadId,
                runId,
              });
            }
            // 历史召回用：把这轮对话存入向量库（异步，不阻塞，失败不影响主流程）
            // 放在 onFinished 之后，确保记忆/sticker 等副作用先跑完
            void indexConversationTurn(
              input.sessionId || "default",
              latestUserText,
              lastResult.reply,
            );

            // Learn 模式：静默更新学习进度（异步，不阻塞，失败不影响主流程）
            if (mode === "learn" && obsidianWorkspace.isReady()) {
              const adapter = getAdapterForConfig({
                provider: options.settings.provider,
                baseUrl: options.settings.baseUrl,
                model: options.settings.model,
                apiKey: options.settings.apiKey,
              });
              void runLearnPostTurnHook({
                adapter,
                cfg: {
                  provider: options.settings.provider,
                  baseUrl: options.settings.baseUrl,
                  model: options.settings.model,
                  apiKey: options.settings.apiKey,
                },
                systemPrompt: options.soulSystemBaseContent ?? "",
                userMessage: latestUserText,
                assistantMessage: lastResult.reply,
              });
            }
          }
        } catch (err) {
          console.warn("[AgUiBridge] 副作用失败（不影响结果）:", err);
        }
        if (pendingRunFinishedEvent) {
          send(pendingRunFinishedEvent);
        }
        endLifecycle();
        perf.dump();
      },
    });
    activeRuns.set(runId, { subscription: sub, endLifecycle });

    // invoke 立刻返回 ack，不等 Observable 结束。
    // 终态（RUN_FINISHED/RUN_ERROR）由事件流承载，渲染端据此 offEvent + 收尾。
    // 这样避免 invoke reply 与 send 事件的投递顺序竞争导致 offEvent 提前取消监听。
    return { success: true, runId };
  });

  // ── Code run 状态查询 IPC ────────────────────────────

  ipcMain.handle(IPC.CODE_RUN_GET, (_event, runId: string) => {
    return codeRunStore.getRun(runId) ?? null;
  });

  ipcMain.handle(IPC.CODE_RUN_GET_ACTIVE, (_event, params: { chatSessionId?: string; clineSessionId?: string } = {}) => {
    if (params.chatSessionId) {
      return codeRunStore.getActiveRunByChatSession(params.chatSessionId) ?? null;
    }
    if (params.clineSessionId) {
      return codeRunStore.getActiveRunByClineSession(params.clineSessionId) ?? null;
    }
    return null;
  });

  ipcMain.handle(IPC.CODE_RUN_LIST, (_event, chatSessionId?: string) => {
    return codeRunStore.listRuns(chatSessionId);
  });

  // ── Code 验证审批 IPC ────────────────────────────

  ipcMain.handle(IPC.CODE_VERIFICATION_GET_PENDING, (_event, params: { chatSessionId?: string; runId?: string } = {}) => {
    if (params.runId) {
      return codeRunStore.getPendingApprovalsByRun(params.runId);
    }
    if (params.chatSessionId) {
      return codeRunStore.getPendingApprovalsByChatSession(params.chatSessionId);
    }
    return [];
  });

  ipcMain.handle(IPC.CODE_VERIFICATION_APPROVE, (_event, approvalId: string) => {
    const a = codeRunStore.getApproval(approvalId);
    if (!a) return { ok: false, error: "approval not found" };
    if (a.status === "approved") return { ok: true, approval: a };
    if (a.status !== "pending") return { ok: false, error: `approval already ${a.status}`, approval: a };
    if (!codeRunCoordinator.isActive(a.runId)) {
      return { ok: false, error: "run is terminal", approval: a };
    }
    return { ok: true, approval: codeRunStore.approve(approvalId) };
  });

  ipcMain.handle(IPC.CODE_VERIFICATION_REJECT, (_event, approvalId: string) => {
    const a = codeRunStore.getApproval(approvalId);
    if (!a) return { ok: false, error: "approval not found" };
    if (a.status === "rejected") return { ok: true, approval: a };
    if (a.status !== "pending") return { ok: false, error: `approval already ${a.status}`, approval: a };
    if (!codeRunCoordinator.isActive(a.runId)) {
      return { ok: false, error: "run is terminal", approval: a };
    }
    return { ok: true, approval: codeRunStore.reject(approvalId) };
  });

  // ── Code / Cline Ask IPC ────────────────────────────

  ipcMain.handle(IPC.CODE_ASK_GET_PENDING, (_event, chatSessionId?: string) => {
    return listPendingAskPresentations(chatSessionId);
  });

  ipcMain.handle(IPC.CODE_ASK_RESPOND, (_event, input: { promptId?: string; answer?: string } = {}) => {
    const promptId = input.promptId?.trim();
    const answer = input.answer?.trim();
    if (!promptId || !answer) return { ok: false, error: "promptId and answer are required" };
    return respondToAsk(promptId, answer)
      ? { ok: true }
      : { ok: false, error: "ask not found" };
  });

  ipcMain.handle(IPC.CODE_ASK_CANCEL, (_event, promptId: string) => {
    const normalized = promptId?.trim();
    if (!normalized) return { ok: false, error: "promptId is required" };
    return cancelAsk(normalized, "user")
      ? { ok: true }
      : { ok: false, error: "ask not found" };
  });

  ipcMain.handle(IPC.CODE_SESSION_NEW_TASK, async (_event, chatSessionId: string) => {
    const normalized = chatSessionId?.trim();
    if (!normalized) return { ok: false, error: "chatSessionId is required" };
    const { beginNewCodeTask } = await import("./orchestrator/code/code-command-router");
    return beginNewCodeTask(normalized);
  });

  ipcMain.handle(IPC.AGUI_CANCEL, (_event, runId?: string) => {
    if (runId) {
      const run = activeRuns.get(runId);
      if (run) {
        run.subscription.unsubscribe();
        run.endLifecycle();
        activeRuns.delete(runId);
      }
    } else {
      for (const run of activeRuns.values()) {
        run.subscription.unsubscribe();
        run.endLifecycle();
      }
      activeRuns.clear();
    }
    return true;
  });
}
