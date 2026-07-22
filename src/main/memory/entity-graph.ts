// 简易实体关系图谱
//
// 从对话中自动提取实体（人物、地点、偏好、概念）和关系，
// 弥补纯向量检索无法回答"用户提到过的朋友是谁"这类关系型问题的不足。
//
// 存储为 JSON 文件，与 memory.json 并列。

import * as fs from "fs";
import * as path from "path";
import { getUserDataDir } from "../runtime/runtime-paths";
import { registerJiebaCustomWord, registerJiebaCustomWords } from "../rag/retriever";

// ── 类型 ──

export interface EntityNode {
  id: string;
  name: string;
  type: "person" | "place" | "concept" | "preference" | "organization";
  aliases: string[];         // 其他叫法
  mentionCount: number;
  firstMentionedAt: number;
  lastMentionedAt: number;
}

export interface EntityRelation {
  id: string;
  sourceId: string;
  targetId: string;
  relation: string;          // "likes" | "works_at" | "lives_in" | "friend_of" | "owns" | ...
  confidence: number;        // 0.0 ~ 1.0
  strength: number;          // 提及次数累积
}

interface EntityGraphData {
  entities: EntityNode[];
  relations: EntityRelation[];
}

// ── 简单解析器（不依赖 LLM，用正则启发式提取） ──

// 常见实体触发模式
const ENTITY_PATTERNS: Array<{ type: EntityNode["type"]; patterns: RegExp[] }> = [
  {
    type: "person",
    patterns: [
      /我的朋友(.{1,6})/g,
      /我认识(.{1,6})/g,
      /同事(.{1,6})/g,
      /叫(.{1,4})(?:的人|的朋友|的同事|的老板)/g,
      /有.{0,4}朋友.{0,4}(.{1,6})/g,
      /(.{1,4})是我的朋友/g,
    ],
  },
  {
    type: "place",
    patterns: [
      /住在(.{1,10})/g,
      /在(.{1,10})(?:工作|学习|生活|住|上班|上学)/g,
      /去了(.{1,10})/g,
      /在(.{1,10})出差/g,
    ],
  },
  {
    type: "organization",
    patterns: [
      /在(.{1,10})(?:公司|单位|工作室|团队|学校|大学|学院)/g,
      /(.{1,10})公司/g,
    ],
  },
  {
    type: "preference",
    patterns: [
      /喜欢(.{1,10})(?:的东西|的活动|的食物|的音乐|的运动|的游戏|的动画|的漫画)/g,
      /最爱(.{1,10})/g,
      /讨厌(.{1,10})(?:的东西|的事情)/g,
    ],
  },
];

/** 从文本中启发式提取实体名，返回 [type, name] 列表 */
export function extractEntitiesFromText(text: string): Array<{ type: EntityNode["type"]; name: string }> {
  const results: Array<{ type: EntityNode["type"]; name: string }> = [];
  const seen = new Set<string>();

  for (const { type, patterns } of ENTITY_PATTERNS) {
    for (const regex of patterns) {
      const matches = text.matchAll(regex);
      for (const m of matches) {
        const name = m[1]?.trim();
        if (name && name.length >= 2 && name.length <= 10 && !seen.has(`${type}:${name}`)) {
          seen.add(`${type}:${name}`);
          results.push({ type, name });
        }
      }
    }
  }

  return results;
}

// ── 实体图谱管理器 ──

const dataDir = () => path.join(getUserDataDir());
const getPath = () => path.join(dataDir(), "entity-graph.json");

class EntityGraph {
  private cache: EntityGraphData | null = null;

