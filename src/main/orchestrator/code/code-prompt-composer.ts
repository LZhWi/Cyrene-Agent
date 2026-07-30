/**
 * CodePromptComposer - 读取 Prompt 文件 + 用户偏好拼接
 *
 * Prompt 加载语义：
 * - 文件存在且为空 -> 正常运行，不追加 Prompt
 * - 文件不存在 -> 日志警告，不得回退硬编码
 * - 文件有内容 -> 追加到 Cline 原生 Coding System
 */

import * as fs from "fs";
import * as path from "path";

const IDENTITY_PROMPTFile = "code_identity.md";
const SOUL_PROMPTFile = "code_soul.md";

export interface PromptLoadResult {
  content: string;
  source: "empty_file" | "loaded" | "missing" | "load_error";
}

/**
 * 读取 Prompt 文件
 */
export function loadPromptFile(filePath: string): PromptLoadResult {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`[CodePrompt] Prompt file not found: ${filePath}`);
      return { content: "", source: "missing" };
    }
    const content = fs.readFileSync(filePath, "utf8").trim();
    if (!content) {
      return { content: "", source: "empty_file" };
    }
    return { content, source: "loaded" };
  } catch (err) {
    console.error(`[CodePrompt] Failed to load prompt: ${filePath}`, err);
    return { content: "", source: "load_error" };
  }
}

/**
 * 获取 prompts 目录路径
 */
export function getPromptsDir(): string {
  return path.join(process.cwd(), "prompts");
}

/**
 * 加载 CodeIdentityAddon
 */
export function loadCodeIdentityPrompt(): PromptLoadResult {
  return loadPromptFile(path.join(getPromptsDir(), IDENTITY_PROMPTFile));
}

/**
 * 加载 CodeSoul Prompt（保留供后续可选使用）
 */
export function loadCodeSoulPrompt(): PromptLoadResult {
  return loadPromptFile(path.join(getPromptsDir(), SOUL_PROMPTFile));
}

/**
 * 构建 Cline systemPrompt：CodeIdentityAddon（如果有内容）
 *
 * 返回空字符串表示不追加。
 */
export function buildClineSystemPrompt(): string {
  const identity = loadCodeIdentityPrompt();
  if (identity.source === "loaded") {
    return identity.content;
  }
  return "";
}