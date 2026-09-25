import path from "node:path";
import type {
  PluginCompanionContextService,
  PluginProactiveDocumentContextService,
  PluginLlmService,
  PluginScreenObservationService,
  PluginUserPresenceService,
  PluginWeatherContextService,
} from "../../plugins/api";
import type { PluginHostServiceFactory } from "../../plugins/context";
import type { ChatSession, ChatSessionMeta } from "../../shared/chat-types";
import {
  createPluginConversationsService,
  type PluginChatsStoreReader,
} from "./conversations-service";
import {
  createPluginAssistantDeliveryService,
  type PluginAssistantDeliverySink,
} from "./assistant-delivery-service";
import { createPluginSchedulerService, type PluginSchedulerStore } from "./scheduler-service";
import { createPluginSecretsService, type SafeStorageLike } from "./secrets-service";
import type { SpeechInputService } from "./speech-input-service";
import {
  createPluginWorkspaceService,
  type PluginWorkspaceStoreReader,
} from "./workspace-service";
import { pluginHostError } from "./errors";
import { createPluginMemoryRetrievalService } from "./memory-retrieval-service";

/** 宿主服务装配所需的会话存储只读视图（列表 + 会话 + 工作区绑定）。 */
export interface PluginHostChatsReader
  extends PluginChatsStoreReader, PluginWorkspaceStoreReader {}

export interface PluginHostServicesOptions {
  /** plugin-data 根目录；密钥目录为 plugin-data/<pluginId>/secrets/。 */
  pluginDataRoot: string;
  channelManager: { has(channelId: string): boolean };
  /** 基础 LLM 服务；purpose 前缀由框架按 pluginId 统一包装。 */
  llm: PluginLlmService;
  /** 为每个插件绑定无头目标运行入口；未提供时保持旧宿主兼容。 */
  createAgentRunner?: (input: {
    pluginId: string;
    signal: AbortSignal;
  }) => NonNullable<PluginLlmService["runGoal"]>;
  storage: SafeStorageLike;
  chatsReader: PluginHostChatsReader;
  assistantDeliverySink: PluginAssistantDeliverySink;
  /** 只返回视觉摘要的屏幕观察服务；截图不暴露给插件。 */
  screenObservation: PluginScreenObservationService;
  /** 不含输入内容或窗口信息的只读在场状态。 */
  userPresence: PluginUserPresenceService;
  /** 不暴露城市或配置的只读天气快照。 */
  weatherContext: PluginWeatherContextService;
  /** 可选的通话、Minecraft 与音乐只读上下文；没有数据源时不向插件暴露。 */
  companionContext?: PluginCompanionContextService;
  proactiveDocuments?: PluginProactiveDocumentContextService;
  /** 调度存储；必须在 store.load() 完成后再创建工厂，否则插件写入会覆盖磁盘数据。 */
  schedulerStore: PluginSchedulerStore;
  /** 独占语音输入租约服务；全局单例，由 plugin-runtime 创建一次后传入。 */
  speechInput: SpeechInputService;
}

/**
 * 宿主服务装配：所有插件可用的宿主能力都在这里拼装成工厂。
 * 后续新服务（scheduler、speechInput 等）只扩展本工厂，
 * 不再向 PluginContext 增加特例。
 */
export function createHostServiceFactory(options: PluginHostServicesOptions): PluginHostServiceFactory {
  return {
    createForPlugin({ pluginId, signal, trackResource }) {
      const runGoal = options.createAgentRunner?.({ pluginId, signal });
      return {
        channels: { has: (channelId) => options.channelManager.has(channelId) },
        llm: {
          ...options.llm,
          ...(runGoal ? { runGoal } : {}),
        },
        secrets: createPluginSecretsService({
          pluginId,
          secretsRoot: path.join(options.pluginDataRoot, pluginId, "secrets"),
          storage: options.storage,
          signal,
        }),
        workspace: createPluginWorkspaceService({
          reader: options.chatsReader,
          signal,
        }),
        conversations: createPluginConversationsService({
          reader: options.chatsReader,
          signal,
        }),
        assistantDelivery: createPluginAssistantDeliveryService({
          pluginId,
          signal,
          sink: options.assistantDeliverySink,
        }),
        screenObservation: {
          observe: (input = {}) => options.screenObservation.observe({
            ...input,
            signal: input.signal ? AbortSignal.any([signal, input.signal]) : signal,
          }),
          observeSnapshot: (input = {}) => options.screenObservation.observeSnapshot({
            ...input,
            signal: input.signal ? AbortSignal.any([signal, input.signal]) : signal,
          }),
          markPeriodicUnavailable: () => options.screenObservation.markPeriodicUnavailable?.(),
        },
        userPresence: {
          snapshot: async () => {
            if (signal.aborted) throw pluginHostError("E_PLUGIN_STOPPING", "插件已停止，用户在场服务不可用");
            return options.userPresence.snapshot();
          },
        },
        weatherContext: {
          snapshot: async () => {
            if (signal.aborted) throw pluginHostError("E_PLUGIN_STOPPING", "插件已停止，天气上下文服务不可用");
            const snapshot = await options.weatherContext.snapshot();
            if (signal.aborted) throw pluginHostError("E_PLUGIN_STOPPING", "插件已停止，天气上下文服务不可用");
            return snapshot;
          },
        },
        ...(options.companionContext ? {
          companionContext: {
            snapshot: async (input) => {
              if (signal.aborted) throw pluginHostError("E_PLUGIN_STOPPING", "插件已停止，陪伴上下文服务不可用");
              const snapshot = await options.companionContext!.snapshot({
                ...input,
                signal: input.signal ? AbortSignal.any([signal, input.signal]) : signal,
              });
              if (signal.aborted) throw pluginHostError("E_PLUGIN_STOPPING", "插件已停止，陪伴上下文服务不可用");
              return snapshot;
            },
          },
        } : {}),
        ...(pluginId === "companion-chat" && options.proactiveDocuments ? {
          proactiveDocuments: {
            search: async (query, requestSignal) => {
              if (signal.aborted || requestSignal?.aborted) throw pluginHostError("E_PLUGIN_STOPPING", "文档检索已取消");
              const result = await options.proactiveDocuments!.search(query, requestSignal);
              if (signal.aborted || requestSignal?.aborted) throw pluginHostError("E_PLUGIN_STOPPING", "文档检索已取消");
              return result;
            },
          },
        } : {}),
        memoryRetrieval: createPluginMemoryRetrievalService(signal),
        scheduler: createPluginSchedulerService({
          pluginId,
          store: options.schedulerStore,
          signal,
        }),
        speechInput: {
          // 每插件包装：把插件上下文（停止信号 + 资源跟踪器）绑定到全局租约服务
          acquire: (acquireOptions) =>
            options.speechInput.acquireForPlugin(
              { pluginId, signal, tracker: trackResource },
              acquireOptions,
            ),
        },
      };
    },
  };
}
