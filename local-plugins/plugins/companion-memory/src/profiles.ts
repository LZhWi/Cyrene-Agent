export const L0_FIELDS = {
  preferredName: "称呼", occupation: "职业", longTermInterests: "长期兴趣",
  language: "常用语言", permanentNote: "备注",
} as const;
export const L1_FIELDS = { recentGoals: "最近目标", recentPreferences: "近期偏好", currentProject: "当前项目" } as const;
export interface ProfileFact {
  content: string;
  sourceAt: number;
  quote: string;
  turnId: string;
  sessionId: string;
  origin: "extracted" | "user-edit" | "legacy-import" | "legacy-user-attested";
}
export interface Profiles {
  l0: Partial<Record<keyof typeof L0_FIELDS, ProfileFact>>;
  l1: Partial<Record<keyof typeof L1_FIELDS, ProfileFact>>;
  l0Locked: boolean;
}
export const FRESHNESS_MS = 30 * 24 * 60 * 60 * 1000;
export function emptyProfiles(): Profiles { return { l0: {}, l1: {}, l0Locked: false }; }
export function profileField(layer: unknown, field: unknown): string {
  const fields = layer === "L0" ? L0_FIELDS : layer === "L1" ? L1_FIELDS : null;
  if (!fields || typeof field !== "string" || !Object.hasOwn(fields, field)) throw new Error("画像字段不在白名单内");
  return field;
}
export function profileContext(profiles: Profiles, now: number): string[] {
  const blocks: string[] = [];
  for (const [layer, labels, facts] of [["用户画像", L0_FIELDS, profiles.l0], ["近期状态", L1_FIELDS, profiles.l1]] as const) {
    const lines = Object.entries(facts).flatMap(([field, fact]) => {
      // 按事实来源时间而非回填时间判断新鲜度，历史提取不会把旧近况变成“现在”。
      if (!fact?.content || (layer === "近期状态" && (now - fact.sourceAt >= FRESHNESS_MS || fact.sourceAt > now))) return [];
      const label = (labels as Record<string, string>)[field];
      return [`${label}：${fact.content}`];
    });
    if (lines.length) blocks.push(`[${layer}]\n${lines.join("\n")}`);
  }
  return blocks;
}
