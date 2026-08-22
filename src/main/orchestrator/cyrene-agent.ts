// CyreneAgent —— 把两阶段 FC 循环包进 AG-UI 的 AbstractAgent。
//
// 第一期重构：
// - 不再持有 FC 状态机，调用 runTwoPhaseFcLoop（src/main/orchestrator/two-phase-fc-loop.ts）。
// - 工具阶段只携带 tool_system + tools schema；Soul 阶段只携带 soul_systemBase + 工具结果摘要，不携带 tools。
// - runWithEvents 把 TwoPhaseEvent 包装成 AG-UI BaseEvent 转发给渲染端。
//
// 设计要点：
// - FC 循环仍是 stream:false 一次性拿全文（不碰 LLM 层），拿到全文后切成 delta 逐个发
//   TEXT_MESSAGE_CONTENT，这就是"流式感"的来源——标准 AG-UI 做法。
// - run() 不做副作用（不写记忆、不推断表情）。那些在桥层 runAgent 完成后做，
//   保持 agent 纯粹只管"产出事件流"。
// - 错误用 observer.error() 抛，桥层捕获。
import { AbstractAgent, type RunAgentInput } from "@ag-ui/client";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { Observable } from "rxjs";
import { toolRegistry, type ToolDefinition } from "./tool-registry";
import { type ToolCallResult } from "./types";
import { checkPermission, type ToolRiskLevel } from "../permission";
import { getAdapterForConfig, type ChatMessage } from "./vendors";
import { extractLastUserQuery, type ToolContext } from "./tool-context";
import { runHistoryRetrievalV2AutoProbe } from "./history-tools";
import { isRunCancelledError, RunControl } from "../runtime/run-control";
import { modelRuntimeClassForAgentDescription } from "../runtime/model-runtime-coordinator";
import {
  runTwoPhaseFcLoop,
  type TwoPhaseEvent,
  type TwoPhaseFcResult,
} from "./two-phase-fc-loop";

export interface AgentLoopSettings {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  explicitTransport?: "openai" | "anthropic" | "auto";
}

// ── auto_probe 延迟去重 ──
// probe 只写 shadow 日志、不参与回复生成。同一条召回类消息刚跑完 auto_injection
// 全量管线时，紧接着再跑一遍 probe 会在回复窗口内制造第二次 CPU 爆发
//（5 路嵌入 + 重排，ORT 默认吃满全核），挤掉 Live2D/Minecraft 的帧。
// 推迟到空闲窗口，且同一时刻只保留一个待跑 probe，避免连续消息叠加。
const HISTORY_AUTO_PROBE_DELAY_MS = 30_000;
let pendingAutoProbeTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleHistoryRetrievalAutoProbe(userQuery: string, runStartedAt: number): void {
  if (pendingAutoProbeTimer) clearTimeout(pendingAutoProbeTimer);
  pendingAutoProbeTimer = setTimeout(() => {
    pendingAutoProbeTimer = null;
    void runHistoryRetrievalV2AutoProbe(userQuery, 90, runStartedAt).catch((error) => {
      console.warn("[History/RetrievalV2AutoProbe] failed:", error);
    });
  }, HISTORY_AUTO_PROBE_DELAY_MS);
}

/** CyreneAgent.run() 需要的输入——桥层构造好后塞进 input.state 或 forwardedProps。 */
export interface CyreneRunOptions {
  settings: AgentLoopSettings;
  /** 原始消息（不含 system）。FC 循环按阶段动态注入。 */
  messages: ChatMessage[];
  conversationId?: string;
  timeoutMs: number;
  /** 可选：本次 run 的工具集合。未传时使用当前所有已启用工具。 */
  tools?: ToolDefinition[];
  /** 明确意图在首轮必须调用的工具。 */
  requiredToolName?: string;
  /** 直发图片被主模型接口拒绝时，懒加载 caption fallback 消息并重试。 */
  imageCaptionFallback?: () => Promise<ChatMessage[]>;
  /** 工具阶段使用的 system prompt（仅含工具调度规则 + 自动生成的工具目录）。 */
  toolSystemContent: string;
  /** Soul 阶段使用的基础 system prompt（人设 + 环境/记忆/关系/附件）。 */
  soulSystemBaseContent: string;
  /** 可选：Soul 阶段尾部锚点（压缩版硬行为规则，追加在对话之后）。 */
  soulTailAnchorContent?: string;
  socialContext?: import("../social-context").SocialTurnContext;
  /** 仅诊断：显式回忆问题未调用 recall_history 时，回复完成后运行只读 shadow。 */
  enableHistoryRetrievalAutoProbe?: boolean;
}

