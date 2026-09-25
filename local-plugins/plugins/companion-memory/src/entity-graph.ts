import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";

const KEY = "entity-graph";
const TYPES = ["person", "place", "concept", "preference", "organization"] as const;
type EntityType = typeof TYPES[number];
export interface ExtractedEntity { name: string; type: EntityType; aliases?: string[] }
interface EntityNode extends ExtractedEntity { id: string; aliases: string[]; mentionCount: number; firstMentionedAt: number; lastMentionedAt: number }
interface State { version: 1; entities: EntityNode[] }

const ENTITY_PATTERNS: Array<{ type: EntityType; patterns: RegExp[] }> = [
  { type: "person", patterns: [/我的朋友(.{1,6})/g, /我认识(.{1,6})/g, /同事(.{1,6})/g, /叫(.{1,4})(?:的人|的朋友|的同事|的老板)/g, /有.{0,4}朋友.{0,4}(.{1,6})/g, /(.{1,4})是我的朋友/g] },
  { type: "place", patterns: [/住在(.{1,10})/g, /在(.{1,10})(?:工作|学习|生活|住|上班|上学)/g, /去了(.{1,10})/g, /在(.{1,10})出差/g] },
  { type: "organization", patterns: [/在(.{1,10})(?:公司|单位|工作室|团队|学校|大学|学院)/g, /(.{1,10})公司/g] },
  { type: "preference", patterns: [/喜欢(.{1,10})(?:的东西|的活动|的食物|的音乐|的运动|的游戏|的动画|的漫画)/g, /最爱(.{1,10})/g, /讨厌(.{1,10})(?:的东西|的事情)/g] },
];

export function extractEntitiesFromText(text: string): ExtractedEntity[] {
  const result: ExtractedEntity[] = [], seen = new Set<string>();
  for (const { type, patterns } of ENTITY_PATTERNS) for (const pattern of patterns) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const name = match[1]?.trim(), key = `${type}:${name}`;
      if (!name || name.length < 2 || name.length > 10 || seen.has(key)) continue;
      seen.add(key); result.push({ name, type, aliases: [] });
    }
  }
  return result;
}

function validate(value: unknown): State {
  if (!value || typeof value !== "object" || (value as State).version !== 1 || !Array.isArray((value as State).entities) || (value as State).entities.length > 20_000) throw new Error("实体图谱损坏");
  for (const entity of (value as State).entities) {
    if (!entity?.id || !entity.name || !TYPES.includes(entity.type) || !Array.isArray(entity.aliases)
      || entity.aliases.some((alias) => typeof alias !== "string" || !alias)
      || !Number.isSafeInteger(entity.mentionCount) || entity.mentionCount < 1
      || !Number.isFinite(entity.firstMentionedAt) || !Number.isFinite(entity.lastMentionedAt)) throw new Error("实体图谱损坏");
  }
  return structuredClone(value as State);
}

export function normalizeExtractedEntities(value: unknown): ExtractedEntity[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error("实体提取结果无效");
  const result: ExtractedEntity[] = [];
  for (const item of value) {
    if (!item || typeof item.name !== "string" || !TYPES.includes(item.type) || (item.aliases !== undefined && (!Array.isArray(item.aliases) || item.aliases.some((alias: unknown) => typeof alias !== "string")))) throw new Error("实体提取结果无效");
    const name = item.name.trim(), aliases = [...new Set<string>((item.aliases ?? []).map((alias: string) => alias.trim()).filter((alias: string): alias is string => Boolean(alias && alias !== name)))].slice(0, 20);
    if (name.length >= 2 && name.length <= 100) result.push({ name, type: item.type, aliases });
  }
  return result;
}

export function createEntityGraph(storage: PluginStorage, now: () => number = Date.now) {
  let state = storage.get<unknown>(KEY) === undefined ? { version: 1 as const, entities: [] } : validate(storage.get<unknown>(KEY));
  return {
    view() { return { count: state.entities.length }; },
    ingest(input: ExtractedEntity[] | string[]) {
      const items = typeof input[0] === "string"
        ? (input as string[]).flatMap(extractEntitiesFromText)
        : input as ExtractedEntity[];
      if (!items.length) return 0;
      const entities = structuredClone(state.entities), at = now();
      let changed = 0;
      for (const item of items) {
        const existing = entities.find((entity) => entity.name === item.name || entity.aliases.includes(item.name));
        if (existing) {
          existing.mentionCount += 1;
          existing.lastMentionedAt = at;
          existing.aliases = [...new Set([...existing.aliases, ...(item.aliases ?? [])].filter((alias) => alias !== existing.name))].slice(0, 20);
        } else {
          entities.push({ id: `entity-${at}-${entities.length}`, name: item.name, type: item.type, aliases: item.aliases ?? [], mentionCount: 1, firstMentionedAt: at, lastMentionedAt: at });
        }
        changed += 1;
      }
      state = { version: 1, entities };
      storage.set(KEY, state);
      return changed;
    },
    search(query: string) {
      const normalized = query.normalize("NFC").toLowerCase();
      const rows = state.entities.filter((entity) => [entity.name, ...entity.aliases].some((name) => normalized.includes(name.toLowerCase()))).slice(0, 20);
      if (!rows.length) return "";
      const labels: Record<EntityType, string> = { person: "人物", place: "地点", concept: "概念", preference: "偏好", organization: "组织" };
      return `【人物关系】\n${rows.map((entity) => `· ${entity.name}（${labels[entity.type]}）${entity.mentionCount > 1 ? `（提及${entity.mentionCount}次）` : ""}`).join("\n")}`;
    },
  };
}
