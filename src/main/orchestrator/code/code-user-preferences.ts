/**
 * CodeUserPreferencesProvider - 稳定的代码偏好
 *
 * 生成时机：
 * - 创建 Code 会话
 * - 创建新 Cline Session
 * - 用户修改相关设置或记忆
 * - 用户主动执行刷新命令
 *
 * 不每轮调用动态 RAG。
 * 不注入 WorldBook、DMAE、CAE、社交情绪内容。
 *
 * 内容只包含代码工作相关偏好。
 */

import * as fs from "fs";
import * as path from "path";

interface CodeUserPreferences {
  version: number;
  content: string;
}

/** 默认的代码偏好（与用户期望对齐） */
const DEFAULT_PREFERENCES_LINES = [
  "用户使用 Windows 操作系统。",
  "项目主要使用 TypeScript、Electron、Node。",
  "用户偏好中文沟通。",
  "优先复用成熟库和官方能力。",
  "避免重复造轮子，优先复用现有实现。",
  "重要修改前先检查真实调用链，避免遗漏影响面。",
  "避免散落硬编码和多点同步，统一入口读取。",
  "复杂修改拆分为可回滚提交。",
  "Code 会话运行前必须验证工作区绑定。",
  "任务理解、项目探索和规划由 Cline 负责。",
];

let cachedPreferences: CodeUserPreferences | null = null;

class CodeUserPreferencesProvider {
  /** 获取当前 preferences（带缓存） */
  get(forceRefresh = false): CodeUserPreferences {
    if (cachedPreferences && !forceRefresh) {
      return cachedPreferences;
    }
    cachedPreferences = this.generate();
    return cachedPreferences;
  }

  /** 生成稳定的 preferences 字符串 */
  private generate(): CodeUserPreferences {
    const lines: string[] = [
      "【代码工作偏好（来自 CodeUserPreferencesProvider）】",
      "",
      ...DEFAULT_PREFERENCES_LINES,
    ];
    return {
      version: 1,
      content: lines.join("\n"),
    };
  }

  /** 强制刷新（设置变更或用户主动刷新时调用） */
  refresh(): CodeUserPreferences {
    cachedPreferences = null;
    return this.get(true);
  }

  /** 重置缓存（测试用） */
  reset(): void {
    cachedPreferences = null;
  }
}

export const codeUserPreferences = new CodeUserPreferencesProvider();

/** 构建 Cline systemPrompt：CodeIdentityAddon + CodeUserPreferences */
export function buildClineSystemPromptWithPreferences(): string {
  const identityResult = loadPromptFromFile("code_identity.md");
  const userPrefs = codeUserPreferences.get();

  const parts: string[] = [];
  if (identityResult.content) {
    parts.push(identityResult.content);
  }
  if (userPrefs.content) {
    parts.push(userPrefs.content);
  }
  return parts.join("\n\n");
}

interface PromptLoadResult {
  content: string;
  source: "empty_file" | "loaded" | "missing" | "load_error";
}

function loadPromptFromFile(filename: string): PromptLoadResult {
  const candidates = [
    path.join(process.cwd(), "prompts", filename),
    path.join(process.cwd(), "src", "main", "orchestrator", "code", "prompts", filename),
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

export type { CodeUserPreferences, PromptLoadResult };