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
  getTrackedDiff(relativePath: string): Promise<string>;
  getUntrackedDiff(relativePath: string): Promise<string>;
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

  return {
    onChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
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
        const files = status.files.map(normalizeFileChange);
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
  };
}

function isCodeGitStatus(value: ResolvedCodeSession | CodeGitStatus): value is CodeGitStatus {
  return "state" in value;
}

function normalizeFileChange(file: GitStatusFile): CodeGitFileChange {
  const kind = classifyFileKind(file);
  return {
    path: file.path,
    ...(file.fromPath ? { fromPath: file.fromPath } : {}),
    kind,
    staged: isStaged(file),
    unstaged: isUnstaged(file),
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

function sameRelativePath(left: string, right: string): boolean {
  return left.replace(/\\/g, "/") === right.replace(/\\/g, "/");
}

function diffError(sessionId: string, path: string, message: string): CodeGitDiffResult {
  return { kind: "error", sessionId, path, message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Git 状态暂时不可用";
}
