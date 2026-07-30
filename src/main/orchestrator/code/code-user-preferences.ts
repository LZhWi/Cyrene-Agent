/**
 * CodeUserPreferencesProvider - 稳定的代码偏好
 *
 * 职责：
 * - 从明确来源（用户档案/设置）读取
 * - 只提取代码相关偏好
 * - 过滤、稳定排序、格式化
 * - 版本化缓存
 * - 创建新 Cline Task 时注入
 *
 * 不每轮动态 RAG。不注入 WorldBook/DMAE/CAE/社交情绪。
 * 当前无可用档案时 content="" 正常创建 Session。
 */

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

/** 构建 Cline systemPrompt：CodeIdentityAddon + CodeUserPreferences */
export function buildClineSystemPromptWithPreferences(): string {
  const identity = loadPromptFromFile("code_identity.md");
  const userPrefs = codeUserPreferences.get();
  const parts: string[] = [];
  if (identity.content) parts.push(identity.content);
  if (userPrefs.content) parts.push(userPrefs.content);
  return parts.join("\n\n");
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