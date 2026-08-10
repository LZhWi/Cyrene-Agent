import { describe, expect, it } from "vitest";
import type { CodeGitDiffResult } from "../../../../../shared/code-git-types";
import { buildCodeDiffViewModel } from "./code-diff-view-model";

describe("buildCodeDiffViewModel", () => {
  it("parses a unified patch into reviewable hunks", () => {
    const result: CodeGitDiffResult = {
      kind: "ready",
      sessionId: "session-1",
      path: "src/a.ts",
      patch: [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n"),
    };

    const model = buildCodeDiffViewModel(result);

    expect(model.kind).toBe("ready");
    if (model.kind === "ready") {
      expect(model.files).toHaveLength(1);
      expect(model.files[0].hunks).toHaveLength(1);
    }
  });

  it.each(["binary", "too_large", "error"] as const)("keeps %s results explicit", (kind) => {
    const result = kind === "error"
      ? { kind, sessionId: "session-1", path: "image.png", message: "无法读取" }
      : kind === "too_large"
        ? { kind, sessionId: "session-1", path: "image.png", maxBytes: 2 * 1024 * 1024 }
        : { kind, sessionId: "session-1", path: "image.png" };

    expect(buildCodeDiffViewModel(result)).toMatchObject({ kind });
  });
});
