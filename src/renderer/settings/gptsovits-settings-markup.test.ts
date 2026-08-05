import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("GPT-SoVITS advanced settings", () => {
  it("exposes inference, version, and local weight controls", () => {
    const html = fs.readFileSync(path.resolve(process.cwd(), "src/renderer/settings/index.html"), "utf8");
    const script = fs.readFileSync(path.resolve(process.cwd(), "src/renderer/settings/settings.ts"), "utf8");
    for (const id of [
      "tts-gptsovits-version",
      "tts-gptsovits-gpt-weight",
      "tts-gptsovits-sovits-weight",
      "tts-gptsovits-split-method",
      "tts-gptsovits-top-k",
      "tts-gptsovits-top-p",
      "tts-gptsovits-temperature",
      "tts-gptsovits-repetition-penalty",
      "tts-gptsovits-sample-steps",
    ]) {
      expect(html).toContain(`id="${id}"`);
      expect(script).toContain(`"${id}"`);
    }
    expect(script).toContain("pickGptWeightFile");
    expect(script).toContain("pickSovitsWeightFile");
  });
});
