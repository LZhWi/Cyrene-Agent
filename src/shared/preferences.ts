export type DefaultChatMode = "collab" | "talk";
export type SegmentedOutputMode = "all" | "chat" | "off";
export type MobileMessageSegmentationMode = "on" | "off";
export type ProactiveChatMode = "on" | "off";
export type ProactiveDeliveryTarget = "local" | "wechat" | "feishu";

export function normalizeDefaultChatMode(value: unknown): DefaultChatMode {
  return value === "talk" ? "talk" : "collab";
}

export function normalizeSegmentedOutputMode(value: unknown): SegmentedOutputMode {
  return value === "all" || value === "chat" ? value : "off";
}

export function normalizeMobileMessageSegmentationMode(value: unknown): MobileMessageSegmentationMode {
  return value === "on" ? "on" : "off";
}

export function normalizeProactiveChatMode(value: unknown): ProactiveChatMode {
  return value === "on" ? "on" : "off";
}

export function normalizeProactiveDeliveryTarget(value: unknown): ProactiveDeliveryTarget {
  return value === "wechat" || value === "feishu" ? value : "local";
}
