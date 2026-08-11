import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const markup = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

describe("sidebar Game Bot entry", () => {
  it("replaces the model switch label with Game Bot", () => {
    expect(markup).toContain('id="model-switch-btn"');
    expect(markup).toContain("<span>Game Bot</span>");
    expect(markup).not.toContain("<span>切换模型</span>");
  });
});
