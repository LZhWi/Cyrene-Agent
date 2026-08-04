/**
 * CodeUserPreferencesProvider - 稳定的代码偏好 + systemPrompt 装配
 *
 * 职责：
 * - 从明确来源（用户档案/设置）读取
 * - 只提取代码相关偏好
 * - 过滤、稳定排序、格式化
 * - 版本化缓存
 * - 创建新 Cline Task 时注入
 *
 * `buildClineSystemPromptWithPreferences()` 装配顺序：
 *   1. code_identity.md — Code 模式下的角色定位（手动维护）
 *   2. code_soul.md     — 精简版 Cyrene 人格（手动维护，避免与 chat 模式共享 soul.md）
 *   3. codeUserPreferences — 版本化代码偏好事实（profile 注入）
 *   4. L0/L1 记忆      — 用户画像 + 近期状态（结构化记忆，非 WorldBook）
 *
 * 明确不注入：
 *   - WorldBook / DMAE / CAE / 社交情绪（会干扰代码任务专注度）
 *   - 动态 RAG / 每轮检索
 *
 * 当前无可用档案时各 part 为空字符串，正常创建 Session。
 */

import { memoryStore } from "../../memory";

/** 代码偏好事实条目 */
export interface CodePreferenceFact {
  key: string;
  value: string;
}

/** 偏好来源接口（由外部注入，如用户档案读取器） */
export interface CodeUserPreferencesSource {
  /** 返回当前档案版本（变化时触发刷新） */
  getProfileVersion(): number;
  /** 读取代码相关偏好事实 */
  readCodeRelevantPreferences(): CodePreferenceFact[];
}

/** 空来源（当前无可用档案时的默认行为） */
class EmptyPreferencesSource implements CodeUserPreferencesSource {
  getProfileVersion(): number { return 0; }
  readCodeRelevantPreferences(): CodePreferenceFact[] { return []; }
}

interface CodeUserPreferences {
  version: number;
  content: string;
}

class CodeUserPreferencesProvider {
  private source: CodeUserPreferencesSource = new EmptyPreferencesSource();
  private cached: CodeUserPreferences | null = null;
  private cachedProfileVersion: number = -1;

  /** 注入偏好来源 */
  setSource(source: CodeUserPreferencesSource): void {
    this.source = source;
    this.cached = null;
    this.cachedProfileVersion = -1;
  }

  /** 获取 preferences（带缓存，版本未变时复用） */
  get(): CodeUserPreferences {
    const profileVersion = this.source.getProfileVersion();
    if (this.cached && profileVersion === this.cachedProfileVersion) {
      return this.cached;
    }
    this.cachedProfileVersion = profileVersion;
    this.cached = this.generate();
    return this.cached;
  }

  /** 强制刷新 */
  refresh(): CodeUserPreferences {
    this.cached = null;
    return this.get();
  }

  /** 生成稳定字符串 */
  private generate(): CodeUserPreferences {
    const facts = this.source.readCodeRelevantPreferences();
    if (facts.length === 0) {
      return { version: 0, content: "" };
    }
    // 稳定排序：按 key 排序
    const sorted = [...facts].sort((a, b) => a.key.localeCompare(b.key));
    const lines = [
      "【代码工作偏好】",
      "",
      ...sorted.map(f => `- ${f.key}: ${f.value}`),
    ];
    return {
      version: this.source.getProfileVersion(),
      content: lines.join("\n"),
    };
  }

  /** 重置（测试用） */
  reset(): void {
    this.source = new EmptyPreferencesSource();
    this.cached = null;
    this.cachedProfileVersion = -1;
  }
}

export const codeUserPreferences = new CodeUserPreferencesProvider();

/** 构建 Cline systemPrompt：identity → soul → userPrefs → L0/L1 记忆 */
export async function buildClineSystemPromptWithPreferences(): Promise<string> {
  const identity = loadPromptFromFile("code_identity.md");
  const soul = loadPromptFromFile("code_soul.md");
  const userPrefs = codeUserPreferences.get();
  const memory = await buildL0L1MemoryBlock();
  const parts: string[] = [];
  if (identity.content) parts.push(identity.content);
  if (soul.content) parts.push(soul.content);
  if (userPrefs.content) parts.push(userPrefs.content);
  if (memory) parts.push(memory);
  return parts.join("\n\n");
}

/**
 * 把 L0（用户画像）和 L1（近期状态）拼成单个字符串块。
 * 复用 chat 模式 `orchestrator/index.ts` 的成熟格式 —— 便于跨模式维护。
 * L2 不注入（与 chat 模式行为一致，避免给 code 模式灌入过多背景）。
 * 任一为空时跳过对应小节，整体为空时返回 ""。
 */
async function buildL0L1MemoryBlock(): Promise<string> {
  let block = "";
  try {
    const l0 = await memoryStore.getL0();
    const l0Lines = [
      l0.preferredName && `称呼：${l0.preferredName}`,
      l0.occupation && `职业：${l0.occupation}`,
      l0.longTermInterests && `长期兴趣：${l0.longTermInterests}`,
      l0.language && `常用语言：${l0.language}`,
      l0.permanentNote && `备注：${l0.permanentNote}`,
    ].filter(Boolean);
    if (l0Lines.length > 0) {
      block += `[用户画像]\n${l0Lines.join("\n")}\n\n`;
    }
  } catch (err) {
    console.warn("[CodeUserPreferences] failed to load L0:", err);
  }
  try {
    const l1 = await memoryStore.getL1();
    const l1Lines = [
      l1.recentGoals && `最近目标：${l1.recentGoals}`,
      l1.recentPreferences && `近期偏好：${l1.recentPreferences}`,
      l1.currentProject && `当前项目：${l1.currentProject}`,
    ].filter(Boolean);
    if (l1Lines.length > 0) {
      block += `[近期状态]\n${l1Lines.join("\n")}\n\n`;
    }
  } catch (err) {
    console.warn("[CodeUserPreferences] failed to load L1:", err);
  }
  return block.trim();
}

// ── Prompt 文件读取 ──────────────────────────────────────

export interface PromptLoadResult {
  content: string;
  source: "empty_file" | "loaded" | "missing" | "load_error";
}

function loadPromptFromFile(filename: string): PromptLoadResult {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const candidates = [
    path.join(process.cwd(), "prompts", filename),
  ];
  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, "utf8").trim();
      if (!content) return { content: "", source: "empty_file" };
      return { content, source: "loaded" };
    } catch { /* continue */ }
  }
  return { content: "", source: "missing" };
}

export type { CodeUserPreferences };