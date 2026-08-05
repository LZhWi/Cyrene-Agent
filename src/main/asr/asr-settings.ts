export const LOCAL_ASR_PROFILES = ["qwen17-stream", "paraformer-qwen17", "qwen06-stream"] as const;
export type LocalAsrProfile = typeof LOCAL_ASR_PROFILES[number];

export function normalizeLocalAsrProfile(value: unknown): LocalAsrProfile {
  return LOCAL_ASR_PROFILES.includes(value as LocalAsrProfile)
    ? value as LocalAsrProfile
    : "paraformer-qwen17";
}

export function normalizeAsrHotwords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 200);
}
