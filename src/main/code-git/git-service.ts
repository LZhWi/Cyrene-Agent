import * as path from "node:path";
import simpleGit from "simple-git";
import type { ChatSession } from "../../shared/chat-types";
import {
  emptyCodeGitStatus,
  type CodeGitChangeKind,
  type CodeGitDiffResult,
  type CodeGitFileChange,
  type CodeGitStatus,
} from "../../shared/code-git-types";
import type { ResolvedGitExecutable } from "./git-executable";

const MAX_DIFF_BYTES = 2 * 1024 * 1024;

export interface GitStatusFile {
  path: string;
  fromPath?: string;
  index: string;
  workingDir: string;
}

export interface GitStatusSnapshot {
  current: string;
  ahead: number;
  behind: number;
  files: GitStatusFile[];
}

export interface GitClient {
  isRepository(): Promise<boolean>;
  getStatus(): Promise<GitStatusSnapshot>;
  getBranches(): Promise<string[]>;
  getLineStats(files: GitStatusFile[]): Promise<{
    insertions: number;
    deletions: number;
    byPath: Record<string, { insertions: number; deletions: number }>;
  }>;
  getTrackedDiff(relativePath: string): Promise<string>;
  getUntrackedDiff(relativePath: string): Promise<string>;
  init(): Promise<void>;
  add(paths: string[]): Promise<void>;
  commit(message: string): Promise<string>;
  checkout(branch: string): Promise<void>;
  checkoutNewBranch(branch: string): Promise<void>;
  push(remote: string): Promise<void>;
  revert(commit: string): Promise<void>;
}

export interface GitServiceDeps {
  getSession: (sessionId: string) => ChatSession | null;
  resolveExecutable: () => Promise<ResolvedGitExecutable | null>;
  createClient?: (input: { workspaceRoot: string; executable: ResolvedGitExecutable }) => GitClient;
}

export interface GitService {
  getStatusForSession(sessionId: string): Promise<CodeGitStatus>;
  getDiffForSession(sessionId: string, relativePath: string): Promise<CodeGitDiffResult>;
  onChanged(listener: (payload: { sessionId: string }) => void): () => void;
  initRepository(ctx: TrustedGitContext): Promise<string>;
  commit(ctx: TrustedGitContext, message: string, paths: string[]): Promise<string>;
  switchBranch(ctx: TrustedGitContext, branch: string, create: boolean): Promise<string>;
  push(ctx: TrustedGitContext, remote?: string): Promise<string>;
  revert(ctx: TrustedGitContext, commit: string): Promise<string>;
}

export interface TrustedGitContext {
  sessionId: string;
  mode: "code";
  workspaceRoot: string;
}

interface ResolvedCodeSession {
  workspaceRoot: string;
  executable: ResolvedGitExecutable;
}

