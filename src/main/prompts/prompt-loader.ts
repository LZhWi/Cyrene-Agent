import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 加载 prompts 目录下的 Markdown/文本文件。
 * 文件不存在或读取失败时返回空字符串，避免调用方因 prompt 缺失崩溃。
 */
export function loadPromptFile(filename: string): string {
  try {
    // electron 主进程外（如 vitest）app 不可用，回退到 cwd（仓库根）定位 prompts/
    let promptsDir: string;
    try {
      promptsDir = path.join(app.getAppPath(), "prompts");
    } catch {
      promptsDir = path.join(process.cwd(), "prompts");
    }
    const filePath = path.join(promptsDir, filename);
    if (!fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}
