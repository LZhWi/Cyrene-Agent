import type {
  PluginAssistantDeliveryResult,
  PluginAssistantDeliveryService,
} from "../../plugins/api";
import { pluginHostError } from "./errors";

const MAX_MESSAGE_CHARS = 32_000;

export interface PluginAssistantDeliverySink {
  canStart?(): boolean;
  append(input: {
    pluginId: string;
    text: string;
    allowIgnoreFeedback: boolean;
    contextRunId?: string;
  }): Promise<PluginAssistantDeliveryResult> | PluginAssistantDeliveryResult;
}

export function createPluginAssistantDeliveryService(options: {
  pluginId: string;
  signal?: AbortSignal;
  sink: PluginAssistantDeliverySink;
}): PluginAssistantDeliveryService {
  const assertActive = () => {
    if (options.signal?.aborted) throw pluginHostError("E_PLUGIN_STOPPING", "插件已停止，助手消息不可投递");
  };

  return {
    async canPostProactiveMessage() {
      assertActive();
      return options.sink.canStart?.() ?? true;
    },
    async postProactiveMessage(text, deliveryOptions) {
      assertActive();
      const contextRunId = (deliveryOptions as { contextRunId?: unknown } | undefined)?.contextRunId;
      if (contextRunId !== undefined && (options.pluginId !== "companion-chat"
        || typeof contextRunId !== "string" || !contextRunId || contextRunId.length > 200)) {
        throw pluginHostError("E_INVALID_ARGUMENT", "主动消息上下文凭据无效");
      }
      if (typeof text !== "string" || text.trim().length === 0 || text.length > MAX_MESSAGE_CHARS) {
        throw pluginHostError("E_INVALID_ARGUMENT", `助手消息必须为 1-${MAX_MESSAGE_CHARS} 个字符`);
      }
      if (deliveryOptions !== undefined && (typeof deliveryOptions !== "object"
        || (deliveryOptions.allowIgnoreFeedback !== undefined
          && typeof deliveryOptions.allowIgnoreFeedback !== "boolean"))) {
        throw pluginHostError("E_INVALID_ARGUMENT", "助手消息投递选项无效");
      }
      const result = await options.sink.append({
        pluginId: options.pluginId,
        text,
        allowIgnoreFeedback: deliveryOptions?.allowIgnoreFeedback === true,
        ...(typeof contextRunId === "string" ? { contextRunId } : {}),
      });
      assertActive();
      return result;
    },
  };
}
