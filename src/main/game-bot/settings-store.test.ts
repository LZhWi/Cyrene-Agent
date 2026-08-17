import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const root = mkdtempSync(join(tmpdir(), "cyrene-gamebot-settings-"));
const settingsFile = join(root, "game-bot-settings.json");

vi.mock("electron", () => ({ app: { getPath: () => root } }));

describe("GameBot settings isolation", () => {
  beforeEach(() => {
    writeFileSync(settingsFile, JSON.stringify({
      enabled: true,
      activeRecipe: "minecraft-player",
      vlm: { baseUrl: "https://vlm.test/v1", apiKey: "vlm-secret", model: "vision" },
      minecraft: {
        host: "localhost", port: 1314, username: "Cyrene", auth: "offline", owner: "Steve", reconnect: true,
        soul: { enabled: true, baseUrl: "https://soul.test/v1", apiKey: "soul-secret", model: "large", reasoning: "off" },
        llm: { enabled: true, baseUrl: "https://llm.test/v1", apiKey: "llm-secret", model: "small", maxSteps: 5, reasoning: "low" },
      },
    }), "utf8");
  });

  it("updates nested Minecraft LLM fields without touching VLM credentials", async () => {
    const { saveGameBotSettings } = await import("./settings-store");
    const saved = saveGameBotSettings({ minecraft: { llm: { model: "cheaper" } } as never });
    expect(saved.vlm).toEqual({ baseUrl: "https://vlm.test/v1", apiKey: "vlm-secret", model: "vision" });
    expect(saved.minecraft.llm).toMatchObject({ baseUrl: "https://llm.test/v1", apiKey: "llm-secret", model: "cheaper", maxSteps: 5 });
    expect(saved.minecraft.soul).toMatchObject({ baseUrl: "https://soul.test/v1", apiKey: "soul-secret", model: "large" });
    expect(readFileSync(settingsFile, "utf8")).toContain('"port": 1314');
  });

  it("updates Soul fields without touching the low-cost planner", async () => {
    const { saveGameBotSettings } = await import("./settings-store");
    const saved = saveGameBotSettings({ minecraft: { soul: { model: "kimi-k2.6" } } as never });
    expect(saved.minecraft.soul.model).toBe("kimi-k2.6");
    expect(saved.minecraft.llm).toMatchObject({ baseUrl: "https://llm.test/v1", apiKey: "llm-secret", model: "small" });
  });
});
