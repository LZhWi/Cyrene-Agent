import { describe, expect, it, vi } from "vitest";
import { focusMinecraftThirdPerson, MINECRAFT_VISION_POLICY, observeMinecraftThirdPerson } from "./vision";

const config = { baseUrl: "https://vision.test/v1", apiKey: "secret", model: "glm-4.6v-flash" };
const image = { base64: "image", mime: "image/png" };
const ok = (model = "glm-4.6v-flash") => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ sceneSummary: "林间空地", userActivity: "在砍树", opportunities: ["拾取木头"], hazards: [], confidence: 0.9, model }) } }] }) });

describe("Minecraft third-person VLM", () => {
  it("uses a large token budget and parses bounded JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    const result = await observeMinecraftThirdPerson(config, image, {}, { fetchImpl: fetchImpl as never });
    expect(result.sceneSummary).toBe("林间空地");
    expect(result.gamebotAppearance).toBe("");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).max_tokens).toBe(8192);
  });

  it("retries every second ten times then falls back", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
      const model = JSON.parse(init.body).model;
      return model === MINECRAFT_VISION_POLICY.fallbackModel ? ok(model) : { ok: false, status: 429 };
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await observeMinecraftThirdPerson(config, image, {}, { fetchImpl: fetchImpl as never, sleep });
    expect(result.model).toBe(MINECRAFT_VISION_POLICY.fallbackModel);
    expect(fetchImpl).toHaveBeenCalledTimes(12);
    expect(sleep).toHaveBeenCalledTimes(10);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("does not retry malformed content", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: "not json" } }] }) });
    await expect(observeMinecraftThirdPerson(config, image, {}, { fetchImpl: fetchImpl as never })).rejects.toThrow("有效 JSON");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("passes the user's focus to the same large-budget vision path", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      choices: [{ message: { content: [{ type: "text", text: "整体是林间空地；你正在砍树。" }] } }],
    }) });
    const result = await focusMinecraftThirdPerson(config, image, "我在做什么", { health: 20 }, { fetchImpl: fetchImpl as never });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.messages[0].content[0].text).toContain("问题：我在做什么");
    expect(body.messages[0].content[0].text).toContain("镜头跟随的人物是 GameBot 自己");
    expect(body.messages[0].content[0].text).toContain("user.visible=false");
    expect(body.max_tokens).toBe(8192);
    expect(result).toContain("正在砍树");
  });

  it("deterministically prevents the camera subject from being called the user", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      choices: [{ message: { content: "你处于画面中央偏下，正在待机。" } }],
    }) });
    const result = await focusMinecraftThirdPerson(config, image, "我在做什么", { user: { visible: false } }, { fetchImpl: fetchImpl as never });
    expect(result).toContain("画面中央的人物是 GameBot");
    expect(result).toContain("看不到用户");
    expect(result).not.toContain("你处于画面中央");
  });
});
