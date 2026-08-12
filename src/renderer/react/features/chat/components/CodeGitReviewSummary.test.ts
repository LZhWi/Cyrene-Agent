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

describe("CodeGitReviewSummary presentation", () => {
  it("does not reserve a fixed height and shows the expand affordance only after three files", () => {
    const source = require("node:fs").readFileSync(new URL("./CodeGitReviewSummary.css", import.meta.url), "utf8");
    const component = require("node:fs").readFileSync(new URL("./CodeGitReviewSummary.tsx", import.meta.url), "utf8");

    expect(source).not.toContain("min-height:168px");
    expect(component).toContain("snapshot.files.length > 3");
    expect(component).toContain("snapshot.files.slice(0, 3)");
  });
});
