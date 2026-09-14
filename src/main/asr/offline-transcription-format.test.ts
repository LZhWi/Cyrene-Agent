import { describe, expect, it } from "vitest";
import { createTranscriptDocx, formatTranscriptSegment } from "./offline-transcription";

const segment = { start: "00:00:00", end: "00:00:45", text: "测试内容。" };

describe("offline transcription formats", () => {
  it("formats timestamped Markdown and plain text differently", () => {
    expect(formatTranscriptSegment("md", segment, true)).toBe("## 00:00:00–00:00:45\n\n测试内容。\n\n");
    expect(formatTranscriptSegment("txt", segment, true)).toBe("[00:00:00–00:00:45]\n测试内容。\n\n");
  });

  it("omits timestamps when disabled", () => {
    expect(formatTranscriptSegment("md", segment, false)).toBe("测试内容。\n\n");
    expect(formatTranscriptSegment("txt", segment, false)).toBe("测试内容。\n\n");
  });

  it("creates a valid DOCX package", async () => {
    const buffer = await createTranscriptDocx({
      title: "测试转写",
      sourceName: "audio.m4a",
      sourceHash: "abc123",
      profile: "qwen06-stream",
      language: "zh",
      duration: "00:00:45",
    }, [segment], true);
    expect(buffer.subarray(0, 2).toString("ascii")).toBe("PK");
    expect(buffer.length).toBeGreaterThan(1_000);
  });
});
