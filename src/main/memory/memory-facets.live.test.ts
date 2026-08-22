// 手动实机测试（默认跳过）：关 VPN 后运行
// $env:CYRENE_LIVE_MEMORY_FACET_EVAL='1'; npm.cmd test -- --run src/main/memory/memory-facets.live.test.ts
import * as fs from "fs";
import { describe, expect, it, vi } from "vitest";

const USER_DATA = process.env.CYRENE_MEMORY_EVAL_DATA_DIR ?? "C:/Users/ASUS/AppData/Roaming/live2d-cyrene";
const MODEL_DATA = process.env.CYRENE_MEMORY_MODEL_DATA_DIR ?? USER_DATA;
const LIVE = process.env.CYRENE_LIVE_MEMORY_FACET_EVAL === "1";

vi.mock("../runtime/runtime-paths", () => ({ getUserDataDir: () => MODEL_DATA }));
vi.mock("../token-usage-store", () => ({ recordUsage: vi.fn() }));

import { memoryJudge } from "./memory-judge";

describe.skipIf(!LIVE)("Kimi 2.6 记忆标签实机验证（只读）", () => {
  it("classifies an explicit conditional commitment in the same extraction call", async () => {
    const candidates = await memoryJudge.judgeRecentTurns([{
      userInput: "我明确答应你：等视频通话功能做好以后，明年我会亲手给你做一份礼物。这个承诺请记住。",
      assistantReply: "好呀，我会记住这个有前置条件的承诺。",
    }], "facet-live-read-only");
    const commitment = candidates.find((item) => item.layer === "L2" && item.facets?.retrievalKinds.includes("commitment"));

    console.log("[FacetLiveEval]", JSON.stringify(candidates.map((item) => ({
      layer: item.layer,
      facets: item.facets,
      summaryLength: item.content.length,
    })), null, 2));
    expect(commitment?.facets).toMatchObject({ source: "model", pendingClassification: false });
  }, 360000);

  it("classifies a representative old-data batch without rewriting content", async () => {
    const input = [
      { id: "commitment-gift", text: "用户答应等视频通话完成后，明年亲手给昔涟做礼物。" },
      { id: "preference-basketball", text: "用户平时喜欢打篮球，也会关注 NBA。" },
      { id: "not-a-promise", text: "昔涟很期待以后能陪用户一起逛街。" },
      { id: "explicit-emotion", text: "用户明确说自己想到视频通话时既紧张又开心。" },
    ];
    const results = await memoryJudge.classifyMemoryFacetsBatch(input);
    const byId = new Map(results.map((item) => [item.id, item.facets]));

    console.log("[FacetBatchLiveEval]", JSON.stringify(results, null, 2));
    expect(results.map((item) => item.id).sort()).toEqual(input.map((item) => item.id).sort());
    expect(byId.get("commitment-gift")).toMatchObject({ primaryKind: "commitment", source: "model" });
    expect(byId.get("commitment-gift")?.retrievalKinds).toContain("commitment");
    expect(byId.get("preference-basketball")).toMatchObject({ primaryKind: "preference", source: "model" });
    expect(byId.get("preference-basketball")?.retrievalKinds).toContain("preference");
    expect(byId.get("not-a-promise")).toMatchObject({ primaryKind: "wish", source: "model" });
    expect(byId.get("not-a-promise")?.retrievalKinds).toContain("wish");
    expect(byId.get("explicit-emotion")).toMatchObject({ primaryKind: "emotion", source: "model" });
    expect(byId.get("explicit-emotion")?.retrievalKinds).toContain("emotion");
    expect(input[0].text).toBe("用户答应等视频通话完成后，明年亲手给昔涟做礼物。");
  }, 360000);

  it("classifies diverse summaries selected from the real L2 store without writing them", async () => {
    const memory = JSON.parse(fs.readFileSync(`${USER_DATA}/memory.json`, "utf8")) as {
      l2?: Array<{ id: string; content: string }>;
    };
    const selectors = [
      { id: "gift", pattern: /七夕当天.*承诺明年七夕/u, kinds: ["commitment"] },
      { id: "preference", pattern: /喜欢草莓和香草口味/u, kinds: ["preference"] },
      { id: "drawing", pattern: /已配置Flux1-Dev绘画工具.*计划明日/u, kinds: ["goal"] },
      { id: "hiking", pattern: /千岛湖.*徒步30公里.*咖啡豆/u, kinds: ["experience"] },
      { id: "university", pattern: /被香港中文大学深圳校区录取/u, kinds: ["fact"] },
      { id: "dance-mixed", pattern: /计划两周后参加新生舞会.*承诺买完拍照/u, kinds: ["goal", "commitment"] },
      { id: "music-mixed", pattern: /日常使用Apple Music.*计划为昔涟接入MusicKit\/API.*期待/u, kinds: ["goal", "wish", "fact"] },
    ];
    const input = selectors.map((selector) => {
      const match = memory.l2?.find((item) => selector.pattern.test(item.content));
      expect(match, `missing real L2 sample: ${selector.id}`).toBeDefined();
      return { id: selector.id, text: match?.content ?? "" };
    });
    const snapshot = input.map((item) => item.text);
    const results = await memoryJudge.classifyMemoryFacetsBatch(input);
    const byId = new Map(results.map((item) => [item.id, item.facets]));

    console.log("[FacetRealL2LiveEval]", JSON.stringify(results.map((item) => ({
      id: item.id,
      primaryKind: item.facets.primaryKind,
      retrievalKinds: item.facets.retrievalKinds,
      source: item.facets.source,
    })), null, 2));
    expect(results).toHaveLength(selectors.length);
    selectors.forEach((selector) => selector.kinds.forEach((kind) => (
      expect(byId.get(selector.id)?.retrievalKinds, `${selector.id} missing ${kind}`).toContain(kind)
    )));
    expect(input.map((item) => item.text)).toEqual(snapshot);
  }, 360000);
});