/** FC 循环最终结果（供桥层做副作用用）。 */
export interface CyreneRunResult {
  reply: string;
  toolResults: ToolCallResult[];
  totalUsage?: { input: number; output: number };
  soulPhaseReason?: "no_tool" | "max_rounds" | "timeout" | "tool_error";
  socialContext?: import("../social-context").SocialTurnContext;
}

const LOG_PREFIX = "[CyreneAgent]";

/**
 * 把 TwoPhaseEvent 包装成 AG-UI BaseEvent。
 */
function toAguiEvent(event: TwoPhaseEvent): BaseEvent {
  switch (event.type) {
    case "step_started":
      return { type: EventType.STEP_STARTED, stepName: event.stepName };
    case "step_finished":
      return { type: EventType.STEP_FINISHED, stepName: event.stepName };
    case "tool_call_start":
      return {
        type: EventType.TOOL_CALL_START,
        toolCallId: event.toolCallId,
        toolCallName: event.toolCallName,
      };
    case "tool_call_result":
      return {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: event.toolCallId,
        messageId: event.messageId,
        content: event.content,
      };
    case "tool_call_end":
      return { type: EventType.TOOL_CALL_END, toolCallId: event.toolCallId };
    case "text_message_start":
      return {
        type: EventType.TEXT_MESSAGE_START,
        messageId: event.messageId,
        role: event.role,
      };
    case "text_message_content":
      return {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: event.messageId,
        delta: event.delta,
      };
    case "text_message_end":
      return { type: EventType.TEXT_MESSAGE_END, messageId: event.messageId };
  }
}

/**
 * 执行一个工具调用，封装权限检查 + toolRegistry 调用 + 异常转 output。
 * 由 runTwoPhaseFcLoop 通过 executeTool 注入回调调用。
 */
