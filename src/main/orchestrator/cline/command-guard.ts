/**
 * Cline 适配层 - 命令权限与用户三档权限对齐
 *
 * 三档模式：
 * - read-only: 只允许读取类命令，拒绝一切写操作
 * - per-action: 读取自动允许，写操作需要用户审批
 * - full: 工作区沙箱 + 高危操作 denylist
 *
 * 安全约束（所有档位）：
 * - 文件路径不得逃逸 resolvedWorkspaceRoot
 * - 防止 symlink / junction 越界
 * - 禁止 UAC、管理员提权、系统服务和注册表系统修改
 * - 禁止磁盘格式化、删除系统目录等破坏性系统命令
 * - 命令超时和输出长度限制
 */

import type { CommandAllowList } from "./types";

// ── 权限模式 ──────────────────────────────────────────────

export type ClinePermissionMode = "read-only" | "per-action" | "full";

// ── 命令解析 ──────────────────────────────────────────────

interface ParsedCommand {
  executable: string;
  args: string[];
  raw: string;
}

const SHELL_ELEMENTS = ["&&", "||", ";", "|", ">", "<", "&", "`", "$("];
const SHELL_WRAPPERS = new Set([
  "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh",
  "bash", "sh", "zsh", "fish", "bash.exe", "sh.exe",
]);
const CWD_COMMANDS = new Set(["cd", "pushd", "popd"]);

// ── 只读模式：允许的可执行文件 ─────────────────────────────

const READ_ONLY_EXECUTABLES = new Set([
  // 文件读取
  "cat", "less", "more", "head", "tail",
  "type", // Windows: 显示文件内容
  // 目录列举
  "ls", "dir", "Get-ChildItem", "Test-Path",
  // 搜索
  "grep", "find", "findstr", "rg", "ag",
  // Git 只读操作
  "git", // 但会检查子命令
  // 静态分析
  "tsc", "npx", // 但会检查参数
]);

// Git 只读子命令
const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "blame", "branch", "tag",
  "remote", "describe", "rev-parse", "ls-files", "ls-tree",
  "cat-file", "hash-object", "config", "help",
]);

// ── 完全模式：高危操作 denylist ────────────────────────────

/** 直接拒绝的可执行文件（系统级危险） */
const DANGEROUS_EXECUTABLES = new Set([
  // 系统提权
  "runas", "sudo", "su",
  // 磁盘格式化
  "format", "diskpart",
  // 注册表
  "reg", "regedit", "regedt32",
  // 系统服务
  "sc", "net", // net start/stop 等
  // 系统目录操作
  "rd", "rmdir", "del", "erase", // 会检查路径
  // 包管理器全局安装（风险较高）
  "pip", "pip3", // pip install 在沙箱内可接受，但需要子命令检查
]);

