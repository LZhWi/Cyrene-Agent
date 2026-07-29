/**
 * Cline 适配层 - 命令白名单结构化匹配
 *
 * 安全约束：
 * - executable + args 精确匹配
 * - 拒绝 &&、||、;、管道、重定向
 * - 拒绝 cmd/PowerShell/bash/sh 等 shell 包装器
 * - 拒绝 cd/pushd 等 cwd 切换
 * - 禁止 npx 隐式下载安装依赖（npx 仅允许已知包）
 */

import type { CommandAllowList } from "./types";

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

/**
 * 默认命令白名单（合并重复的 npx 条目）
 */
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

/**
 * 检查命令列表是否全部允许。
 * 返回 undefined 表示全部通过，返回 { skip, reason } 表示拒绝。
 */
export function checkCommands(
  commands: unknown,
  allowList?: CommandAllowList,
): { skip?: boolean; reason?: string } | undefined {
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

function isCommandAllowed(cmd: ParsedCommand, list: CommandAllowList): boolean {
  const entry = list.executables.find(e => e.name === cmd.executable);
  if (!entry) return false;

  // args 精确匹配
  return entry.allowedArgs.some(allowed => {
    if (allowed.length !== cmd.args.length) return false;
    return allowed.every((arg, i) => arg === cmd.args[i]);
  });
}