export function createGitService(deps: GitServiceDeps): GitService {
  const createClient = deps.createClient ?? createSimpleGitClient;
  const listeners = new Set<(payload: { sessionId: string }) => void>();

  async function resolveCodeSession(sessionId: string): Promise<ResolvedCodeSession | CodeGitStatus> {
    const session = deps.getSession(sessionId);
    if (!session) return emptyCodeGitStatus(sessionId, "error", "找不到当前对话");
    if (session.mode !== "code") {
      return emptyCodeGitStatus(sessionId, "error", "Git 工作台只在 Code 模式可用");
    }
    const workspaceRoot = session.workspaceBinding?.workspaceRoot;
    if (!workspaceRoot) {
      return emptyCodeGitStatus(sessionId, "no_workspace", "尚未绑定代码目录");
    }
    const executable = await deps.resolveExecutable();
    if (!executable) {
      return emptyCodeGitStatus(sessionId, "git_unavailable", "未检测到可用 Git");
    }
    return { workspaceRoot, executable };
  }

  async function clientForTrustedContext(ctx: TrustedGitContext): Promise<GitClient> {
    const executable = await deps.resolveExecutable();
    if (!executable) throw new Error("未检测到可用 Git");
    return createClient({ workspaceRoot: ctx.workspaceRoot, executable });
  }

  function emitChanged(sessionId: string): void {
    for (const listener of listeners) listener({ sessionId });
  }

  return {
    onChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async initRepository(ctx) {
      const client = await clientForTrustedContext(ctx);
      await client.init();
      emitChanged(ctx.sessionId);
      return "已初始化 Git 仓库";
    },

    async commit(ctx, message, paths) {
      if (!message.trim()) throw new Error("提交信息不能为空");
      if (paths.length === 0 || paths.some((item) => !isSafeRelativePath(item))) {
        throw new Error("请提供要提交的仓库内文件路径");
      }
      const client = await clientForTrustedContext(ctx);
      await client.add(paths);
      const result = await client.commit(message.trim());
      emitChanged(ctx.sessionId);
      return result;
    },

    async switchBranch(ctx, branch, create) {
      if (!isSafeBranchName(branch)) throw new Error("分支名称不合法");
      const client = await clientForTrustedContext(ctx);
      if (create) await client.checkoutNewBranch(branch);
      else await client.checkout(branch);
      emitChanged(ctx.sessionId);
      return `已切换到分支 ${branch}`;
    },

    async push(ctx, remote = "origin") {
      if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new Error("远端名称不合法");
      const client = await clientForTrustedContext(ctx);
      await client.push(remote);
      emitChanged(ctx.sessionId);
      return `已推送到 ${remote}`;
    },

    async revert(ctx, commit) {
      if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error("提交标识必须是 7 到 40 位十六进制 hash");
      const client = await clientForTrustedContext(ctx);
      await client.revert(commit);
      emitChanged(ctx.sessionId);
      return `已创建回退提交 ${commit}`;
    },

    async getStatusForSession(sessionId: string): Promise<CodeGitStatus> {
      try {
        const resolved = await resolveCodeSession(sessionId);
        if (isCodeGitStatus(resolved)) return resolved;

        const client = createClient(resolved);
        if (!await client.isRepository()) {
          return emptyCodeGitStatus(sessionId, "not_repository", "这个目录还不是 Git 仓库");
        }

        const [status, branches] = await Promise.all([client.getStatus(), client.getBranches()]);
        const lines = await client.getLineStats(status.files);
        const files = status.files.map((file) => normalizeFileChange(file, lines.byPath[file.path]));
        return {
          sessionId,
          state: "ready",
          executable: {
            source: resolved.executable.source,
            version: resolved.executable.version,
          },
          branch: {
            current: status.current === "HEAD" ? null : status.current,
            detached: status.current === "HEAD",
            branches,
          },
          files,
          summary: summarizeFiles(files),
          lines: { insertions: lines.insertions, deletions: lines.deletions },
          ahead: status.ahead,
          behind: status.behind,
        };
      } catch (error) {
        return emptyCodeGitStatus(sessionId, "error", errorMessage(error));
      }
    },

    async getDiffForSession(sessionId: string, relativePath: string): Promise<CodeGitDiffResult> {
      if (!isSafeRelativePath(relativePath)) {
        return diffError(sessionId, relativePath, "只能审阅当前仓库中的变更文件");
      }

      try {
        const resolved = await resolveCodeSession(sessionId);
        if (isCodeGitStatus(resolved)) return diffError(sessionId, relativePath, resolved.message ?? "Git 状态暂时不可用");

        const client = createClient(resolved);
        if (!await client.isRepository()) {
          return diffError(sessionId, relativePath, "这个目录还不是 Git 仓库");
        }

        const status = await client.getStatus();
        const file = status.files.find((candidate) => sameRelativePath(candidate.path, relativePath));
        if (!file) return diffError(sessionId, relativePath, "该文件不在当前 Git 变更中");

        const patch = isUntracked(file)
          ? await client.getUntrackedDiff(relativePath)
          : await client.getTrackedDiff(relativePath);
        if (Buffer.byteLength(patch, "utf8") > MAX_DIFF_BYTES) {
          return { kind: "too_large", sessionId, path: relativePath, maxBytes: MAX_DIFF_BYTES };
        }
        if (/^Binary files .* differ$/m.test(patch)) {
          return { kind: "binary", sessionId, path: relativePath };
        }
        return { kind: "ready", sessionId, path: relativePath, patch };
      } catch (error) {
        return diffError(sessionId, relativePath, errorMessage(error));
      }
    },
  };
}

