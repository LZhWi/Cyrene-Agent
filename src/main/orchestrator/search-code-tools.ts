// search_code 工具 — 结构化代码搜索，替代 Agent 依赖的 run_shell/rg
//
// 安全约束：
// - 工作区根目录限制（路径逃逸检测）
// - 忽略 .git、node_modules、构建产物
// - 结果数量和上下文长度限制
// - AbortSignal 和超时支持

import * as fs from "fs";
import * as path from "path";
import { toolRegistry, type ToolEffectKind, type VerificationPolicy } from "./tool-registry";
import type { ToolContext } from "./tool-context";

const LOG_PREFIX = "[SearchCode]";

// ── 常量 ──────────────────────────────────────────────────

const MAX_MATCHES = 100;           // 单次最多返回匹配数
const MAX_CONTEXT_LINES = 5;       // 上下文行数上限
const MAX_LINE_LENGTH = 500;       // 单行最大字符数（超长截断）
const MAX_FILE_SIZE = 1024 * 1024; // 跳过 >1MB 的文件
const SEARCH_TIMEOUT_MS = 30000;   // 搜索超时 30s

/** 忽略的目录名 */
const IGNORED_DIRS = new Set([
  ".git", ".svn", ".hg",
  "node_modules", "bower_components",
  "dist", "build", "out", "output",
  ".next", ".nuxt", ".cache",
  "__pycache__", ".pytest_cache",
  ".idea", ".vscode",
  "coverage", ".nyc_output",
]);

/** 忽略的文件扩展名（二进制/生成文件） */
const IGNORED_EXTS = new Set([
  ".exe", ".dll", ".so", ".dylib",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".mp3", ".mp4", ".wav", ".avi", ".mov",
  ".zip", ".tar", ".gz", ".rar", ".7z",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".woff", ".woff2", ".ttf", ".eot",
  ".pyc", ".pyo", ".class", ".o", ".obj",
]);

// ── 路径安全 ──────────────────────────────────────────────

/** 确保路径在工作区根目录内（防止路径逃逸） */
function isWithinWorkspace(filePath: string, workspaceRoot: string): boolean {
  const resolved = path.resolve(workspaceRoot, filePath);
  const normalizedRoot = path.normalize(workspaceRoot);
  return resolved.startsWith(normalizedRoot + path.sep) || resolved === normalizedRoot;
}

/** 检查文件是否应被忽略 */
function shouldIgnoreFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (IGNORED_EXTS.has(ext)) return true;
  return false;
}

/** 检查目录是否应被忽略 */
function shouldIgnoreDir(dirName: string): boolean {
  return IGNORED_DIRS.has(dirName);
}

// ── Glob 匹配 ─────────────────────────────────────────────

/** 简单 glob 匹配（支持 * 和 **） */
function matchesGlob(filePath: string, pattern: string): boolean {
  // 转换 glob 为正则
  const regexStr = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "⟨GLOBSTAR⟩")
    .replace(/\*/g, "[^/]*")
    .replace(/⟨GLOBSTAR⟩/g, ".*")
    .replace(/\?/g, "[^/]");
  const regex = new RegExp("^" + regexStr + "$");
  return regex.test(filePath);
}

// ── 搜索结果类型 ──────────────────────────────────────────

interface SearchMatch {
  path: string;         // 相对于工作区根目录的路径
  line: number;         // 行号（1-based）
  column?: number;      // 列号（1-based，可选）
  preview: string;      // 匹配行内容
  before: string[];     // 上文行
  after: string[];      // 下文行
}

interface SearchResult {
  matches: SearchMatch[];
  totalMatches: number;
  returnedMatches: number;
  truncated: boolean;
}

// ── 核心搜索逻辑 ──────────────────────────────────────────

