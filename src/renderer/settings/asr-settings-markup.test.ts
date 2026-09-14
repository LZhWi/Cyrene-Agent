import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const html = fs.readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");

describe("local ASR settings markup", () => {
  it("offers exactly the three local profiles", () => {
    const profiles = [...html.matchAll(/data-asr-profile="([^"]+)"/g)].map((match) => match[1]);
    expect(profiles).toEqual(["qwen17-stream", "paraformer-qwen17", "qwen06-stream"]);
  });

  it("provides a multiline hotword editor and does not mark local ASR as a placeholder", () => {
    expect(html).toContain('id="asr-hotwords"');
    expect(html).toContain('id="asr-local-config"');
    expect(html).not.toContain("本地（占位，敬请期待）");
  });

  it("provides a streaming microphone test without an LLM reply action", () => {
    expect(html).toContain('id="asr-test-toggle"');
    expect(html).toContain('id="asr-test-transcript"');
    expect(html).toContain('id="asr-test-partial"');
    expect(html).toContain("不调用回复模型或 TTS");
  });

  it("provides local long-audio transcription controls and explains data handling", () => {
    expect(html).toContain('id="asr-transcription-pick-input"');
    expect(html).toContain('id="asr-transcription-pick-output"');
    expect(html).toContain('id="asr-transcription-progress"');
    expect(html).toContain('id="asr-transcription-cancel"');
    expect(html).toContain('id="asr-transcription-open"');
    expect(html).toContain('<option value="md">Markdown（.md）</option>');
    expect(html).toContain('<option value="txt">纯文本（.txt）</option>');
    expect(html).toContain('<option value="docx">Word（.docx）</option>');
    expect(html).toContain('id="asr-transcription-timestamps" checked');
    expect(html).toContain("全程本地处理，不调用聊天模型，也不会自动导入知识库");
  });
});
