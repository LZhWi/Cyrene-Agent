import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
describe("isolated narrow composer and window titles", () => {
  it("wraps footer controls instead of breaking permission labels", () => {
    const css = readFileSync(resolve(__dirname, "ChatComposer.css"), "utf8");
    expect(css).toMatch(/\.cy-composer__footer \{[^}]*flex-wrap: wrap;/);
    expect(css).toMatch(/\.cy-composer__footer-button,\s*\.cy-composer__agent-button \{[^}]*flex-shrink: 0;[^}]*white-space: nowrap;/);
    expect(css).toMatch(/\.cy-page\.is-chat-mode \.cy-composer__footer \{\s*display: none;/);
  });
  it("keeps purpose-specific native titles against shared HTML title updates", () => {
    const source = readFileSync(resolve(process.cwd(), "src/main/windows/create-aux-windows.ts"), "utf8");
    expect(source).toContain('title: kind === "chat" ? "Cyrene · 聊天" : "Cyrene · 工作/学习"');
    expect(source).toContain('window.on("page-title-updated", (event) => event.preventDefault());');
  });
});
