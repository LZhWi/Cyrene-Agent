// ShellExecutionPolicy — 系统侧命令分类，不信任模型 purpose
//
// 分类规则：
// - read_only：只读命令（ls, cat, rg, git status 等）
// - verification：run_verification 专用（不在本模块处理）
// - workspace_mutation：可能修改工作区的命令
// - blocked：明确禁止的命令
//
// 不信任模型填写的 purpose 参数，完全由系统侧按 executable + argv 白名单判断。
// 未知参数组合默认拒绝（workspace_mutation），不默认只读。

export type ShellExecutionPolicy =
  | "read_only"
  | "verification"
  | "workspace_mutation"
  | "blocked";

// ── 只读命令白名单 ──────────────────────────────────────

/** 不带子命令的只读可执行文件 */
const READ_ONLY_EXECUTABLES = new Set([
  "ls", "cat", "head", "tail", "wc", "find", "grep", "rg", "fd",
  "echo", "pwd", "which", "where", "type", "file", "stat", "du",
  "df", "uname", "hostname", "date", "id", "whoami", "env",
  "sort", "uniq", "cut", "tr", "sed", "awk",  // 纯文本处理（不带重定向）
]);

/** 带精确子命令的只读 git 命令 */
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "branch",  // branch 单独检查 -d/-D
  "remote", "stash", "tag", "describe", "rev-parse", "ls-files",
  "ls-remote", "cat-file", "count-objects", "config --get",
]);

/** git branch 的写操作参数 */
const GIT_BRANCH_WRITE_FLAGS = new Set(["-d", "-D", "-m", "-M", "-c", "-C"]);

/** git stash 的写操作子命令 */
const GIT_STASH_WRITE_SUBCOMMANDS = new Set(["push", "pop", "drop", "clear", "apply", "create"]);

/** git remote 的写操作子命令 */
const GIT_REMOTE_WRITE_SUBCOMMANDS = new Set(["add", "remove", "rename", "set-url", "prune", "update"]);

/** find 的写操作参数 */
const FIND_WRITE_FLAGS = new Set(["-delete", "-exec", "-execdir", "-ok"]);

// ── 明确禁止的可执行文件 ────────────────────────────────

const BLOCKED_EXECUTABLES = new Set([
  "rm", "rmdir", "del", "format", "mkfs",
  "shutdown", "reboot", "halt", "poweroff",
  "dd", "mkfs", "fdisk",
  "chmod", "chown", "chgrp",  // 权限修改
]);

// ── 危险 Shell 包装器 ──────────────────────────────────

const DANGEROUS_SHELL_WRAPPERS = new Set([
  "cmd", "powershell", "pwsh", "bash", "sh", "zsh", "fish",
  "cmd.exe", "powershell.exe", "bash.exe", "sh.exe",
]);

// ── 分类函数 ────────────────────────────────────────────

/**
 * 分类 shell 命令的执行策略。
 * 基于 executable + argv 精确匹配，不信任模型 purpose。
 * 未知参数组合默认拒绝（workspace_mutation），不默认只读。
 */
