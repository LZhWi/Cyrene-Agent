export type DefaultChatMode = "collab" | "talk";
export type SegmentedOutputMode = "all" | "chat" | "off";

export function normalizeDefaultChatMode(value: unknown): DefaultChatMode {
  return value === "talk" ? "talk" : "collab";
}

export function normalizeSegmentedOutputMode(value: unknown): SegmentedOutputMode {
  return value === "all" || value === "chat" ? value : "off";
}
