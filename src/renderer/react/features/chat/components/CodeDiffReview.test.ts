import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("CodeDiffReview", () => {
  it("loads every file from the review snapshot and lets each diff collapse", () => {
    const source = readFileSync(resolve(__dirname, "CodeDiffReview.tsx"), "utf8");
    const styles = readFileSync(resolve(__dirname, "CodeDiffReview.css"), "utf8");

    expect(source).toContain("snapshot.files.map");
    expect(source).toContain("collapsedPaths");
    expect(styles).toContain("diff-code-delete");
    expect(styles).toContain("diff-code-insert");
  });
});
