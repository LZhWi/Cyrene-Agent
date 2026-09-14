import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("offline transcription boundary", () => {
  it("does not depend on chat, LLM, document ingestion, or retrieval modules", () => {
    const sources = ["offline-transcription.ts", "offline-transcription-manager.ts"]
      .map((name) => fs.readFileSync(path.resolve(process.cwd(), "src/main/asr", name), "utf8"))
      .join("\n");
    expect(sources).not.toMatch(/orchestrator|vendors|llm-queue|file-ingest|document-index|retrieveQueuedDocument/i);
  });

  it("uses a partial file until every segment succeeds", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/main/asr/offline-transcription.ts"), "utf8");
    expect(source).toContain('format === "docx" ? `${outputPath}.partial.txt` : `${outputPath}.partial`');
    expect(source).toContain("fs.renameSync(partialPath, outputPath)");
    expect(source).toContain("createTranscriptDocx(metadata, transcriptSegments, includeTimestamps)");
    expect(source).not.toContain("fs.rmSync(outputPath");
  });
});
