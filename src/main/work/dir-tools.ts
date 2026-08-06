// dir-tools —— code/learn 会话的目录沙箱只读文件工具。
//
// 设计原则：
//   - 只在 Work 会话绑定了 boundDir 时由 work-ipc 临时构造注入，不进全局工具注册表，
//     因此 chat/collab/proactive 管线完全看不到这些工具。
//   - 三个工具全部只读（list/read/search），risk="safe" 不触发权限审批。
//   - 沙箱：所有相对路径先 resolve 到 rootDir 内并做前缀校验（防 ../ 逃逸），
//     再对已存在路径做 realpath 校验（防符号链接逃逸）。
//   - LLM 视角只接触相对绑定根的路径，输出也统一用相对路径。

import * as fs from "fs";
import * as path from "path";
import type { ToolDefinition } from "../orchestrator/tool-registry";

/** 递归遍历时跳过的噪音目录（代码仓与 Obsidian 库共用）。 */
const SKIP_DIR_NAMES = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "build", "out", ".next",
  ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache",
  "coverage", ".obsidian", ".trash", ".cache", ".idea", ".vscode",
]);

const MAX_LIST_ENTRIES = 200;
const MAX_READ_BYTES = 200 * 1024;
const MAX_READ_OUTPUT_CHARS = 30_000;
const MAX_SEARCH_FILES = 2000;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;
const DEFAULT_SEARCH_RESULTS = 50;
const MAX_SEARCH_RESULTS = 100;

/** 把 LLM 给的相对路径解析成沙箱内绝对路径；越界抛错。 */
export function resolveSandboxed(rootDir: string, relPath?: string): string {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, relPath?.trim() || ".");
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error("[错误] 路径超出绑定目录范围");
  }
  // 符号链接逃逸防护：路径存在时，真实路径必须仍在沙箱内。
  if (fs.existsSync(target)) {
    const real = fs.realpathSync(target);
    const realRoot = fs.realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new Error("[错误] 路径指向绑定目录之外的位置");
    }
    return real;
  }
  return target;
}

function toRelative(rootDir: string, absolute: string): string {
  const rel = path.relative(path.resolve(rootDir), absolute);
  return rel === "" ? "." : rel.split(path.sep).join("/");
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192);
  return sample.includes(0);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function listDirectory(rootDir: string, relPath?: string): string {
  const dir = resolveSandboxed(rootDir, relPath);
  if (!fs.existsSync(dir)) return `[错误] 目录不存在：${toRelative(rootDir, dir)}`;
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) return `[错误] 不是目录：${toRelative(rootDir, dir)}`;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const dirs: string[] = [];
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      dirs.push(`${entry.name}/`);
    } else if (entry.isFile()) {
      try {
        const size = fs.statSync(path.join(dir, entry.name)).size;
        files.push(`${entry.name} (${formatSize(size)})`);
      } catch {
        files.push(entry.name);
      }
    }
  }
  dirs.sort((a, b) => a.localeCompare(b));
  files.sort((a, b) => a.localeCompare(b));
  const lines = [...dirs, ...files];
  const truncated = lines.length > MAX_LIST_ENTRIES;
  const shown = lines.slice(0, MAX_LIST_ENTRIES);
  const header = `目录 ${toRelative(rootDir, dir)} 下共 ${lines.length} 项：`;
  const footer = truncated ? `\n（仅显示前 ${MAX_LIST_ENTRIES} 项）` : "";
  return shown.length > 0 ? `${header}\n${shown.join("\n")}${footer}` : `${header}\n（空目录）`;
}

function readFile(rootDir: string, args: Record<string, unknown>): string {
  const relPath = typeof args.path === "string" ? args.path : "";
  if (!relPath.trim()) return "[错误] 缺少 path 参数";
  const file = resolveSandboxed(rootDir, relPath);
  if (!fs.existsSync(file)) return `[错误] 文件不存在：${toRelative(rootDir, file)}`;
  const stat = fs.statSync(file);
  if (!stat.isFile()) return `[错误] 不是文件：${toRelative(rootDir, file)}`;
  if (stat.size > MAX_READ_BYTES) {
    return `[错误] 文件过大（${formatSize(stat.size)}），请用 startLine/endLine 分段读取`;
  }
  const buffer = fs.readFileSync(file);
  if (looksBinary(buffer)) return "[错误] 该文件是二进制文件，无法读取";
  const allLines = buffer.toString("utf8").split(/\r?\n/);
  const start = Math.max(1, typeof args.startLine === "number" && Number.isFinite(args.startLine) ? Math.floor(args.startLine) : 1);
  const end = Math.min(allLines.length, typeof args.endLine === "number" && Number.isFinite(args.endLine) ? Math.floor(args.endLine) : allLines.length);
  if (start > end) return `[错误] startLine(${start}) 大于 endLine(${end})`;
  const rel = toRelative(rootDir, file);
  const gutter = String(end).length;
  const lines: string[] = [];
  let output = "";
  let truncated = false;
  for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
    const line = `${String(lineNumber).padStart(gutter)}| ${allLines[lineNumber - 1]}`;
    if (output.length + line.length > MAX_READ_OUTPUT_CHARS) { truncated = true; break; }
    lines.push(line);
    output += line;
  }
  const rangeNote = start === 1 && end === allLines.length ? "" : `（第 ${start}-${end} 行 / 共 ${allLines.length} 行）`;
  return `文件 ${rel}${rangeNote}：\n${lines.join("\n")}${truncated ? "\n（内容过长已截断，请缩小行号范围）" : ""}`;
}

