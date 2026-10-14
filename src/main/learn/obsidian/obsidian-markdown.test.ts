import { describe, expect, it } from "vitest";
import { appendToSection, extractHeadings, readSection, replaceSection } from "./obsidian-markdown";

describe("Markdown section navigation", () => {
  const source = "# Book\nIntro\n## One\nFirst\n### Child\nDetail\n## Two\nSecond\n";

  it("reads the exact section with or without children using the located heading index", () => {
    expect(readSection(source, ["Book", "One"], false)).toBe("## One\nFirst");
    expect(readSection(source, ["Book", "One"], true)).toBe("## One\nFirst\n### Child\nDetail");
  });

  it("replaces and appends only inside the selected subtree", () => {
    const replaced = replaceSection(source, ["Book", "One"], "## One\nChanged\n", false);
    expect(replaced).toBe("# Book\nIntro\n## One\nChanged\n### Child\nDetail\n## Two\nSecond\n");
    expect(appendToSection(source, ["Book", "One"], "Addition")).toBe(
      "# Book\nIntro\n## One\nFirst\n### Child\nDetail\n\nAddition\n## Two\nSecond\n",
    );
  });

  it("ignores backtick and tilde code fences, including longer fences and CRLF", () => {
    const fenced = "# Real\r\n````markdown\r\n## Fake\r\n```\r\n## Still fake\r\n````\r\n~~~\r\n# Fake too\r\n~~~\r\n## End\r\n";
    expect(extractHeadings(fenced).map(h => h.path)).toEqual([["Real"], ["Real", "End"]]);
    expect(readSection(fenced, ["Real", "End"], false)).toBe("## End");
  });

  it("reports missing or ambiguous heading paths instead of selecting a duplicate", () => {
    expect(readSection(source, ["Missing"], true)).toEqual({ kind: "NOT_FOUND" });
    expect(readSection("# Book\n## Same\nA\n## Same\nB", ["Book", "Same"], true)).toMatchObject({ kind: "AMBIGUOUS" });
  });
});