export function classifyShellPolicy(
  executable: string,
  args: string[],
): ShellExecutionPolicy {
  const exe = executable.toLowerCase().replace(/\.exe$/, "");
  const allArgs = args.map(a => a.toLowerCase());

  // ── 1. 明确禁止的可执行文件 ──
  if (BLOCKED_EXECUTABLES.has(exe)) return "blocked";

  // ── 2. 危险 Shell 包装器 -> workspace_mutation ──
  // cmd /c, powershell -Command, bash -c 等
  if (DANGEROUS_SHELL_WRAPPERS.has(exe)) return "workspace_mutation";

  // ── 3. 检查重定向、管道、命令连接符 ──
  // 这些在结构化 argv 中不应该出现（模型应该只传纯参数），
  // 但防御性检查
  const allTokens = [executable, ...args];
  for (const token of allTokens) {
    // 重定向
    if (/^[^|]*[<>]/.test(token)) return "workspace_mutation";
    // 管道
    if (token === "|") return "workspace_mutation";
    // 命令连接符
    if (token === "&&" || token === "||" || token === ";") return "workspace_mutation";
    // 子 shell
    if (token.includes("$(") || token.includes("`")) return "workspace_mutation";
    // 通配符展开可能导致意外
    if (token.includes("*") || token.includes("?")) return "workspace_mutation";
  }

  // ── 4. 不带子命令的只读可执行文件 ──
  if (READ_ONLY_EXECUTABLES.has(exe)) return "read_only";

  // ── 5. Git 命令 ──
  if (exe === "git") {
    const subcommand = allArgs[0];
    if (!subcommand) return "workspace_mutation"; // git 无参数 -> 不确定

    if (subcommand === "branch") {
      // git branch -D/-d/-m/-M/-c/-C -> workspace_mutation
      if (allArgs.some(a => GIT_BRANCH_WRITE_FLAGS.has(a))) return "workspace_mutation";
      // git branch (查看) -> read_only
      return "read_only";
    }

    if (subcommand === "stash") {
      const stashSub = allArgs[1];
      if (stashSub && GIT_STASH_WRITE_SUBCOMMANDS.has(stashSub)) return "workspace_mutation";
      // git stash list / git stash show -> read_only
      return "read_only";
    }

    if (subcommand === "remote") {
      const remoteSub = allArgs[1];
      if (remoteSub && GIT_REMOTE_WRITE_SUBCOMMANDS.has(remoteSub)) return "workspace_mutation";
      // git remote / git remote -v -> read_only
      return "read_only";
    }

    if (subcommand === "checkout" || subcommand === "reset" || subcommand === "rebase" ||
        subcommand === "merge" || subcommand === "pull" || subcommand === "push" ||
        subcommand === "commit" || subcommand === "add" || subcommand === "rm" ||
        subcommand === "mv" || subcommand === "clean" || subcommand === "am" ||
        subcommand === "apply" || subcommand === "cherry-pick" || subcommand === "revert") {
      return "workspace_mutation";
    }

    // 只读 git 子命令
    if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return "read_only";

    // 未知 git 子命令 -> workspace_mutation（安全侧拒绝）
    return "workspace_mutation";
  }

  // ── 6. find 命令检查写操作参数 ──
  if (exe === "find") {
    if (allArgs.some(a => FIND_WRITE_FLAGS.has(a))) return "workspace_mutation";
    return "read_only";
  }

  // ── 7. 未知可执行文件 -> workspace_mutation ──
  return "workspace_mutation";
}

// ── 工具执行前策略守卫 ──────────────────────────────────

export interface ExecutionPolicyDecision {
  allowed: boolean;
  errorCode?: string;
  message?: string;
}

/**
 * 执行前策略守卫：在工具实际执行前检查是否允许。
 * 覆盖 Plan 和 Direct 模式。
 * Evidence Collector 只收集已合法执行的结果，不负责发现配置错误。
 */
export function checkExecutionPolicy(
  effectKind: string,
  verificationPolicy: string,
  toolId: string,
): ExecutionPolicyDecision {
  // 未配置工具或 effectKind=unknown -> 拒绝
  if (effectKind === "unknown") {
    return {
      allowed: false,
      errorCode: "E_UNKNOWN_TOOL_EFFECT",
      message: `工具 ${toolId} 的 effectKind 为 unknown，系统无法确定工具效果类型，拒绝执行。请为该工具配置 effectKind。`,
    };
  }

  // mutation + verificationPolicy=unknown -> 拒绝
  if (effectKind === "mutation" && verificationPolicy === "unknown") {
    return {
      allowed: false,
      errorCode: "E_UNKNOWN_VERIFICATION_POLICY",
      message: `工具 ${toolId} 的 verificationPolicy 为 unknown，系统无法确定验证策略，拒绝执行。请为该工具配置 verificationPolicy 或 verificationPolicyResolver。`,
    };
  }

  return { allowed: true };
}