interface SearchState {
  regex: RegExp;
  results: string[];
  limit: number;
  filesScanned: number;
  rootDir: string;
}

function searchDirectory(state: SearchState, dir: string): void {
  if (state.results.length >= state.limit || state.filesScanned >= MAX_SEARCH_FILES) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (state.results.length >= state.limit || state.filesScanned >= MAX_SEARCH_FILES) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      searchDirectory(state, full);
    } else if (entry.isFile()) {
      state.filesScanned += 1;
      try {
        const stat = fs.statSync(full);
        if (stat.size > MAX_SEARCH_FILE_BYTES) continue;
        const buffer = fs.readFileSync(full);
        if (looksBinary(buffer)) continue;
        const lines = buffer.toString("utf8").split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (state.results.length >= state.limit) return;
          if (state.regex.test(lines[index])) {
            state.regex.lastIndex = 0;
            const text = lines[index].trim();
            state.results.push(`${toRelative(state.rootDir, full)}:${index + 1}: ${text.slice(0, 200)}`);
          }
        }
      } catch { /* 单个文件读失败不影响整体搜索 */ }
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function searchFiles(rootDir: string, args: Record<string, unknown>): string {
  const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
  if (!pattern) return "[错误] 缺少 pattern 参数";
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    regex = new RegExp(escapeRegExp(pattern), "i");
  }
  const requested = typeof args.maxResults === "number" && Number.isFinite(args.maxResults)
    ? Math.floor(args.maxResults)
    : DEFAULT_SEARCH_RESULTS;
  const limit = Math.min(Math.max(requested, 1), MAX_SEARCH_RESULTS);
  const startDir = resolveSandboxed(rootDir, typeof args.path === "string" ? args.path : undefined);
  if (fs.existsSync(startDir) && !fs.statSync(startDir).isDirectory()) {
    return `[错误] path 必须是目录：${toRelative(rootDir, startDir)}`;
  }
  const state: SearchState = { regex, results: [], limit, filesScanned: 0, rootDir };
  searchDirectory(state, startDir);
  if (state.results.length === 0) return `未在 ${toRelative(rootDir, startDir)} 中找到匹配「${pattern}」的内容（扫描了 ${state.filesScanned} 个文件）`;
  const footer = state.results.length >= limit ? `\n（结果已截断至 ${limit} 条）` : "";
  return `匹配「${pattern}」的内容（共 ${state.results.length} 条）：\n${state.results.join("\n")}${footer}`;
}

/** 为绑定了目录的 Work 会话构造只读文件工具。rootDir 必须是已存在的目录。 */
export function buildDirTools(rootDir: string): ToolDefinition[] {
  const root = path.resolve(rootDir);
  return [
    {
      id: "file_list",
      name: "列出目录",
      description: "列出绑定目录内某个子目录的条目（文件夹和文件）。path 为相对绑定目录的路径，省略则列出根目录。",
      catalogHint: "浏览绑定目录的结构",
      enabled: true,
      risk: "safe",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对绑定目录的子目录路径，省略为根目录" },
        },
      },
      execute: async (args) => {
        try {
          return listDirectory(root, typeof args.path === "string" ? args.path : undefined);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    },
    {
      id: "file_read",
      name: "读取文件",
      description: "读取绑定目录内一个文本文件的内容（只读）。返回带行号的内容，可用 startLine/endLine 分段读取。",
      catalogHint: "读取绑定目录内的文本文件",
      enabled: true,
      risk: "safe",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对绑定目录的文件路径" },
          startLine: { type: "number", description: "起始行号（从 1 开始，可选）" },
          endLine: { type: "number", description: "结束行号（可选）" },
        },
        required: ["path"],
      },
      execute: async (args) => {
        try {
          return readFile(root, args);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    },
    {
      id: "file_search",
      name: "搜索内容",
      description: "在绑定目录内递归搜索包含指定文本（支持正则）的文件行，返回「文件:行号: 内容」。",
      catalogHint: "在绑定目录内按内容搜索",
      enabled: true,
      risk: "safe",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "要搜索的文本或正则表达式" },
          path: { type: "string", description: "限定搜索的子目录（相对绑定目录，可选）" },
          maxResults: { type: "number", description: "最多返回的结果条数（默认 50，上限 100）" },
        },
        required: ["pattern"],
      },
      execute: async (args) => {
        try {
          return searchFiles(root, args);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    },
  ];
}
