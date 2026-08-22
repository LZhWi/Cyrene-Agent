import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ dir: "" }));
vi.mock("../runtime/runtime-paths", () => ({ getUserDataDir: () => env.dir }));

describe("memory query router settings", () => {
  afterEach(() => {
    if (env.dir) fs.rmSync(env.dir, { recursive: true, force: true });
  });

  it("stores an independent normalized configuration", async () => {
    env.dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-memory-router-"));
    const { loadMemoryQueryRouterSettings, saveMemoryQueryRouterSettings } = await import("./memory-query-router-settings");
    expect(loadMemoryQueryRouterSettings().enabled).toBe(false);
    const saved = saveMemoryQueryRouterSettings({
      enabled: true,
      provider: "Moonshot",
      baseUrl: " https://api.moonshot.cn/v1/ ",
      apiKey: " key ",
      model: " kimi-k2.5 ",
      explicitTransport: "openai",
      reasoning: "low",
    });
    expect(saved).toMatchObject({
      enabled: true,
      baseUrl: "https://api.moonshot.cn/v1",
      apiKey: "key",
      model: "kimi-k2.5",
      reasoning: "low",
    });
    expect(fs.existsSync(path.join(env.dir, "memory-query-router-settings.json"))).toBe(true);
  });

  it("normalizes common GLM provider aliases to the registered capability name", async () => {
    env.dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-memory-router-"));
    const { normalizeMemoryQueryRouterSettings } = await import("./memory-query-router-settings");
    expect(normalizeMemoryQueryRouterSettings({ provider: "GLM" }).provider).toBe("GLM（智谱）");
    expect(normalizeMemoryQueryRouterSettings({ provider: "智谱" }).provider).toBe("GLM（智谱）");
  });
});
