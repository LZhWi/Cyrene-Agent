import { describe, expect, it } from "vitest";
import { addModelProfile, resolveDefaultModelProfile } from "./model-catalog";
import { normalizeModelSettings, getDefaultModelProfile, getPublicModelConfig } from "./model-settings";

describe("model catalog", () => {
  it("keeps the first saved model as the default and rejects a duplicate key plus model", () => {
    const first = addModelProfile([], {
      id: "openai-1",
      provider: "ChatGPT（OpenAI）",
      displayName: "我的 GPT",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-same",
      model: "gpt-5.6",
      explicitTransport: "openai",
    });

    expect(first.added).toBe(true);
    expect(resolveDefaultModelProfile(first.profiles, undefined)?.id).toBe("openai-1");

    const duplicate = addModelProfile(first.profiles, {
      ...first.profiles[0],
      id: "openai-2",
      displayName: "重复项",
    });

    expect(duplicate.added).toBe(false);
    expect(duplicate.profiles).toHaveLength(1);
  });

  it("marks the public status connected when a saved model exists even if the legacy mirror is empty", () => {
    const settings = normalizeModelSettings({
      provider: "ChatGPT（OpenAI）",
      apiKey: "",
      model: "",
      modelProfiles: [{
        id: "saved-model",
        provider: "ChatGPT（OpenAI）",
        displayName: "我的模型",
        apiKey: "sk-saved",
        model: "gpt-5.6",
        baseUrl: "https://api.openai.com/v1",
      }],
    });
    expect(getPublicModelConfig(settings).connected).toBe(true);
  });

  it("migrates an existing configured model into the default catalog entry", () => {
    const settings = normalizeModelSettings({
      provider: "ChatGPT（OpenAI）",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-existing",
      model: "gpt-5.6",
    });

    expect(getDefaultModelProfile(settings)).toMatchObject({
      provider: "ChatGPT（OpenAI）",
      model: "gpt-5.6",
    });
  });
});
