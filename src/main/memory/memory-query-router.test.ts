import { describe, expect, it, vi } from "vitest";
import {
  MEMORY_QUERY_ROUTER_TIMEOUT_MS,
  parseMemoryQueryRoute,
  routeMemoryQuery,
  type MemoryQueryRouterSettings,
} from "./memory-query-router";

const settings: MemoryQueryRouterSettings = {
  enabled: true,
  provider: "test",
  baseUrl: "https://example.test/v1",
  apiKey: "secret",
  model: "small-router",
  explicitTransport: "openai",
  reasoning: "off",
};

describe("memory query router", () => {
  it("allows fifteen seconds before falling back", () => {
    expect(MEMORY_QUERY_ROUTER_TIMEOUT_MS).toBe(15_000);
  });

  it("does not confuse reported speech with a relationship commitment", () => {
    expect(parseMemoryQueryRoute('{"needsExpansion":false,"retrievalKinds":[],"scope":"normal","confidence":0.98}'))
      .toMatchObject({ needsExpansion: false, retrievalKinds: [], scope: "normal" });
  });

  it("accepts multiple fixed kinds and removes invalid or duplicate labels", () => {
    expect(parseMemoryQueryRoute([
      "```json",
      '{"needsExpansion":true,"retrievalKinds":["commitment","wish","commitment","topic"],"scope":"scoped_list","confidence":0.91}',
      "```",
    ].join("\n"))).toEqual({
      needsExpansion: true,
      retrievalKinds: ["commitment", "wish"],
      scope: "scoped_list",
      confidence: 0.91,
      source: "llm",
    });
  });

  it("fails closed on invalid model output", () => {
    expect(parseMemoryQueryRoute("commitment")).toEqual({
      needsExpansion: false,
      retrievalKinds: [],
      scope: "normal",
      confidence: 0,
      source: "fallback",
    });
  });

  it("fails closed when the provider request rejects", async () => {
    const request = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(routeMemoryQuery("我们说好的礼物", settings, { request })).resolves.toEqual({
      needsExpansion: false,
      retrievalKinds: [],
      scope: "normal",
      confidence: 0,
      source: "fallback",
    });
  });

  it("uses a retrieval-intent prompt instead of classifying surface words", async () => {
    const request = vi.fn().mockResolvedValue('{"needsExpansion":true,"retrievalKinds":["commitment"],"scope":"scoped_list","confidence":0.94}');
    const result = await routeMemoryQuery("我们说好的礼物", settings, { request });
    expect(result.retrievalKinds).toEqual(["commitment"]);
    expect(request.mock.calls[0][2]).toBe(15_000);
    expect(request.mock.calls[0][0]).toContain("他们都说好看");
    expect(request.mock.calls[0][0]).toContain("我们说好的礼物");
  });

  it("treats natural collective references as past-memory intent even when phrased as a statement", async () => {
    const request = vi.fn().mockResolvedValue('{"needsExpansion":true,"retrievalKinds":["commitment"],"scope":"exhaustive_list","confidence":0.95}');
    await routeMemoryQuery(
      "放心哦，和你的每一个约定我都会记在本子上的嘛。而且，等我视频通话功能做好了以后，你明年大概率就能看着我给你做礼物啦",
      settings,
      { request },
    );
    const prompt = String(request.mock.calls[0][0]);
    expect(prompt).toContain("不要求用户使用问句");
    expect(prompt).toContain("每一个约定");
    expect(prompt).toContain("scope=exhaustive_list");
  });

  it("requests a JSON object from compatible providers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"needsExpansion":false,"retrievalKinds":[],"scope":"normal","confidence":0.9}' } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      await routeMemoryQuery("普通聊天", { ...settings, provider: "GLM（智谱）" });
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(body.response_format).toEqual({ type: "json_object" });
    } finally {
      fetchMock.mockRestore();
    }
  });
});
