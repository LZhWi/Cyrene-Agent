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
});
