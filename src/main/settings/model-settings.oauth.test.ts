import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
const state = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({ app: { getPath: () => state.root } }));
import { CHATGPT_OAUTH_PROVIDER, CHATGPT_OAUTH_URL } from "../../shared/chatgpt-oauth";
const oauth = { provider: CHATGPT_OAUTH_PROVIDER, baseUrl: CHATGPT_OAUTH_URL, apiKey: "oauth-managed", model: "test-model", explicitTransport: "responses" as const };
beforeEach(() => {
  vi.resetModules();
  const base = path.resolve("local-plugins/.test-runtime/oauth-settings-tests");
  fs.mkdirSync(base, { recursive: true }); state.root = fs.mkdtempSync(path.join(base, "run-"));
});
describe("optional OAuth model", () => {
  it("does not select OAuth even when it is the first saved profile, including reload", async () => {
    let settings = await import("./model-settings");
    const saved = settings.saveModelProfile(oauth).settings;
    expect(saved.defaultModelProfileId).toBeUndefined();
    expect(saved.provider).not.toBe(CHATGPT_OAUTH_PROVIDER);
    expect(settings.getDefaultModelProfile(saved)).toBeUndefined();
    vi.resetModules(); settings = await import("./model-settings");
    expect(settings.getDefaultModelProfile()).toBeUndefined();
    const id = settings.listSavedModelProfiles()[0].id;
    expect(settings.setDefaultModelProfile(id).provider).toBe(CHATGPT_OAUTH_PROVIDER);
  });
  it("preserves existing credentials and the default until the user explicitly switches", async () => {
    const settings = await import("./model-settings");
    const before = settings.saveModelProfile({ provider: "OpenAI", model: "existing", baseUrl: "https://api.example.invalid/v1", apiKey: "fixture-old", explicitTransport: "openai" }).settings;
    const after = settings.saveModelProfile(oauth).settings;
    expect(after.defaultModelProfileId).toBe(before.defaultModelProfileId);
    for (const key of ["provider", "model", "apiKey", "baseUrl", "perProvider"] as const) expect(after[key]).toEqual(before[key]);
    expect(after.modelProfiles?.[0]).toEqual(before.modelProfiles?.[0]);
    expect(settings.saveModelProfile(oauth).added).toBe(false);
    const raw = fs.readFileSync(path.join(state.root, "model-settings.json"), "utf8");
    expect(raw).not.toContain("127.0.0.1");
    expect(raw).not.toContain("accessToken");
  });
});
