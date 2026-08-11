import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const markup = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "gamebot.css"), "utf8");

describe("standalone gamebot window markup", () => {
  it("contains configuration, currency wars controls, and runner status", () => {
    for (const id of [
      "gamebot-min-btn",
      "gamebot-close-btn",
      "gamebot-exe",
      "gamebot-recipe",
      "gamebot-currency-wars-config",
      "gamebot-cw-flow-mode",
      "gamebot-cw-target-mode",
      "gamebot-cw-auto-launch",
      "gamebot-cw-window-title",
      "gamebot-cw-targets",
      "gamebot-cw-ingame-investments",
      "gamebot-cw-main-rule",
      "gamebot-cw-blocked-rule",
      "gamebot-cw-outer-investment-rule",
      "gamebot-cw-ingame-investment-rule",
      "gamebot-cw-blocked-fuzzy-score",
      "gamebot-cw-button-fuzzy-score",
      "gamebot-cw-investment-fuzzy-score",
      "gamebot-cw-recognition-only",
      "gamebot-cw-elevated-input",
      "gamebot-cw-auto-detect-ocr",
      "gamebot-start-btn",
      "gamebot-stop-btn",
      "gamebot-status",
    ]) {
      expect(markup).toContain(`id="${id}"`);
    }
  });

  it("adapts the standalone window to the pearl-white chat theme", () => {
    expect(styles).toContain('html[data-ui-theme="pearl-white"] .gamebot-shell');
    expect(styles).toContain("background: #fdf9fb");
    expect(styles).toContain('html[data-ui-theme="pearl-white"] .gamebot-field input');
    expect(styles).toContain('html[data-ui-theme="pearl-white"] .gamebot-primary');
  });
});
