import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const html = fs.readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");

function advancedPanels(): string {
  return Array.from(html.matchAll(/<form[^>]+data-panel="api-advanced"[\s\S]*?<\/form>/g))
    .map((match) => match[0])
    .join("\n");
}

describe("advanced settings markup", () => {
  it("only exposes the three runtime settings that are still supported", () => {
    const panel = advancedPanels();

    expect(panel).toContain('id="model-request-timeout-sec"');
    expect(panel).toContain('id="timeout-user-choice"');
    expect(panel).toContain("询问等待时间（秒）");

    for (const removedId of [
      "per-call-timeout-sec",
      "timeout-profile-per-attempt",
      "max-iterations",
      "max-replans",
      "max-refresh",
      "action-gate-repair-budget-sec",
      "timeout-profile-total-budget",
      "timeout-profile-remaining",
      "timeout-summary",
      "timeout-memory-judge",
      "timeout-vision",
      "chat-request-timeout-sec",
    ]) {
      expect(panel).not.toContain(`id="${removedId}"`);
    }
  });

  it("hosts skill and feature plugin management in settings", () => {
    expect(html).toContain('data-section="skills"');
    expect(html).toContain('id="skills-react-root"');
    expect(html).toContain('data-section="feature-plugins"');
    expect(html).toContain('id="feature-plugins-react-root"');
  });
});
