import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { estimateTokens } from "./chunk";
import { evaluateDocumentChunkingSandbox } from "./document-chunking-diagnostics";
import { createSemanticDocumentChunks, createSemanticDocumentUnits } from "./semantic-chunk";

function topicVector(text: string): number[] {
  if (/星系|恒星|望远镜/u.test(text)) return [1, 0, 0];
  if (/面粉|烤箱|蛋糕/u.test(text)) return [0, 1, 0];
  return [0, 0, 1];
}

const embedBatch = vi.fn(async (texts: string[]) => texts.map(topicVector));

describe("isolated document semantic-chunking sandbox", () => {
  it("merges adjacent same-topic sentences and separates a topic change", async () => {
    const text = [
      "星系包含大量恒星。望远镜可以观察遥远星系。恒星会经历不同演化阶段。",
      "制作蛋糕需要面粉。烤箱温度会影响蛋糕口感。",
    ].join("\n");

    const result = await createSemanticDocumentChunks(text, "topics.md", embedBatch, {
      atomicTarget: 1,
      minTokens: 1,
      targetTokens: 40,
      maxTokens: 60,
      adjacentThreshold: 0.8,
      centroidThreshold: 0.8,
      embeddingBatchSize: 2,
    });

    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[0].text).toContain("望远镜");
    expect(result.chunks[0].text).not.toContain("面粉");
    expect(result.chunks[1].text).toContain("面粉");
    expect(result.embeddingTexts).toBe(result.atomicUnitCount + result.chunks.length);
  });

  it("enforces the maximum chunk size even when every adjacent unit is similar", async () => {
    const text = Array.from({ length: 20 }, (_, index) => `恒星观测记录 ${index}。`).join("");
    const result = await createSemanticDocumentChunks(text, "stars.md", embedBatch, {
      atomicTarget: 1,
      minTokens: 1,
      targetTokens: 12,
      maxTokens: 16,
      adjacentThreshold: 0.8,
      centroidThreshold: 0.8,
      embeddingBatchSize: 4,
    });

    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.chunks.every((chunk) => estimateTokens(chunk.text) <= 16)).toBe(true);
    expect(result.embeddingTexts).toBe(result.atomicUnitCount + result.chunks.length);
  });

  it("keeps Markdown headings and fenced code as structural units", () => {
    const units = createSemanticDocumentUnits([
      "# 检索设计",
      "第一段说明。第二句补充。",
      "```ts",
      "const answer = 42;",
      "```",
      "## 注入",
      "最后一段。",
    ].join("\n"), 16);

    expect(units.some((unit) => unit.text.startsWith("# 检索设计") && unit.hardBoundaryBefore)).toBe(true);
    expect(units.some((unit) => unit.text.includes("const answer = 42") && unit.hardBoundaryBefore)).toBe(true);
    expect(units.some((unit) => unit.headingPath.join(" > ") === "检索设计 > 注入")).toBe(true);
  });

  it("does not write or mutate source data while comparing baseline and semantic chunking", async () => {
    const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-document-chunking-sandbox-"));
    const sentinel = path.join(isolatedDir, "source.md");
    const text = "星系包含恒星。望远镜用于观测。\n制作蛋糕需要面粉。烤箱需要预热。";
    fs.writeFileSync(sentinel, text, "utf8");
    const before = createHash("sha256").update(fs.readFileSync(sentinel)).digest("hex");
    try {
      const report = await evaluateDocumentChunkingSandbox({
        text: fs.readFileSync(sentinel, "utf8"),
        embedBatch,
        options: { atomicTarget: 1, minTokens: 1, targetTokens: 40, maxTokens: 60 },
      });

      expect(report.actualDataUnchanged).toBe(true);
      expect(report.sourceHashAfter).toBe(report.sourceHashBefore);
      expect(report.semantic.embeddingBatchCalls).toBeGreaterThan(0);
      expect(fs.readdirSync(isolatedDir)).toEqual(["source.md"]);
      expect(createHash("sha256").update(fs.readFileSync(sentinel)).digest("hex")).toBe(before);
    } finally {
      fs.rmSync(isolatedDir, { recursive: true, force: true });
    }
  });
});
