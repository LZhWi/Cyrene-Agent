// 手动实机测试（默认跳过）：优先使用独立查询路由配置，未配置时回退 GameBot Minecraft 第二层规划模型；仅发查询路由请求，不写配置或记忆。
// $env:CYRENE_LIVE_MEMORY_QUERY_ROUTER_EVAL='1'; npm.cmd test -- --run src/main/memory/memory-query-router.live.test.ts
import { describe, expect, it, vi } from "vitest";

const USER_DATA = process.env.CYRENE_MEMORY_EVAL_DATA_DIR ?? "C:/Users/ASUS/AppData/Roaming/live2d-cyrene";
vi.mock("electron", () => ({ app: { getPath: () => USER_DATA } }));
vi.mock("../token-usage-store", () => ({ recordUsage: vi.fn() }));
import { loadGameBotSettings } from "../game-bot/settings-store";
import { resolveRetrievalPlan } from "./memory-facets";
import { routeMemoryQuery, type MemoryQueryRouterSettings } from "./memory-query-router";
import { loadMemoryQueryRouterSettings, normalizeMemoryQueryRouterSettings } from "./memory-query-router-settings";

const LIVE = process.env.CYRENE_LIVE_MEMORY_QUERY_ROUTER_EVAL === "1";

function hasCompleteRouterSettings(settings: MemoryQueryRouterSettings): boolean {
  return Boolean(settings.enabled && settings.baseUrl && settings.apiKey && settings.model);
}

function loadConfiguredRouter(): MemoryQueryRouterSettings {
  const dedicated = loadMemoryQueryRouterSettings();
  if (hasCompleteRouterSettings(dedicated)) return dedicated;
  const llm = loadGameBotSettings().minecraft.llm;
  return normalizeMemoryQueryRouterSettings({
    enabled: llm.enabled,
    provider: /^glm-/i.test(llm.model) ? "GLM" : "自定义",
    baseUrl: llm.baseUrl,
    apiKey: llm.apiKey,
    model: llm.model,
    explicitTransport: "auto",
    reasoning: llm.reasoning === "low" ? "low" : llm.reasoning === "auto" ? "auto" : "off",
  });
}

describe.skipIf(!LIVE)("memory query router live evaluation with configured small model", () => {
  it("distinguishes surface wording from actual memory retrieval intent", async () => {
    const settings = loadConfiguredRouter();
    expect(hasCompleteRouterSettings(settings), "记忆查询路由与 GameBot MC 第二层 LLM 均未完整配置").toBeTruthy();
    const cases = [
      { query: "我问其他人这个电影怎么样，他们都说好看。", expected: [] },
      { query: "还记得我们说好的礼物嘛？", expected: ["commitment"] },
      { query: "之前我们是不是既计划过一起练舞，也期待以后参加舞会？", expected: ["goal", "wish"] },
      { query: "今天宿舍所有人都热得不想动。", expected: [] },
    ];
    const results = [];
    for (const item of cases) {
      let raw = "";
      const route = await routeMemoryQuery(item.query, settings, {
        onRawResponse: (text) => { raw = text; },
      });
      results.push({ query: item.query, route });
      if (route.source === "fallback") console.log("[MemoryQueryRouterRaw]", item.query, raw);
      expect(route.source, item.query).toBe("llm");
      for (const kind of item.expected) expect(route.retrievalKinds, `${item.query} missing ${kind}`).toContain(kind);
      if (item.expected.length === 0) {
        expect(route.retrievalKinds, item.query).toEqual([]);
        expect(resolveRetrievalPlan(item.query, route).maxResults, item.query).toBe(5);
      } else {
        expect(route.confidence, `${item.query} confidence too low`).toBeGreaterThanOrEqual(0.5);
        expect(resolveRetrievalPlan(item.query, route).queryKinds, item.query).not.toEqual([]);
      }
    }
    console.log("[MemoryQueryRouterLiveEval]", JSON.stringify(results, null, 2));
  }, 120000);

  it("routes the real collective-commitment statement consistently", async () => {
    const settings = loadConfiguredRouter();
    expect(hasCompleteRouterSettings(settings), "记忆查询路由与 GameBot MC 第二层 LLM 均未完整配置").toBeTruthy();
    const query = "放心哦，和你的每一个约定我都会记在本子上的嘛。而且，等我视频通话功能做好了以后，你明年大概率就能看着我给你做礼物啦";
    const routes = [];
    for (let run = 0; run < 3; run += 1) {
      routes.push(await routeMemoryQuery(query, settings));
    }
    console.log("[MemoryQueryRouterConsistencyLiveEval]", JSON.stringify(routes, null, 2));
    for (const route of routes) {
      expect(route.source).toBe("llm");
      expect(route.needsExpansion).toBe(true);
      expect(route.retrievalKinds).toContain("commitment");
      expect(route.scope).toBe("exhaustive_list");
      expect(route.confidence).toBeGreaterThanOrEqual(0.8);
    }
  }, 120000);
});
