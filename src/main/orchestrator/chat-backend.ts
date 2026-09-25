export type ChatBackend = "native" | "companion";

/**
 * 陪伴后端只接管桌面 Chat。其他模式、渠道、插件代理和缺省值始终走上游原生路径，
 * 避免一个日常聊天开关意外扩大到 Work、Code、Learn 或外部渠道。
 */
export function resolveChatBackend(input: {
  mode?: string;
  source?: "desktop" | "channel";
  channel?: string;
  chatBackend?: unknown;
}): ChatBackend {
  return input.source === "desktop"
    && input.mode === "chat"
    && input.channel === undefined
    && input.chatBackend === "companion"
    ? "companion"
    : "native";
}

export function shouldUseNativeChatSystems(input: Parameters<typeof resolveChatBackend>[0]): boolean {
  return resolveChatBackend(input) === "native";
}

/**
 * 选择陪伴后端后，设置页的主动聊天开关完全归 Companion 所有；投递目标不再
 * 让上游主动系统重新启动，避免两个主动控制器并行发送。
 */
export function shouldUseNativeProactiveChat(input: {
  chatBackend?: unknown;
  proactiveChatMode?: unknown;
  proactiveDeliveryTarget?: unknown;
}): boolean {
  if (input.proactiveChatMode !== "on") return false;
  return input.chatBackend !== "companion";
}
