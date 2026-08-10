import { describe, expect, it } from "vitest";
import type { CodeGitStatus } from "../../../../../shared/code-git-types";
import { buildCodeGitReviewSnapshot } from "./code-git-review";

const status = (files: CodeGitStatus["files"], insertions = 3): CodeGitStatus => ({
  sessionId: "s1", state: "ready", executable: { source: "system", version: "2" },
  branch: { current: "main", detached: false, branches: ["main"] }, files,
  summary: { added: 0, modified: files.length, deleted: 0, renamed: 0, conflicted: 0 },
  lines: { insertions, deletions: 1 }, ahead: 0, behind: 0,
});

describe("Code Git review snapshot", () => {
  it("keeps only files touched by successful project-mutation tools", () => {
    expect(buildCodeGitReviewSnapshot({
      sessionId: "s1",
      before: status([]),
      after: status([
        { path: "src/a.ts", kind: "modified", staged: false, unstaged: true, insertions: 8, deletions: 1 },
        { path: "src/old.ts", kind: "modified", staged: false, unstaged: true, insertions: 20, deletions: 2 },
      ], 8),
      tools: [{ id: "1", name: "apply_patch", status: "success", argsText: '{"file_path":"src/a.ts"}' }],
      capturedAt: 10,
    })).toMatchObject({
      files: [{ path: "src/a.ts", insertions: 8, deletions: 1 }],
      insertions: 8,
      deletions: 1,
    });
  });

  it("does not create a review for commit/status tools or an unchanged Git snapshot", () => {
    const dirty = status([{ path: "src/a.ts", kind: "modified", staged: false, unstaged: true, insertions: 3, deletions: 1 }]);
    expect(buildCodeGitReviewSnapshot({ sessionId: "s1", before: dirty, after: dirty, tools: [
      { id: "1", name: "git_commit", status: "success" },
    ], capturedAt: 10 })).toBeUndefined();
    expect(buildCodeGitReviewSnapshot({ sessionId: "s1", before: status([]), after: dirty, tools: [
      { id: "1", name: "git_status", status: "success" },
    ], capturedAt: 10 })).toBeUndefined();
  });
});
