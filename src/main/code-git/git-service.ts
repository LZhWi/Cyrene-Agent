import * as path from "node:path";
import simpleGit from "simple-git";
import type { ChatSession } from "../../shared/chat-types";
import {
  emptyCodeGitStatus,
  type CodeGitChangeKind,
  type CodeGitFileChange,
  type CodeGitStatus,
} from "../../shared/code-git-types";
import type { ResolvedGitExecutable } from "./git-executable";
import { createGitWorkspaceWatcher, type GitWorkspaceWatcher } from "./git-workspace-watcher";

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
  init(): Promise<void>;
  add(paths: string[]): Promise<void>;
  commit(message: string): Promise<string>;
  checkout(branch: string): Promise<void>;
  checkoutNewBranch(branch: string): Promise<void>;
  push(remote: string): Promise<void>;
  revert(commit: string): Promise<void>;
  getGitDir(): Promise<string>;
}

export interface GitServiceDeps {
  getSession: (sessionId: string) => ChatSession | null;
  resolveExecutable: () => Promise<ResolvedGitExecutable | null>;
  createClient?: (input: { workspaceRoot: string; executable: ResolvedGitExecutable }) => GitClient;
  workspaceWatcher?: GitWorkspaceWatcher;
}

export interface GitService {
  getStatusForSession(sessionId: string): Promise<CodeGitStatus>;
  onChanged(listener: (payload: { sessionId: string }) => void): () => void;
  initRepository(ctx: TrustedGitContext): Promise<string>;
  commit(ctx: TrustedGitContext, message: string, paths: string[]): Promise<string>;
  switchBranch(ctx: TrustedGitContext, branch: string, create: boolean): Promise<string>;
  push(ctx: TrustedGitContext, remote?: string): Promise<string>;
  revert(ctx: TrustedGitContext, commit: string): Promise<string>;
  watchSession(sessionId: string): Promise<void>;
  unwatchSession(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
  switchBranchForSession(sessionId: string, branch: string, create: boolean): Promise<string>;
  commitForSession(sessionId: string, message: string, paths: string[]): Promise<string>;
  pushForSession(sessionId: string): Promise<string>;
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
  const workspaceWatcher = deps.workspaceWatcher ?? createGitWorkspaceWatcher({
    onWorkspaceChanged: (sessionIds) => sessionIds.forEach(emitChanged),
    onError: () => undefined,
  });

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

  async function trustedContextForSession(sessionId: string): Promise<TrustedGitContext> {
    const resolved = await resolveCodeSession(sessionId);
    if (isCodeGitStatus(resolved)) throw new Error(resolved.message ?? "Git 状态暂时不可用");
    return { sessionId, mode: "code", workspaceRoot: resolved.workspaceRoot };
  }

  function emitChanged(sessionId: string): void {
    for (const listener of listeners) listener({ sessionId });
  }

  return {
    onChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async watchSession(sessionId) {
      const resolved = await resolveCodeSession(sessionId);
      if (isCodeGitStatus(resolved)) throw new Error(resolved.message ?? "Git 状态暂时不可用");
      const client = createClient(resolved);
      if (!await client.isRepository()) throw new Error("这个目录还不是 Git 仓库");
      await workspaceWatcher.subscribe({ sessionId, workspaceRoot: resolved.workspaceRoot, gitDir: await client.getGitDir() });
    },

    unwatchSession: (sessionId) => workspaceWatcher.unsubscribe(sessionId),
    dispose: () => workspaceWatcher.dispose(),
    async switchBranchForSession(sessionId, branch, create) {
      return this.switchBranch(await trustedContextForSession(sessionId), branch, create);
    },
    async commitForSession(sessionId, message, paths) {
      return this.commit(await trustedContextForSession(sessionId), message, paths);
    },
    async pushForSession(sessionId) {
      return this.push(await trustedContextForSession(sessionId));
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
          const output = readGitCommandOutput(error);
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
    getGitDir: async () => path.resolve(input.workspaceRoot, (await git.raw(["rev-parse", "--absolute-git-dir"])).trim()),
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

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Git 状态暂时不可用";
}

/** `git diff --no-index --numstat` uses exit code 1 when differences exist. */
function readGitCommandOutput(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const direct = (error as { stdout?: unknown }).stdout;
  if (typeof direct === "string") return direct;
  const nested = (error as { git?: { stdout?: unknown } }).git?.stdout;
  if (typeof nested === "string") return nested;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string" || !/^\d/.test(message)) return undefined;
  const warningIdx = message.search(/^(warning|fatal|error):/m);
  return warningIdx >= 0 ? message.slice(0, warningIdx) : message;
}
