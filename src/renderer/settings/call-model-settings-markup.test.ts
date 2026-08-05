import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

describe("Call model settings markup", () => {
  it("exposes Chat, Work, and call as independent API targets", () => {
    const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

    expect(html).toContain('data-api-target="chat"');
    expect(html).toContain('data-api-target="work"');
    expect(html).toContain('data-api-target="call"');
    expect(html).toContain("语音通话模型");
  });
});
