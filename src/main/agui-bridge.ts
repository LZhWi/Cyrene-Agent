// AG-UI IPC 桥：把 CyreneAgent 的事件流透传给渲染进程。
//
// 架构：
//   渲染进程  ──invoke(AGUI_RUN, input)──>  本桥  ──>  CyreneAgent.runWithEvents()
//     ▲                                        │ 订阅 Observable<BaseEvent>
//     └── send(AGUI_EVENT, baseEvent) ─────────┘ 每个 AG-UI 事件转发给渲染进程
//
// Observable 是内存流、跨不过进程边界，所以必须这层桥：
// 主进程订阅 agent 的 events$，每个 BaseEvent 通过 webContents.send 推给渲染进程。
//
// 本桥只管"跑 agent + 转发事件 + 跑完后做副作用"。
// 上下文构建和副作用由调用方（index.ts）注入回调，保持本模块不依赖 index.ts 内部函数。
import { ipcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { IPC } from "../shared/ipc-channels";
import { Subscription } from "rxjs";
import {
  CyreneAgent,
  type CyreneRunOptions,
  type CyreneRunResult,
} from "./orchestrator/cyrene-agent";
import { indexConversationTurn } from "./orchestrator/history-tools";
import type { RelationshipChannel } from "./relationship/relationship-log";
import { isRunCancelledError, RunControl } from "./runtime/run-control";

/** 渲染进程发起 run 时传的输入。 */
export interface AguiRunInput {
  runId?: string;
  messages: unknown[];   // 原始 {role, content}[]，主进程会 normalize
  style: string;         // 人格 style 文件名
  sessionId?: string;    // 会话 ID，用于历史召回按会话隔离（可选，默认 "default"）
  /** 外部渠道入口。桌面聊天不传；微信/飞书用于注入渠道语气规则。 */
  channel?: RelationshipChannel;
  /** 本轮附件（文本内容，临时注入系统上下文，不存历史）。 */
  userTurnId?: string;
  assistantTurnId?: string;
  attachments?: { name: string; text: string }[];
  /** 本轮图片附件。主进程会安全读取并转成 OpenAI-compatible image_url content block。 */
  imageAttachments?: { name: string; filePath: string; mime?: string }[];
}

/** 调用方（index.ts）注入：把输入转成 agent 需要的 options（含 system prompt 拼接）。 */
export type BuildOptionsFn = (input: AguiRunInput) => Promise<{
  options: CyreneRunOptions;
  /** 跑完后副作用需要的信息。 */
  latestUserText: string;
  /** 仅供 MemoryJudge 的额外上下文，不参与其他聊天副作用。 */
  memoryContextText?: string;
}>;

/** 调用方注入：agent 跑完后的副作用（记忆/sticker/表情/广播）。 */
export type OnRunFinishedFn = (
  result: CyreneRunResult,
  latestUserText: string,
  memoryContextText?: string,
) => Promise<void> | void;

/** 调用方注入：拿聊天窗口（广播副作用用，可空）。 */
export type GetChatWindowFn = () => { webContents: WebContents; isDestroyed(): boolean } | null;

export interface AguiConversationLifecycle {
  onUserMessage(): void;
  onConversationStarted(): void;
  onConversationEnded(): void;
}

/** 单次对话的活跃订阅（用于取消）。键 = runId。 */
interface ActiveAguiRun {
  subscription?: Subscription;
  endLifecycle: () => void;
  control: RunControl;
  senderId: number;
  send: (event: unknown) => void;
}

const activeRuns = new Map<string, ActiveAguiRun>();
const reservedRuns = new Map<string, ActiveAguiRun>();

let buildOptionsFn: BuildOptionsFn | null = null;
let getChatWindowFn: GetChatWindowFn = () => null;

/** 应用退出时中止所有尚未完成的桌面对话，不再向正在销毁的窗口发送终态事件。 */
export function shutdownAgUiBridge(): number {
  const runs = new Set([...reservedRuns.values(), ...activeRuns.values()]);
  reservedRuns.clear();
  activeRuns.clear();
  for (const run of runs) {
    run.control.cancel("application shutdown");
    run.subscription?.unsubscribe();
    run.endLifecycle();
  }
  return runs.size;
}

function requestedRunId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^run-[A-Za-z0-9-]{8,80}$/.test(value)) {
    throw new Error("E_INVALID_RUN_ID");
  }
  if (activeRuns.has(value) || reservedRuns.has(value)) throw new Error("E_RUN_ID_CONFLICT");
  return value;
}

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
    const input = rawInput as AguiRunInput;
    const control = new RunControl(requestedRunId(input.runId));
    const runId = control.runId;
    const sender = event.sender;
    const send = (baseEvent: unknown): void => {
      const targets: WebContents[] = [];
      if (!sender.isDestroyed()) targets.push(sender);
      const chatWin = getChatWindowFn();
      if (chatWin && !chatWin.isDestroyed() && chatWin.webContents !== sender) {
        targets.push(chatWin.webContents);
      }
      for (const target of targets) {
        try {
          target.send(IPC.AGUI_EVENT, baseEvent);
        } catch (err) {
          console.error("[AgUiBridge] send 失败:", (err instanceof Error ? err.message : String(err)), "事件类型=", (baseEvent as { type?: string })?.type);
        }
      }
    };
    let lifecycleEnded = false;
    const endLifecycle = (): void => {
      if (lifecycleEnded) return;
      lifecycleEnded = true;
      lifecycle?.onConversationEnded();
    };
    const reservedRun: ActiveAguiRun = {
      endLifecycle,
      control,
      senderId: sender.id,
      send,
    };
    reservedRuns.set(runId, reservedRun);
    lifecycle?.onUserMessage();
    lifecycle?.onConversationStarted();
    let built;
    try {
      built = await buildOptionsFn(input);
      control.throwIfCancelled();
    } catch (error) {
      reservedRuns.delete(runId);
      endLifecycle();
      throw error;
    }
    reservedRuns.delete(runId);
    const { options, latestUserText, memoryContextText } = built;

    const threadId = `thread-${Date.now()}`;
    const agent = new CyreneAgent({ threadId, description: "Cyrene 主聊天" });

    let pendingRunFinishedEvent: unknown | null = null;

    // 订阅 agent 事件流：每个事件透传渲染端；
    // complete/error 时做副作用，并补发一个终态事件让渲染端知道这轮结束。
    const activeRun: ActiveAguiRun = {
      endLifecycle,
      control,
      senderId: sender.id,
      send,
    };
    activeRuns.set(runId, activeRun);

    const sub = agent.runWithEvents(options, control).subscribe({
      next: (baseEvent) => {
        const eventWithRun = baseEvent && typeof baseEvent === "object"
          ? { ...(baseEvent as Record<string, unknown>), threadId, runId }
          : baseEvent;
        // sticker / memory 等副作用在 complete 回调里执行。前端收到 RUN_FINISHED 后会收尾并取消监听，
        // 所以必须把 RUN_FINISHED 延后到副作用事件之后发送，否则 cyrene.sticker 会晚到而被丢掉。
        if ((baseEvent as { type?: string })?.type === "RUN_FINISHED") {
          pendingRunFinishedEvent = eventWithRun;
          return;
        }
        send(eventWithRun);
      },
      error: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[AgUiBridge] run 失败:", message);
        // 补发 RUN_ERROR 事件，渲染端据此收尾（invoke 早已 resolve，靠事件驱动）
        send({ type: "RUN_ERROR", error: message, threadId, runId });
        activeRuns.delete(runId);
        control.complete();
        endLifecycle();
      },
      complete: async () => {
        try {
          control.throwIfCancelled();
          if (agent.lastResult) {
            await onFinished(agent.lastResult, latestUserText, memoryContextText);
            control.throwIfCancelled();
            // 历史召回用：把这轮对话存入向量库（异步，不阻塞，失败不影响主流程）
            // 放在 onFinished 之后，确保记忆/sticker 等副作用先跑完
            void indexConversationTurn(
              input.sessionId || "default",
              latestUserText,
              agent.lastResult.reply,
              { userTurnId: input.userTurnId, assistantTurnId: input.assistantTurnId },
            );
          }
        } catch (err) {
          if (control.signal.aborted || isRunCancelledError(err)) return;
          console.warn("[AgUiBridge] 副作用失败（不影响结果）:", err);
        } finally {
          activeRuns.delete(runId);
          if (!control.signal.aborted) {
            if (pendingRunFinishedEvent) send(pendingRunFinishedEvent);
            control.complete();
          }
          endLifecycle();
        }
      },
    });
    activeRun.subscription = sub;
    if (control.status !== "active") activeRuns.delete(runId);

    // invoke 立刻返回 ack，不等 Observable 结束。
    // 终态（RUN_FINISHED/RUN_ERROR）由事件流承载，渲染端据此 offEvent + 收尾。
    // 这样避免 invoke reply 与 send 事件的投递顺序竞争导致 offEvent 提前取消监听。
    return { success: true, runId };
  });

  ipcMain.handle(IPC.AGUI_CANCEL, (event: IpcMainInvokeEvent, payload: { runId?: unknown }) => {
    const runId = typeof payload?.runId === "string" ? payload.runId : "";
    const run = activeRuns.get(runId) ?? reservedRuns.get(runId);
    if (!run || run.senderId !== event.sender.id) return false;
    run.control.cancel("renderer requested cancellation");
    run.send({
      type: "RUN_ERROR",
      code: "E_RUN_CANCELLED",
      error: "已取消",
      content: "已取消",
      runId,
    });
    run.subscription?.unsubscribe();
    run.endLifecycle();
    activeRuns.delete(runId);
    return true;
  });
}