function searchInFile(
  filePath: string,
  relativePath: string,
  query: string,
  mode: "literal" | "regex",
  caseSensitive: boolean,
  contextLines: number,
  maxMatches: number,
  remainingMatches: number,
  signal?: AbortSignal,
): SearchMatch[] {
  if (remainingMatches <= 0) return [];

  const stat = safeStat(filePath);
  if (!stat || !stat.isFile() || stat.size > MAX_FILE_SIZE) return [];

  const matches: SearchMatch[] = [];
  let lines: string[];
  try {
    lines = fs.readFileSync(filePath, "utf8").split("\n");
  } catch {
    return [];
  }

  // 构建搜索正则
  let searchRegex: RegExp;
  try {
    if (mode === "regex") {
      searchRegex = new RegExp(query, caseSensitive ? "g" : "gi");
    } else {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      searchRegex = new RegExp(escaped, caseSensitive ? "g" : "gi");
    }
  } catch {
    return []; // 无效正则
  }

  for (let i = 0; i < lines.length; i++) {
    if (signal?.aborted) break;
    if (matches.length >= remainingMatches) break;

    const line = lines[i];
    if (line.length > MAX_LINE_LENGTH) continue; // 跳过超长行

    const lineMatches = line.match(searchRegex);
    if (!lineMatches) continue;

    // 重置 lastIndex
    searchRegex.lastIndex = 0;
    const matchIndex = line.search(searchRegex);

    // 收集上下文
    const before: string[] = [];
    const after: string[] = [];
    for (let j = Math.max(0, i - contextLines); j < i; j++) {
      before.push(lines[j].slice(0, MAX_LINE_LENGTH));
    }
    for (let j = i + 1; j <= Math.min(lines.length - 1, i + contextLines); j++) {
      after.push(lines[j].slice(0, MAX_LINE_LENGTH));
    }

    matches.push({
      path: relativePath,
      line: i + 1,
      column: matchIndex >= 0 ? matchIndex + 1 : undefined,
      preview: line.slice(0, MAX_LINE_LENGTH),
      before,
      after,
    });
  }

  return matches;
}

function walkDir(
  dir: string,
  workspaceRoot: string,
  query: string,
  mode: "literal" | "regex",
  caseSensitive: boolean,
  contextLines: number,
  maxMatches: number,
  fileGlobs: string[] | undefined,
  signal?: AbortSignal,
): SearchMatch[] {
  const allMatches: SearchMatch[] = [];

  function walk(currentDir: string): void {
    if (signal?.aborted) return;
    if (allMatches.length >= maxMatches) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (signal?.aborted) return;
      if (allMatches.length >= maxMatches) return;

      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(workspaceRoot, fullPath);

      if (entry.isDirectory()) {
        if (!shouldIgnoreDir(entry.name)) {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        if (shouldIgnoreFile(entry.name)) continue;

        // 文件 glob 过滤
        if (fileGlobs && fileGlobs.length > 0) {
          const matchesAny = fileGlobs.some(g => matchesGlob(relativePath, g));
          if (!matchesAny) continue;
        }

        const remaining = maxMatches - allMatches.length;
        const fileMatches = searchInFile(
          fullPath, relativePath, query, mode, caseSensitive,
          contextLines, maxMatches, remaining, signal,
        );
        allMatches.push(...fileMatches);
      }
    }
  }

  walk(dir);
  return allMatches;
}

function safeStat(p: string): fs.Stats | null {
  try { return fs.statSync(p); } catch { return null; }
}

// ── 工具执行器 ────────────────────────────────────────────