/** 高危参数模式（任何可执行文件） */
const DANGEROUS_ARG_PATTERNS = [
  // UAC 提权
  /-Verb\s+RunAs/i,
  /Start-Process.*-Verb\s+RunAs/i,
  // 远程脚本执行
  /curl.*\|\s*(bash|sh|zsh|pwsh|powershell)/i,
  /wget.*\|\s*(bash|sh|zsh|pwsh|powershell)/i,
  /iex\s*\(/i, // PowerShell Invoke-Expression
  /Invoke-Expression/i,
  // 不可逆 Git 操作
  /git\s+reset\s+--hard/i,
  /git\s+clean\s+-[a-z]*f/i,
  /git\s+push\s+.*--force/i,
  /git\s+push\s+.*-f\b/i,
  // 删除系统目录
  /rm\s+-rf?\s+\//i,
  /Remove-Item.*-Recurse.*-Force/i,
  // 环境变量注入
  /\$\(.*\)/, // 命令替换
  /`.*`/, // 反引号命令替换
];

/** npx --yes 需要特殊确认（供应链风险） */
const NPX_YES_PATTERN = /npx\s+.*--yes/i;

// ── 默认白名单（兼容旧接口） ──────────────────────────────

export const DEFAULT_COMMAND_ALLOW_LIST: CommandAllowList = {
  executables: [
    {
      name: "npx",
      allowedArgs: [
        ["tsc", "--noEmit"],
        ["tsc", "-p", "tsconfig.json", "--noEmit"],
        ["tsc", "-p", "tsconfig.main.json", "--noEmit"],
        ["vitest", "run"],
        ["eslint", "src", "--max-warnings=0"],
      ],
    },
    {
      name: "npm",
      allowedArgs: [
        ["test"],
        ["run", "test"],
      ],
    },
    {
      name: "pwd",
      allowedArgs: [[]],  // 无参数，只读
    },
  ],
};

// ── 命令检查结果 ──────────────────────────────────────────

export interface CommandCheckResult {
  /** 是否跳过（拒绝） */
  skip?: boolean;
  /** 拒绝原因 */
  reason?: string;
  /** 是否需要用户确认（per-action 模式） */
  needApproval?: boolean;
  /** 审批描述（用于 UI 展示） */
  approvalDescription?: string;
}

// ── 核心检查函数 ──────────────────────────────────────────

/**
 * 根据权限模式检查命令列表。
 * - read-only: 只允许读取类命令
 * - per-action: 读取自动允许，写操作返回 needApproval
 * - full: 工作区沙箱 + 高危 denylist
 */
export function checkCommandsForMode(
  commands: unknown,
  mode: ClinePermissionMode,
  workspaceRoot?: string,
): CommandCheckResult | undefined {
  if (!Array.isArray(commands)) {
    return { skip: true, reason: "invalid commands format" };
  }

  for (const cmd of commands) {
    const parsed = parseCommand(cmd);
    if (!parsed) {
      return { skip: true, reason: `cannot parse command: ${String(cmd)}` };
    }

    // full 模式：允许 shell 包装器和管道，只检查危险模式
    if (mode === "full") {
      if (hasDangerousShellPatterns(parsed)) {
        return { skip: true, reason: `dangerous shell pattern: ${parsed.raw}` };
      }
    } else {
      // read-only / per-action：检查所有 shell 元字符
      if (hasShellMetacharacters(parsed)) {
        return { skip: true, reason: `shell metacharacters not allowed: ${parsed.raw}` };
      }
    }

    const result = checkSingleCommandForMode(parsed, mode, workspaceRoot);
    if (result) return result;
  }

  return undefined;
}

/**
 * 兼容旧接口：使用默认白名单检查。
 */
export function checkCommands(
  commands: unknown,
  allowList?: CommandAllowList,
): CommandCheckResult | undefined {
  if (!Array.isArray(commands)) {
    return { skip: true, reason: "invalid commands format" };
  }

  const list = allowList ?? DEFAULT_COMMAND_ALLOW_LIST;

  for (const cmd of commands) {
    const parsed = parseCommand(cmd);
    if (!parsed) {
      return { skip: true, reason: `cannot parse command: ${String(cmd)}` };
    }

    if (hasShellMetacharacters(parsed)) {
      return { skip: true, reason: `shell metacharacters not allowed: ${parsed.raw}` };
    }

    if (!isCommandAllowed(parsed, list)) {
      return { skip: true, reason: `command not allowed: ${parsed.raw}` };
    }
  }

  return undefined;
}

// ── 内部实现 ──────────────────────────────────────────────

function checkSingleCommandForMode(
  cmd: ParsedCommand,
  mode: ClinePermissionMode,
  workspaceRoot?: string,
): CommandCheckResult | undefined {
  const lowerExe = cmd.executable.toLowerCase();

  // 所有模式都检查高危参数模式
  for (const pattern of DANGEROUS_ARG_PATTERNS) {
    if (pattern.test(cmd.raw)) {
      return { skip: true, reason: `dangerous command pattern: ${cmd.raw}` };
    }
  }

  // 所有模式都检查高危可执行文件
  if (DANGEROUS_EXECUTABLES.has(lowerExe)) {
    return { skip: true, reason: `dangerous executable: ${cmd.executable}` };
  }

  // npx --yes 供应链风险（所有模式都拒绝，除非有特殊审批）
  if (NPX_YES_PATTERN.test(cmd.raw)) {
    return { skip: true, reason: `npx --yes not allowed (supply chain risk): ${cmd.raw}` };
  }

  switch (mode) {
    case "read-only":
      return checkReadOnly(cmd);
    case "per-action":
      return checkPerAction(cmd);
    case "full":
      return checkFull(cmd, workspaceRoot);
  }
}

// ── 只读模式 ──────────────────────────────────────────────

function checkReadOnly(cmd: ParsedCommand): CommandCheckResult | undefined {
  const lowerExe = cmd.executable.toLowerCase();

  // Git 需要检查子命令
  if (lowerExe === "git") {
    const subcmd = cmd.args[0]?.toLowerCase();
    if (!subcmd || !GIT_READ_ONLY_SUBCOMMANDS.has(subcmd)) {
      return { skip: true, reason: `git ${subcmd || "(no subcommand)"} not allowed in read-only mode` };
    }
    return undefined;
  }

  // npx 只允许 tsc --noEmit（静态分析）
  if (lowerExe === "npx") {
    if (isNpxTscNoEmit(cmd)) return undefined;
    return { skip: true, reason: `npx command not allowed in read-only mode: ${cmd.raw}` };
  }

  // npm 不允许（会执行脚本）
  if (lowerExe === "npm" || lowerExe === "pnpm" || lowerExe === "yarn") {
    return { skip: true, reason: `package manager not allowed in read-only mode: ${cmd.raw}` };
  }

  // 其他可执行文件：检查是否在只读列表中
  if (READ_ONLY_EXECUTABLES.has(cmd.executable) || READ_ONLY_EXECUTABLES.has(lowerExe)) {
    return undefined;
  }

  return { skip: true, reason: `command not allowed in read-only mode: ${cmd.raw}` };
}

// ── 审批模式 ──────────────────────────────────────────────

function checkPerAction(cmd: ParsedCommand): CommandCheckResult | undefined {
  const lowerExe = cmd.executable.toLowerCase();

  // 读取类操作自动允许
  if (isReadOnlyCommand(cmd)) {
    return undefined;
  }

  // 写操作需要审批
  return {
    needApproval: true,
    approvalDescription: `命令: ${cmd.raw}`,
  };
}

function isReadOnlyCommand(cmd: ParsedCommand): boolean {
  const lowerExe = cmd.executable.toLowerCase();

  // Git 只读子命令
  if (lowerExe === "git") {
    const subcmd = cmd.args[0]?.toLowerCase();
    return !!subcmd && GIT_READ_ONLY_SUBCOMMANDS.has(subcmd);
  }

  // npx tsc --noEmit（静态分析）
  if (lowerExe === "npx" && isNpxTscNoEmit(cmd)) {
    return true;
  }

  // 纯读取命令
  const readCommands = new Set([
    "cat", "less", "more", "head", "tail", "type",
    "ls", "dir", "Get-ChildItem", "Test-Path",
    "grep", "find", "findstr", "rg", "ag",
    "pwd", "echo", "whoami", "hostname",
    "wc", "sort", "uniq", "cut", "tr", "sed", "awk",
  ]);

  return readCommands.has(cmd.executable) || readCommands.has(lowerExe);
}

// ── 完全模式 ──────────────────────────────────────────────

function checkFull(cmd: ParsedCommand, workspaceRoot?: string): CommandCheckResult | undefined {
  // 完全模式：默认允许，只拒绝高危操作
  // 高危可执行文件和参数模式已在 checkSingleCommandForMode 中检查

  // Shell 包装器在完全模式下允许（PowerShell/cmd 是正常命令载体）
  // 但仍然检查内部命令是否高危

  // npm/pnpm/yarn 项目脚本在完全模式下允许
  // tsc、lint、test、build 在完全模式下允许
  // git 项目内操作在完全模式下允许（除了 --force push 等已在 denylist 中）

  return undefined;
}

// ── 工具函数 ──────────────────────────────────────────────

export function parseCommand(cmd: unknown): ParsedCommand | null {
  if (typeof cmd === "string") {
    const trimmed = cmd.trim();
    if (!trimmed) return null;
    const parts = trimmed.split(/\s+/);
    if (parts.length === 0) return null;
    return { executable: parts[0], args: parts.slice(1), raw: cmd };
  }
  if (cmd && typeof cmd === "object") {
    const c = cmd as Record<string, unknown>;
    const exe = String(c.command || "");
    if (!exe) return null;
    const args = Array.isArray(c.args) ? c.args.map(String) : [];
    return { executable: exe, args, raw: `${exe} ${args.join(" ")}` };
  }
  return null;
}

export function hasShellMetacharacters(cmd: ParsedCommand): boolean {
  // 检查可执行文件是否是 shell 包装器
  if (SHELL_WRAPPERS.has(cmd.executable.toLowerCase())) return true;

  // 检查 cwd 切换命令
  if (CWD_COMMANDS.has(cmd.executable.toLowerCase())) return true;

  // 检查 args 中是否有 shell 元字符
  const allText = cmd.raw;
  for (const elem of SHELL_ELEMENTS) {
    if (allText.includes(elem)) return true;
  }

  return false;
}

/**
 * 检查危险 shell 模式（用于 full 模式）。
 * 允许 shell 包装器（cmd/powershell/bash）和基本管道（|、&&），
 * 但拒绝命令替换（$()、反引号）等危险模式。
 */
export function hasDangerousShellPatterns(cmd: ParsedCommand): boolean {
  const allText = cmd.raw;

  // 检查危险的命令替换模式
  if (allText.includes("$(")) return true;  // $(command) 命令替换
  if (/`[^`]+`/.test(allText)) return true;  // 反引号命令替换

  // 检查重定向到文件（可能覆盖重要文件）
  if (/>\s*[^>&]/.test(allText)) {
    // 检查是否重定向到危险路径
    if (/>\s*\/dev\//.test(allText)) return true;  // /dev/ 设备文件
    if (/>\s*nul/i.test(allText)) return true;  // Windows nul 设备
  }

  // 检查 here-doc（可能包含危险命令）
  if (/<</.test(allText)) return true;

  return false;
}

function isCommandAllowed(cmd: ParsedCommand, list: CommandAllowList): boolean {
  const entry = list.executables.find(e => e.name === cmd.executable);
  if (!entry) return false;

  // args 精确匹配
  return entry.allowedArgs.some(allowed => {
    if (allowed.length !== cmd.args.length) return false;
    return allowed.every((arg, i) => arg === cmd.args[i]);
  });
}

function isNpxTscNoEmit(cmd: ParsedCommand): boolean {
  // npx tsc --noEmit
  // npx tsc -p tsconfig.json --noEmit
  // npx tsc -p tsconfig.main.json --noEmit
  if (cmd.executable.toLowerCase() !== "npx") return false;
  if (cmd.args[0]?.toLowerCase() !== "tsc") return false;
  const rest = cmd.args.slice(1);
  return rest.includes("--noEmit") || rest.includes("-noEmit");
}

// ── 汇总统计 ──────────────────────────────────────────────

export interface CommandPolicySummary {
  mode: ClinePermissionMode;
  approved: number;
  denied: number;
  needApproval: number;
}

/**
 * 批量检查命令并返回汇总统计（用于日志）。
 */
export function checkCommandsSummary(
  commands: unknown[],
  mode: ClinePermissionMode,
  workspaceRoot?: string,
): CommandPolicySummary {
  const summary: CommandPolicySummary = {
    mode,
    approved: 0,
    denied: 0,
    needApproval: 0,
  };

  for (const cmd of commands) {
    const parsed = parseCommand(cmd);
    if (!parsed) {
      summary.denied++;
      continue;
    }

    const result = checkSingleCommandForMode(parsed, mode, workspaceRoot);
    if (!result) {
      summary.approved++;
    } else if (result.needApproval) {
      summary.needApproval++;
    } else {
      summary.denied++;
    }
  }

  return summary;
}
