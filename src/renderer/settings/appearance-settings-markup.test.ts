import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const html = fs.readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");

function form(id: string): string {
  const match = html.match(new RegExp(`<form[^>]+id="${id}"[\\s\\S]*?</form>`));
  if (!match) throw new Error(`missing form ${id}`);
  return match[0];
}

describe("appearance settings markup", () => {
  it("adds appearance navigation and renames general settings", () => {
    expect(html).toContain('data-section="appearance"');
    expect(html).toContain('data-section="general"><span>⚙️</span>通用设置');
  });

  it("contains the four appearance groups and disabled future options", () => {
    const panel = form("appearance-form");
    for (const heading of ["布局", "外观主题", "个性化", "昔涟桌宠"]) {
      expect(panel).toContain(heading);
    }
    for (const label of ["单窗口", "字体", "桌面图标", "聊天背景"]) {
      expect(panel).toMatch(new RegExp(`<button[^>]+disabled[^>]*>[\\s\\S]*?${label}[\\s\\S]*?SOON`));
    }
  });

  it("offers only default and pearl-white themes", () => {
    const panel = form("appearance-form");
    expect(panel).toContain('data-theme="classic"');
    expect(panel).toContain('data-theme="pearl-white"');
    expect(panel).not.toContain('data-theme="polished-pink"');
  });

  it("moves desktop-pet controls out of general settings", () => {
    const appearance = form("appearance-form");
    const general = form("general-form");
    for (const id of ["pet-always-on-top", "pet-visible", "pet-zoom"]) {
      expect(appearance).toContain(`id="${id}"`);
      expect(general).not.toContain(`id="${id}"`);
    }
  });
});
