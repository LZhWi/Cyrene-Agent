import { describe, expect, it } from "vitest";
import type { CodeGitStatus } from "../../../../../shared/code-git-types";
import { createLiveCodeGitReview } from "./code-git-live-review";

const status = (insertions: number): CodeGitStatus => ({
  sessionId: "s1", state: "ready", executable: { source: "system", version: "2" },
  branch: { current: "main", detached: false, branches: ["main"] },
  files: [{ path: "src/a.ts", kind: "modified", staged: false, unstaged: true, insertions, deletions: 1 }],
  summary: { added: 0, modified: 1, deleted: 0, renamed: 0, conflicted: 0 }, lines: { insertions, deletions: 1 }, ahead: 0, behind: 0,
});

describe("LiveCodeGitReview", () => {
  it("updates only until it is frozen for its current run", () => {
    const review = createLiveCodeGitReview({ sessionId: "s1", assistantId: "a1", before: status(0), tools: () => [
      { id: "t1", name: "apply_patch", status: "success", argsText: '{"file_path":"src/a.ts"}' },
    ] });

    expect(review.update(status(3))).toMatchObject({ insertions: 3 });
    expect(review.freeze(status(5))).toMatchObject({ insertions: 5 });
    expect(review.update(status(8))).toMatchObject({ insertions: 5 });
  });
});
