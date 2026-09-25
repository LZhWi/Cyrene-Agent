import { randomUUID } from "node:crypto";
import type {
  PluginAssistantMessageFeedbackEvent,
  PluginConversationChangedEvent,
  PluginPromptAcceptedEvent,
  PluginSchedulerFinishedEvent,
  PluginToolFinishedEvent,
  PluginTurnFinishedEvent,
  PluginTurnStartedEvent,
} from "../../plugins/api";

// Omit 直接作用在联合类型上只会保留公共字段，必须分布处理后才能得到各来源分支的完整输入
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type TurnStartedInput = DistributiveOmit<PluginTurnStartedEvent, "eventId" | "timestamp">;
export type TurnFinishedInput = DistributiveOmit<PluginTurnFinishedEvent, "eventId" | "timestamp">;
export type SchedulerFinishedInput = Omit<PluginSchedulerFinishedEvent, "eventId" | "timestamp">;
export type ToolFinishedInput = Omit<PluginToolFinishedEvent, "eventId" | "timestamp">;
export type PromptAcceptedInput = Omit<PluginPromptAcceptedEvent, "eventId" | "timestamp">;
export type AssistantMessageFeedbackInput = Omit<PluginAssistantMessageFeedbackEvent, "eventId" | "timestamp">;
export type ConversationChangedInput = Omit<PluginConversationChangedEvent, "eventId" | "timestamp">;

export interface LifecyclePublisherDeps {
  /** 事件发布入口：接 PluginManager.publishHostEvent（旁路发布，不等待监听器）。 */
  publish: (event: string, payload: unknown) => Promise<void>;
  /** 事件 id 与时间源；默认随机 UUID 与当前时间，可注入以便测试。 */
  eventId?: () => string;
  now?: () => Date;
}

export interface LifecyclePublisher {
  publishTurnStarted(event: TurnStartedInput): void;
  publishTurnFinished(event: TurnFinishedInput): void;
  publishSchedulerFinished(event: SchedulerFinishedInput): void;
  publishToolFinished(event: ToolFinishedInput): void;
  publishPromptAccepted(event: PromptAcceptedInput): Promise<void>;
  publishAssistantMessageFeedback(event: AssistantMessageFeedbackInput): Promise<void>;
  publishConversationChanged(event: ConversationChangedInput): Promise<void>;
}

/**
 * 生命周期事件发布器：统一生成 eventId 与 ISO 时间戳后走旁路发布。
 * 事件不持久化、不重放；发布失败只记录日志，不影响宿主主流程。
 * 插件系统就绪前发布的事件没有监听器，自然丢弃。
 */
export function createLifecyclePublisher(deps: LifecyclePublisherDeps): LifecyclePublisher {
  const nextEventId = deps.eventId ?? (() => randomUUID());
  const now = deps.now ?? (() => new Date());

  function publish(event: string, payload: Record<string, unknown>): void {
    // 元数据放在最后展开，调用方输入无法覆盖 eventId 与 timestamp
    const stamped = { ...payload, eventId: nextEventId(), timestamp: now().toISOString() };
    deps.publish(event, stamped).catch((error) => {
      console.warn(`[plugins] 发布宿主事件 ${event} 失败`, error);
    });
  }

  async function publishAwaited(event: string, payload: Record<string, unknown>): Promise<void> {
    const stamped = { ...payload, eventId: nextEventId(), timestamp: now().toISOString() };
    try {
      await deps.publish(event, stamped);
    } catch (error) {
      console.warn(`[plugins] 发布宿主事件 ${event} 失败`, error);
    }
  }

  return {
    publishTurnStarted(event) {
      publish("turn:started", { ...event });
    },
    publishTurnFinished(event) {
      publish("turn:finished", { ...event });
    },
    publishSchedulerFinished(event) {
      publish("scheduler:finished", { ...event });
    },
    publishToolFinished(event) {
      publish("tool:finished", { ...event });
    },
    publishPromptAccepted(event) {
      return publishAwaited("prompt:accepted", { ...event });
    },
    publishAssistantMessageFeedback(event) {
      return publishAwaited("assistant-message:feedback", { ...event });
    },
    publishConversationChanged(event) {
      return publishAwaited("conversation:changed", { ...event });
    },
  };
}
