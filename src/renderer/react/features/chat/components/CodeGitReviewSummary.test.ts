import { describe, expect, it } from "vitest";
import { splitCodeReviewPath } from "./CodeGitReviewSummary";

describe("splitCodeReviewPath", () => {
  it("separates the project-relative directory from the file name", () => {
    expect(splitCodeReviewPath("src/main/code-git/git-service.ts")).toEqual({
      directory: "src/main/code-git",
      filename: "git-service.ts",
    });
  });
});
