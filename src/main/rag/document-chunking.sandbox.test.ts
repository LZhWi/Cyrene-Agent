import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { evaluateDocumentChunkingSandbox } from "./document-chunking-diagnostics";
import { createSemanticDocumentChunks, createSemanticDocumentUnits } from "./semantic-chunk";

const vector = (text: string) => /star|telescope/i.test(text) ? [1, 0] : [0, 1];
const embedBatch = vi.fn(async (texts: string[]) => texts.map(vector));

describe("isolated semantic document chunking", () => {
  it("keeps same-topic text together and separates a topic change", async () => {
    const result = await createSemanticDocumentChunks(
      "star telescope observations. star evolution.\nflour cake baking. oven temperature.",
      "topics.md",
      embedBatch,
      { atomicTarget: 1, minTokens: 1, targetTokens: 20, maxTokens: 30, adjacentThreshold: 0.8, centroidThreshold: 0.8 },
    );
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[0].text).not.toContain("flour");
  });

  it("preserves Markdown headings and fenced code as structural units", () => {
    const units = createSemanticDocumentUnits("# Design\nIntro.\n```ts\nconst answer = 42;\n```\n## Injection\nDone.", 16);
    expect(units.some((unit) => unit.text.includes("const answer = 42") && unit.hardBoundaryBefore)).toBe(true);
    expect(units.some((unit) => unit.headingPath.join(" > ") === "Design > Injection")).toBe(true);
  });

  it("does not mutate or write alongside source data during diagnostics", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-document-chunking-"));
    const source = path.join(dir, "source.md");
    fs.writeFileSync(source, "star telescope.\nflour cake.", "utf8");
    const before = createHash("sha256").update(fs.readFileSync(source)).digest("hex");
    try {
      const report = await evaluateDocumentChunkingSandbox({
        text: fs.readFileSync(source, "utf8"),
        embedBatch,
        options: { atomicTarget: 1, minTokens: 1, targetTokens: 20, maxTokens: 30 },
      });
      expect(report.actualDataUnchanged).toBe(true);
      expect(report.sourceHashAfter).toBe(before);
      expect(fs.readdirSync(dir)).toEqual(["source.md"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