async function executeSearchCode(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const query = String(args.query || "").trim();
  if (!query) return JSON.stringify({ success: false, errorCode: "INVALID_QUERY", error: "query 不能为空", retryable: false, matches: [], totalMatches: 0, returnedMatches: 0, truncated: false });

  const mode = (args.mode === "regex" ? "regex" : "literal") as "literal" | "regex";
  const maxMatches = Math.min(MAX_MATCHES, Math.max(1, Number(args.maxMatches) || 20));
  const contextLines = Math.min(MAX_CONTEXT_LINES, Math.max(0, Number(args.contextLines) || 2));
  const caseSensitive = args.caseSensitive === true;

  // 路径参数：默认工作区根目录
  const paths = Array.isArray(args.paths) ? args.paths.map(String) : ["."];
  const fileGlobs = Array.isArray(args.fileGlobs) ? args.fileGlobs.map(String) : undefined;

  // 工作区根目录：从 ToolContext 或 process.cwd()
  const workspaceRoot = path.resolve(process.cwd());

  // AbortSignal
  const signal = ctx?.signal;

  // 超时保护
  const timeoutMs = SEARCH_TIMEOUT_MS;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("搜索超时")), timeoutMs);
  });

  try {
    const searchPromise = (async (): Promise<SearchResult> => {
      const allMatches: SearchMatch[] = [];

      for (const p of paths) {
        if (signal?.aborted) break;
        if (allMatches.length >= maxMatches) break;

        const resolvedPath = path.resolve(workspaceRoot, p);

        // 路径逃逸检测
        if (!isWithinWorkspace(resolvedPath, workspaceRoot)) {
          console.warn(LOG_PREFIX, "路径逃逸检测拒绝:", p);
          continue;
        }

        const stat = safeStat(resolvedPath);
        if (!stat) continue;

        if (stat.isDirectory()) {
          const dirMatches = walkDir(
            resolvedPath, workspaceRoot, query, mode, caseSensitive,
            contextLines, maxMatches - allMatches.length, fileGlobs, signal,
          );
          allMatches.push(...dirMatches);
        } else if (stat.isFile()) {
          const relativePath = path.relative(workspaceRoot, resolvedPath);
          if (!shouldIgnoreFile(path.basename(resolvedPath))) {
            if (fileGlobs && fileGlobs.length > 0) {
              const matchesAny = fileGlobs.some(g => matchesGlob(relativePath, g));
              if (!matchesAny) continue;
            }
            const fileMatches = searchInFile(
              resolvedPath, relativePath, query, mode, caseSensitive,
              contextLines, maxMatches, maxMatches - allMatches.length, signal,
            );
            allMatches.push(...fileMatches);
          }
        }
      }

      return {
        matches: allMatches.slice(0, maxMatches),
        totalMatches: allMatches.length,
        returnedMatches: Math.min(allMatches.length, maxMatches),
        truncated: allMatches.length > maxMatches,
      };
    })();

    const result = await Promise.race([searchPromise, timeoutPromise]);
    if (timeoutId) clearTimeout(timeoutId);

    console.log(LOG_PREFIX, `搜索完成: query="${query}" mode=${mode} matches=${result.returnedMatches}/${result.totalMatches} truncated=${result.truncated}`);
    return JSON.stringify(result);
  } catch (err) {
    if (timeoutId) clearTimeout(timeoutId);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(LOG_PREFIX, "搜索失败:", msg);
    return JSON.stringify({ success: false, errorCode: "SEARCH_FAILED", error: msg, retryable: false, matches: [], totalMatches: 0, returnedMatches: 0, truncated: false });
  }
}

// ── 注册 ──────────────────────────────────────────────────

export function registerSearchCodeTool(): void {
  toolRegistry.register({
    id: "search_code",
    name: "搜索代码",
    description:
      "在工作区中搜索代码内容。返回匹配的文件、行号、上下文。\n\n" +
      "何时用：\n" +
      "- 查找函数/变量/类的定义或引用\n" +
      "- 搜索包含特定文本的文件\n" +
      "- 按文件类型过滤搜索\n\n" +
      "不要用于：\n" +
      "- 读取完整文件内容 → read_file\n" +
      "- 列出目录结构 → list_dir\n" +
      "- 修改代码 → apply_patch\n\n" +
      "参数：query（搜索文本），paths（可选，搜索路径），fileGlobs（可选，文件过滤如 '*.ts'），" +
      "mode（可选，literal/regex），maxMatches（可选，最多返回数），" +
      "contextLines（可选，上下文行数），caseSensitive（可选，区分大小写）。",
    enabled: true,
    risk: "safe",
    effectKind: "read" as const,
    verificationPolicy: "none" as const,
    needsContext: true,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索文本" },
        paths: { type: "array", description: "搜索路径（相对于工作区根目录，默认 '.'）", items: { type: "string" } },
        fileGlobs: { type: "array", description: "文件过滤 glob（如 '*.ts', 'src/**/*.js'）", items: { type: "string" } },
        mode: { type: "string", enum: ["literal", "regex"], description: "搜索模式：literal（默认）或 regex" },
        maxMatches: { type: "number", description: "最多返回匹配数（默认 20，上限 100）" },
        contextLines: { type: "number", description: "上下文行数（默认 2，上限 5）" },
        caseSensitive: { type: "boolean", description: "是否区分大小写（默认 false）" },
      },
      required: ["query"],
    },
    execute: executeSearchCode,
  });

  console.log(LOG_PREFIX, "已注册：search_code");
}