function createSimpleGitClient(input: { workspaceRoot: string; executable: ResolvedGitExecutable }): GitClient {
  const git = simpleGit({
    baseDir: input.workspaceRoot,
    binary: input.executable.command,
    maxConcurrentProcesses: 1,
  });
  if (input.executable.env) git.env(input.executable.env);

  return {
    isRepository: () => git.checkIsRepo(),
    async getStatus() {
      const status = await git.status();
      return {
        current: status.current ?? "HEAD",
        ahead: status.ahead,
        behind: status.behind,
        files: status.files.map((file) => ({
          path: file.path,
          fromPath: file.from,
          index: file.index,
          workingDir: file.working_dir,
        })),
      };
    },
    async getBranches() {
      return (await git.branchLocal()).all;
    },
    async getLineStats(files) {
      const tracked = await git.diffSummary(["HEAD"]).catch(() => ({ insertions: 0, deletions: 0, files: [] }));
      let insertions = tracked.insertions;
      let deletions = tracked.deletions;
      const byPath: Record<string, { insertions: number; deletions: number }> = {};
      for (const file of tracked.files ?? []) {
        if ("file" in file && "insertions" in file && "deletions" in file) {
          byPath[file.file] = { insertions: file.insertions, deletions: file.deletions };
        }
      }
      for (const file of files.filter(isUntracked)) {
        try {
          const output = await git.raw(["diff", "--no-index", "--numstat", "--", "/dev/null", file.path]);
          const [added, removed] = output.trim().split(/\s+/);
          const fileInsertions = /^\d+$/.test(added) ? Number(added) : 0;
          const fileDeletions = /^\d+$/.test(removed) ? Number(removed) : 0;
          insertions += fileInsertions;
          deletions += fileDeletions;
          byPath[file.path] = { insertions: fileInsertions, deletions: fileDeletions };
        } catch (error) {
          const output = typeof error === "object" && error && "stdout" in error
            ? (error as { stdout?: unknown }).stdout
            : undefined;
          if (typeof output === "string") {
            const [added, removed] = output.trim().split(/\s+/);
            const fileInsertions = /^\d+$/.test(added) ? Number(added) : 0;
            const fileDeletions = /^\d+$/.test(removed) ? Number(removed) : 0;
            insertions += fileInsertions;
            deletions += fileDeletions;
            byPath[file.path] = { insertions: fileInsertions, deletions: fileDeletions };
          }
        }
      }
      return { insertions, deletions, byPath };
    },
    getTrackedDiff: (relativePath) => git.diff(["--no-ext-diff", "HEAD", "--", relativePath]),
    async getUntrackedDiff(relativePath) {
      try {
        return await git.raw(["diff", "--no-index", "--", "/dev/null", relativePath]);
      } catch (error) {
        const stdout = typeof error === "object" && error && "stdout" in error
          ? (error as { stdout?: unknown }).stdout
          : undefined;
        if (typeof stdout === "string") return stdout;
        throw error;
      }
    },
    init: async () => { await git.init(); },
    add: async (paths) => { await git.raw(["add", "-A", "--", ...paths]); },
    async commit(message) {
      const result = await git.commit(message);
      return result.commit ? `已创建提交 ${result.commit}` : "已创建提交";
    },
    checkout: async (branch) => { await git.checkout(branch); },
    checkoutNewBranch: async (branch) => { await git.checkoutLocalBranch(branch); },
    push: async (remote) => { await git.push(remote); },
    revert: async (commit) => { await git.raw(["revert", "--no-edit", commit]); },
  };
}

function isCodeGitStatus(value: ResolvedCodeSession | CodeGitStatus): value is CodeGitStatus {
  return "state" in value;
}

function normalizeFileChange(file: GitStatusFile, lines = { insertions: 0, deletions: 0 }): CodeGitFileChange {
  const kind = classifyFileKind(file);
  return {
    path: file.path,
    ...(file.fromPath ? { fromPath: file.fromPath } : {}),
    kind,
    staged: isStaged(file),
    unstaged: isUnstaged(file),
    ...lines,
  };
}

function classifyFileKind(file: GitStatusFile): CodeGitChangeKind {
  const code = `${file.index}${file.workingDir}`;
  if (code.includes("U")) return "conflicted";
  if (code.includes("?")) return "added";
  if (code.includes("R") || file.fromPath) return "renamed";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  return "modified";
}

function isStaged(file: GitStatusFile): boolean {
  return file.index !== " " && file.index !== "?";
}

function isUnstaged(file: GitStatusFile): boolean {
  return file.workingDir !== " " && file.workingDir !== "?";
}

function isUntracked(file: GitStatusFile): boolean {
  return file.index === "?" || file.workingDir === "?";
}

function summarizeFiles(files: CodeGitFileChange[]): Record<CodeGitChangeKind, number> {
  const summary: Record<CodeGitChangeKind, number> = {
    added: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
    conflicted: 0,
  };
  for (const file of files) summary[file.kind] += 1;
  return summary;
}

function isSafeRelativePath(value: string): boolean {
  if (!value || path.isAbsolute(value) || value.includes("\0")) return false;
  return !value.replace(/\\/g, "/").split("/").some((part) => part === "..");
}

function isSafeBranchName(value: string): boolean {
  return Boolean(value)
    && value.length <= 255
    && !value.startsWith("-")
    && !value.includes("..")
    && !/[~^:\\?*\[\s]/.test(value)
    && !value.endsWith("/")
    && !value.endsWith(".");
}

function sameRelativePath(left: string, right: string): boolean {
  return left.replace(/\\/g, "/") === right.replace(/\\/g, "/");
}

function diffError(sessionId: string, path: string, message: string): CodeGitDiffResult {
  return { kind: "error", sessionId, path, message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Git 状态暂时不可用";
}
