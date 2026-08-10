import { describe, expect, it } from "vitest";
import type { ChatSession } from "../../shared/chat-types";
import type { ResolvedGitExecutable } from "./git-executable";
import { createGitService, type GitClient, type GitStatusSnapshot } from "./git-service";

const executable: ResolvedGitExecutable = {
  command: "git",
  source: "system",
  version: "2.55.0",
};

function session(mode: ChatSession["mode"], workspaceRoot = "C:\\repo"): ChatSession {
  return {
    id: "session-1",
    title: "Code task",
    identityId: null,
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 1,
    mode,
    workspaceBinding: { workspaceRoot, displayName: "repo", boundAt: 1 },
  };
}

const cleanStatus: GitStatusSnapshot = {
  current: "main",
  ahead: 0,
  behind: 0,
  files: [],
};

function client(overrides: Partial<GitClient> = {}): GitClient {
  return {
    isRepository: async () => true,
    getStatus: async () => cleanStatus,
    getBranches: async () => ["main"],
    getLineStats: async () => ({ insertions: 0, deletions: 0, byPath: {} }),
    getTrackedDiff: async () => "",
    getUntrackedDiff: async () => "",
    init: async () => undefined,
    add: async () => undefined,
    commit: async () => "committed",
    checkout: async () => undefined,
    checkoutNewBranch: async () => undefined,
    push: async () => undefined,
    revert: async () => undefined,
    ...overrides,
  };
}

function service(options: {
  mode?: ChatSession["mode"];
  client?: GitClient;
  executable?: ResolvedGitExecutable | null;
}) {
  return createGitService({
    getSession: () => session(options.mode ?? "code"),
    resolveExecutable: async () => options.executable === undefined ? executable : options.executable,
    createClient: () => options.client ?? client(),
  });
}

describe("GitService.getStatusForSession", () => {
  it.each(["work", "chat", "learn"] as const)("does not expose Git state to a %s session", async (mode) => {
    const result = await service({ mode }).getStatusForSession("session-1");

    expect(result).toMatchObject({
      state: "error",
      message: "Git 工作台只在 Code 模式可用",
      files: [],
    });
  });

  it("reports a non-repository instead of a clean repository", async () => {
    const result = await service({ client: client({ isRepository: async () => false }) })
      .getStatusForSession("session-1");

    expect(result).toMatchObject({
      state: "not_repository",
      message: "这个目录还不是 Git 仓库",
      files: [],
    });
  });

  it("normalizes added, modified, deleted, renamed and conflicted files", async () => {
    const result = await service({
      client: client({
        getStatus: async () => ({
          current: "main",
          ahead: 2,
          behind: 1,
          files: [
            { path: "new.ts", index: "?", workingDir: "?" },
            { path: "changed.ts", index: " ", workingDir: "M" },
            { path: "old.ts", index: "D", workingDir: " " },
            { path: "b.ts", fromPath: "a.ts", index: "R", workingDir: " " },
            { path: "conflict.ts", index: "U", workingDir: "U" },
          ],
        }),
        getBranches: async () => ["main", "feature/review"],
        getLineStats: async () => ({ insertions: 100, deletions: 23, byPath: {
          "changed.ts": { insertions: 100, deletions: 23 },
        } }),
      }),
    }).getStatusForSession("session-1");

    expect(result).toMatchObject({
      state: "ready",
      ahead: 2,
      behind: 1,
      branch: { current: "main", detached: false, branches: ["main", "feature/review"] },
      summary: { added: 1, modified: 1, deleted: 1, renamed: 1, conflicted: 1 },
      lines: { insertions: 100, deletions: 23 },
    });
    expect(result.files.map((file) => file.kind)).toEqual([
      "added",
      "modified",
      "deleted",
      "renamed",
      "conflicted",
    ]);
  });
});

describe("GitService.getDiffForSession", () => {
  it("rejects a parent traversal path before executing Git", async () => {
    const result = await service({}).getDiffForSession("session-1", "..\\secret.txt");

    expect(result).toEqual({
      kind: "error",
      sessionId: "session-1",
      path: "..\\secret.txt",
      message: "只能审阅当前仓库中的变更文件",
    });
  });

  it("rejects an absolute path before executing Git", async () => {
    const result = await service({}).getDiffForSession("session-1", "C:\\secret.txt");

    expect(result).toEqual({
      kind: "error",
      sessionId: "session-1",
      path: "C:\\secret.txt",
      message: "只能审阅当前仓库中的变更文件",
    });
  });
});