async function executeToolCall(
  tc: { id: string; name: string; arguments: string },
  runnableToolIds: Set<string>,
  ctx: ToolContext,
  control: RunControl,
): Promise<string> {
  control.throwIfCancelled();
  const displayTool = toolRegistry.getById(tc.name);
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(tc.arguments || "{}");
  } catch {
    return "[错误] 工具参数解析失败";
  }

  if (!runnableToolIds.has(tc.name)) {
    return "[错误] 工具不可用: " + tc.name;
  }
  const tool = displayTool;
  if (!tool || !tool.enabled) {
    return "[错误] 工具不可用: " + tc.name;
  }

  const risk: ToolRiskLevel = (tool as ToolDefinition & { risk?: ToolRiskLevel }).risk || "safe";
  const perm = await checkPermission({
    toolId: tc.name,
    toolName: tool.name,
    toolDescription: tool.description,
    args,
    risk,
    signal: control.signal,
  });
  control.throwIfCancelled();
  if (!perm.allowed) {
    return "[已拒绝] " + (perm.reason || "权限不足");
  }

  const effectId = tc.id || `${tc.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  control.startEffect({
    id: effectId,
    toolId: tc.name,
    kind: tool.effectKind ?? (
      risk === "fs-read" || risk === "network"
        ? "read"
        : risk === "fs-write"
          ? "mutation"
          : risk === "shell" || risk === "input-control"
            ? "external_side_effect"
            : "unknown"
    ),
  });
  try {
    const output = await tool.execute(args, ctx);
    control.throwIfCancelled();
    control.finishEffect(effectId, "completed");
    return output;
  } catch (err) {
    if (control.signal.aborted || isRunCancelledError(err)) {
      control.finishEffect(effectId, "cancelled");
      throw err;
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    control.finishEffect(effectId, "failed", errMsg);
    return "[工具执行失败] " + errMsg;
  }
}

/**
 * CyreneAgent —— 单次对话一个实例。
 *
 * 用法：
 *   const agent = new CyreneAgent({ threadId });
 *   const result = await agent.runAgentWith(options);  // 跑循环 + 事件流
 */
export class CyreneAgent extends AbstractAgent {
  /** 跑循环结果，run() 完成后可取（供桥层做副作用）。 */
  lastResult?: CyreneRunResult;

  /**
   * 跑 FC 循环并返回事件流。桥层订阅这个流转发给渲染进程。
   * 传入的 options 会原样跑——settings/messages/timeout 都在这里。
   */
  runWithEvents(options: CyreneRunOptions, control = new RunControl()): Observable<BaseEvent> {
    const threadId = this.threadId;
    const runId = control.runId;

    return new Observable<BaseEvent>((subscriber) => {
      let cancelled = false;

      (async () => {
        try {
          const runStartedAt = Date.now();
          subscriber.next({ type: EventType.RUN_STARTED, threadId, runId });

          const adapter = getAdapterForConfig(options.settings);

          const result: TwoPhaseFcResult = await runTwoPhaseFcLoop({
            settings: options.settings,
            adapter,
            messages: options.messages,
            tools: options.tools ?? toolRegistry.getEnabledTools(),
            requiredToolName: options.requiredToolName,
            toolSystemContent: options.toolSystemContent,
            soulSystemBaseContent: options.soulSystemBaseContent,
            soulTailAnchorContent: options.soulTailAnchorContent,
            timeoutMs: options.timeoutMs,
            imageCaptionFallback: options.imageCaptionFallback,
            executeTool: (tc, runnableToolIds) => executeToolCall(
              tc,
              runnableToolIds,
              {
                userQuery: extractLastUserQuery(options.messages),
                conversationId: options.conversationId ?? "default",
                runId,
                signal: control.signal,
                runControl: control,
              },
              control,
            ),
            onEvent: (event) => {
              if (cancelled) return;
              subscriber.next(toAguiEvent(event));
            },
            signal: control.signal,
            runtimeClass: modelRuntimeClassForAgentDescription(this.description),
          });

          this.lastResult = {
            reply: result.reply,
            toolResults: result.toolResults,
            totalUsage: result.totalUsage,
            soulPhaseReason: result.soulPhaseReason,
            socialContext: options.socialContext,
          };

          if (
            options.enableHistoryRetrievalAutoProbe
            && !result.toolResults.some((toolResult) => toolResult.toolId === "recall_history")
          ) {
            // 延迟到空闲窗口跑（见 scheduleHistoryRetrievalAutoProbe 注释），
            // 避免与刚结束的 auto_injection 管线在回复窗口内叠加 CPU 爆发。
            scheduleHistoryRetrievalAutoProbe(extractLastUserQuery(options.messages), runStartedAt);
          }

          if (cancelled) return;
          control.complete();
          subscriber.next({
            type: EventType.RUN_FINISHED,
            threadId,
            runId,
          });
          subscriber.complete();
        } catch (err) {
          if (cancelled) return;
          if (control.signal.aborted || isRunCancelledError(err)) {
            subscriber.error(new Error(`E_RUN_CANCELLED: ${runId}`));
            return;
          }
          console.error(LOG_PREFIX, "run 失败:", err);
          control.complete();
          subscriber.error(err instanceof Error ? err : new Error(String(err)));
        }
      })();

      return () => {
        cancelled = true;
        if (control.status === "active") control.cancel("observable unsubscribed");
      };
    });
  }

  // AbstractAgent 要求实现 run(input)，但我们用 runWithEvents 更直接。
  // 保留 run 作为一个薄封装，供标准 AG-UI 调用路径（暂不用）。
  protected _runOptions?: CyreneRunOptions;
  run(input: RunAgentInput): Observable<BaseEvent> {
    if (!this._runOptions) {
      return new Observable<BaseEvent>((s) => {
        s.error(new Error("CyreneAgent.run 被直接调用，但未设置 _runOptions。请用 runWithEvents。"));
      });
    }
    void input;
    return this.runWithEvents(this._runOptions);
  }
}
