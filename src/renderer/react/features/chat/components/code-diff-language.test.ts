import { describe, expect, it } from "vitest";
import { languageForCodeDiffPath } from "./code-diff-language";

describe("languageForCodeDiffPath", () => {
  it("maps common project source files to refractor languages", () => {
    expect(languageForCodeDiffPath("src/main/git-service.ts")).toBe("typescript");
    expect(languageForCodeDiffPath("src/renderer/App.tsx")).toBe("tsx");
    expect(languageForCodeDiffPath("package.json")).toBe("json");
  });

  it("uses plain text for an unknown extension", () => {
    expect(languageForCodeDiffPath("notes/archive.unknown")).toBe("none");
  });
});
