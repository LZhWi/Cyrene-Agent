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
      });
      assertActive();
      return result;
    },
  };
}
