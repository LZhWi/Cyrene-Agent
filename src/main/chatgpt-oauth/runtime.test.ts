import { afterEach, describe, expect, it } from "vitest";
import { CHATGPT_OAUTH_URL } from "../../shared/chatgpt-oauth";
import { resolveChatGptEndpoint, setChatGptEndpoint } from "./runtime";
afterEach(() => setChatGptEndpoint(undefined));
describe("OAuth runtime endpoint", () => {
  it("leaves an API profile untouched and resolves OAuth without mutating persisted data", () => {
    const api = { baseUrl: "https://api.example.invalid/v1", apiKey: "fixture-key" };
    expect(resolveChatGptEndpoint(api)).toBe(api);
    const oauth = { baseUrl: CHATGPT_OAUTH_URL, apiKey: "oauth-managed", model: "fixture" };
    expect(() => resolveChatGptEndpoint(oauth)).toThrow("尚未就绪");
    setChatGptEndpoint({ baseUrl: "http://127.0.0.1:12345/v1", apiKey: "temporary-fixture" });
    expect(resolveChatGptEndpoint(oauth).apiKey).toBe("temporary-fixture");
    expect(oauth).toEqual({ baseUrl: CHATGPT_OAUTH_URL, apiKey: "oauth-managed", model: "fixture" });
    setChatGptEndpoint({ baseUrl: "http://127.0.0.1:12346/v1", apiKey: "replacement-fixture" });
    expect(resolveChatGptEndpoint(oauth).baseUrl).toContain("12346");
  });
});
