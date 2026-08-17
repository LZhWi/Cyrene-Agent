import { describe, expect, it } from "vitest";
import { normalizeMinecraftSettings } from "./types";

describe("Minecraft bot settings", () => {
  it("uses safe Java defaults", () => {
    const settings = normalizeMinecraftSettings(undefined);
    expect(settings.host).toBe("localhost");
    expect(settings.port).toBe(25565);
    expect(settings.auth).toBe("microsoft");
    expect(settings.reconnect).toBe(true);
    expect(settings.autonomy).toEqual({ mode: "passive", visionEnabled: true });
    expect(settings.soul).toEqual({ enabled: false, baseUrl: "", apiKey: "", model: "", reasoning: "off" });
    expect(settings.llm).toEqual({ enabled: false, baseUrl: "", apiKey: "", model: "", maxSteps: 6, reasoning: "auto" });
  });

  it("normalizes the optional Soul model independently", () => {
    const normalized = normalizeMinecraftSettings({
      soul: { enabled: true, baseUrl: " https://api.moonshot.cn/v1/ ", apiKey: " key ", model: " kimi-k2.6 ", reasoning: "off" },
      llm: { enabled: true, baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3.5:4b" },
    });
    expect(normalized.soul).toEqual({ enabled: true, baseUrl: "https://api.moonshot.cn/v1/", apiKey: "key", model: "kimi-k2.6", reasoning: "off" });
    expect(normalized.llm.model).toBe("qwen3.5:4b");
  });

  it("normalizes user input and invalid ports", () => {
    expect(normalizeMinecraftSettings({
      host: " example.org ", port: 70000, auth: "offline", owner: " Steve ", reconnect: false,
      llm: { enabled: true, baseUrl: " http://localhost:11434/v1 ", model: " qwen ", maxSteps: 99, reasoning: "low" },
    })).toMatchObject({
      host: "example.org", port: 25565, auth: "offline", owner: "Steve", reconnect: false,
      llm: { enabled: true, baseUrl: "http://localhost:11434/v1", model: "qwen", maxSteps: 8, reasoning: "low" },
    });
  });
});