  load(): EntityGraphData {
    if (this.cache) return this.cache;
    try {
      const filePath = getPath();
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf8");
        this.cache = JSON.parse(raw) as EntityGraphData;
      } else {
        this.cache = { entities: [], relations: [] };
      }
    } catch {
      this.cache = { entities: [], relations: [] };
    }
    return this.cache;
  }

  save(): void {
    if (!this.cache) return;
    const filePath = getPath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(this.cache, null, 2), "utf8");
  }

  /** 从一条对话文本中提取实体并入库 */
  ingest(text: string): void {
    const data = this.load();
    const extracted = extractEntitiesFromText(text);
    const now = Date.now();
    let hasNewEntity = false;

    for (const { type, name } of extracted) {
      const existing = data.entities.find(
        (e) => e.name === name || e.aliases.includes(name),
      );
      if (existing) {
        existing.mentionCount++;
        existing.lastMentionedAt = now;
      } else {
        data.entities.push({
          id: `ent_${now}_${Math.random().toString(36).slice(2, 8)}`,
          name,
          type,
          aliases: [],
          mentionCount: 1,
          firstMentionedAt: now,
          lastMentionedAt: now,
        });
        hasNewEntity = true;
        // 新实体立即喂给 jieba，避免后续对话中该词被错误切分
        this.feedSingleName(name);
      }
    }

    if (extracted.length > 0) this.save();
  }

/**
 * 把一个名称注册到 jieba 自定义词表。
 *
 * @node-rs/jieba 没有运行时 insertWord() —— 走「后处理重组」方案：
 * retriever.ts 的 tokenize() 在 jieba.cut() 之后会把被切散的自定义词
 * 重新合并。这个函数就是把 entity 名加进那张表的入口。
 */
  private feedSingleName(name: string): void {
    registerJiebaCustomWord(name);
  }

  /** 搜索与 query 相关的实体和关系，返回可读文本 */
  search(query: string): string {
    const data = this.load();
    if (data.entities.length === 0) return "";

    // 简单关键词匹配：找名称包含 query 中任意词的实体
    const queryTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matchedEntities = data.entities.filter((e) =>
      queryTokens.some((t) => e.name.includes(t) || e.aliases.some((a) => a.includes(t))),
    );

    if (matchedEntities.length === 0) return "";

    const lines: string[] = [];
    for (const entity of matchedEntities) {
      const mentions = entity.mentionCount > 1 ? `（提及${entity.mentionCount}次）` : "";
      lines.push(`· ${entity.name}（${typeLabel(entity.type)}）${mentions}`);

      // 找该实体相关的所有关系
      const outgoing = data.relations.filter((r) => r.sourceId === entity.id);
      for (const rel of outgoing) {
        const target = data.entities.find((e) => e.id === rel.targetId);
        if (target) {
          lines.push(`  → ${rel.relation} ${target.name}`);
        }
      }

      const incoming = data.relations.filter((r) => r.targetId === entity.id);
      for (const rel of incoming) {
        const source = data.entities.find((e) => e.id === rel.sourceId);
        if (source) {
          lines.push(`  ← ${source.name} ${rel.relation}`);
        }
      }
    }

    return lines.length > 0 ? lines.join("\n") : "";
  }

  /** 清空图谱 */
  reset(): void {
    this.cache = { entities: [], relations: [] };
    this.save();
  }
}

/** 获取所有实体名称（含别名） */
export function getAllEntityNames(): string[] {
  const graph = entityGraph.load();
  const names = new Set<string>();
  for (const e of graph.entities) {
    names.add(e.name);
    for (const a of e.aliases) names.add(a);
  }
  return [...names].filter((n) => n.length >= 2);
}

/**
 * 将实体图谱中的所有实体名注册到 jieba 自定义词表。
 * 调用时机：应用启动后、图谱有更新时。
 * 这样 "昔涟"、"小鹿" 等 AI 伴侣核心名词不会被错误切分。
 *
 * @node-rs/jieba 没有运行时 insertWord() —— 走「后处理重组」方案：
 * 词表存到 retriever.ts 的 customWords Set，tokenize() 切完后合并回去。
 */
export async function feedEntityNamesToJieba(): Promise<void> {
  const names = getAllEntityNames();
  if (names.length === 0) return;
  registerJiebaCustomWords(names);
  console.log(`[EntityGraph] 注册 ${names.length} 个实体名到 jieba 自定义词表`);
}

function typeLabel(type: EntityNode["type"]): string {
  switch (type) {
    case "person": return "人物";
    case "place": return "地点";
    case "organization": return "组织";
    case "preference": return "偏好";
    case "concept": return "概念";
  }
}

export const entityGraph = new EntityGraph();