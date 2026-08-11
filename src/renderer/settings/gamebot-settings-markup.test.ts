import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const markup = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

describe("gamebot settings markup", () => {
  it("插件页只保留 Gamebot 启用开关", () => {
    expect(markup).toContain('id="plugin-gamebot-enabled"');
    expect(markup).toContain("从状态面板的“Game Bot”按钮进入独立控制窗口");
    expect(markup).not.toContain('id="gamebot-exe"');
    expect(markup).not.toContain('id="gamebot-currency-wars-config"');
    expect(markup).not.toContain('id="gamebot-start-btn"');
  });
});
