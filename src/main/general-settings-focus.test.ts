import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("general settings window focus", () => {
  it("does not show and focus the pet window for unrelated settings saves", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/main/index.ts"), "utf8");
    const applyBlock = source.slice(
      source.indexOf("function applyGeneralSettings"),
      source.indexOf("function applyPetZoom"),
    );

    expect(applyBlock).toContain("previous.petVisible !== settings.petVisible");
    expect(applyBlock).toContain("mainWindow?.showInactive()");
    expect(source).toContain("applyGeneralSettings(normalized, before)");
  });
});
