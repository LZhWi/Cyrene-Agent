import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const html = fs.readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");

describe("social context settings markup", () => {
  it("is presented as an opt-in Chat and Collab preference", () => {
    expect(html).toContain('id="social-context-select"');
    expect(html).toContain("Chat 和 Collab");
    expect(html).toContain('class="option-block is-active" data-value="off"');
    expect(html.indexOf('id="social-context-select"')).toBeLessThan(html.indexOf('id="asr-panel"'));
  });
});
