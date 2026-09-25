import { describe, expect, it, vi } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createDream } from "../plugins/companion-memory/src/dream";

function fixture() {
  const map = new Map<string, unknown>();
  const storage: PluginStorage = { get: <T>(key: string) => structuredClone(map.get(key)) as T | undefined, set: (key, value) => { map.set(key, structuredClone(value)); }, rootDir: () => "unused" };
  const entries = [
    { id: "secret-a", content: "用户曾计划去京都", quote: "秋天想去京都", sourceAt: 100, turnId: "a", sessionId: "s", pinned: false, status: "aging" as const },
    { id: "secret-b", content: "用户认真准备旅行", quote: "酒店订好了", sourceAt: 200, turnId: "b", sessionId: "s", pinned: false, status: "aging" as const },
  ];
  const evidence = [{ id: "secret-e", memoryId: "secret-a", quoteSnippet: "准备秋天出发", createdAt: 110, sourceStatus: "active" as const, provenance: "verified" as const }];
  return { dream: createDream(storage), map, storage, entries, evidence };
}
const signal = () => new AbortController().signal;

describe("人工梦境反思", () => {
  it("模型只生成待确认草稿，不接触持久化 ID；应用后按本地默认注入并可显式关闭或撤销", async () => {
    const { dream, entries, evidence } = fixture(), generate = vi.fn().mockResolvedValue("我记得那次秋日旅行的准备，也珍惜其中认真规划的心意；这些片段让我更理解这段期待。");
    const review = await dream.review({ entryIds: ["secret-a", "secret-b"], revision: 4 }, entries, evidence, 4, generate, signal());
    expect(review.status).toBe("pending");
    const prompt = generate.mock.calls[0][0];
    expect(prompt).toContain("用户曾计划去京都"); expect(prompt).toContain("准备秋天出发");
    expect(prompt).not.toContain("secret-a"); expect(prompt).not.toContain("secret-e");
    expect(dream.context()).toBe("");
    dream.resolve({ id: review.id, action: "apply" }, entries, 4);
    expect(dream.context()).toContain("这是你在梦里沉淀下来的关系印象"); expect(dream.context()).toContain("秋日旅行");
    dream.setInjection(false);
    expect(dream.context()).toBe("");
    dream.setInjection(true);
    dream.resolve({ id: review.id, action: "undo" }, entries, 4);
    expect(dream.context()).toBe("");
  });

  it("拒绝 active/置顶候选、无效模型输出和来源变化后的旧草稿", async () => {
    const first = fixture();
    await expect(first.dream.review({ entryIds: ["secret-a", "secret-b"], revision: 4 }, [{ ...first.entries[0], status: "active" as const }, first.entries[1]], first.evidence, 4, vi.fn(), signal())).rejects.toThrow("只接受");
    await expect(first.dream.review({ entryIds: ["secret-a", "secret-b"], revision: 4 }, first.entries, first.evidence, 4, vi.fn().mockResolvedValue("太短"), signal())).rejects.toThrow("输出无效");
    const second = fixture(), review = await second.dream.review({ entryIds: ["secret-a", "secret-b"], revision: 4 }, second.entries, second.evidence, 4, vi.fn().mockResolvedValue("这是一段长度足够且只基于给定材料生成的克制反思文本，用于验证来源变化时不会被应用。"), signal());
    expect(() => second.dream.resolve({ id: review.id, action: "apply" }, [{ ...second.entries[0], content: "已改变" }, second.entries[1]], 4)).toThrow("来源记忆已变化");
    expect(() => second.dream.resolve({ id: review.id, action: "apply" }, second.entries, 5)).not.toThrow();
  });

  it("统一梦境周期可沉淀本轮进入 aging 或 archived 的条目，人工入口仍只接受 aging", async () => {
    const data = fixture(), archived = data.entries.map((entry) => ({ ...entry, status: "archived" as const }));
    await expect(data.dream.review({ entryIds: ["secret-a", "secret-b"], revision: 4 }, archived, data.evidence, 4, vi.fn(), signal())).rejects.toThrow("只接受");
    const review = await data.dream.reviewCycle({ entryIds: ["secret-a", "secret-b"], revision: 4 }, archived, data.evidence, 4,
      vi.fn().mockResolvedValue("这些逐渐淡去的旅行准备仍提醒我珍惜那份认真期待，也让我记得关系里细小而真实的投入。"), signal());
    expect(review).toMatchObject({ status: "pending", entryIds: ["secret-a", "secret-b"] });
  });

  it("取消后的迟到模型结果不写入插件存储", async () => {
    const { dream, entries, evidence, map } = fixture(), controller = new AbortController();
    const generate = vi.fn(async () => { controller.abort(); return "这是一段长度足够的迟到反思文本，取消后不应写入任何梦境状态。"; });
    await expect(dream.review({ entryIds: ["secret-a", "secret-b"], revision: 4 }, entries, evidence, 4, generate, controller.signal)).rejects.toThrow("已取消");
    expect(map.has("dream-state")).toBe(false);
  });

  it("第九段只淘汰最旧叙事，并把旧复核标为不可撤销的 evicted", async () => {
    const { dream, entries, evidence } = fixture(); let firstReviewId = "";
    for (let index = 0; index < 9; index++) {
      const review = await dream.review({ entryIds: ["secret-a", "secret-b"], revision: 4 }, entries, evidence, 4, vi.fn().mockResolvedValue(`这是第${index + 1}段长度足够的梦境反思文本，只用于验证八段容量淘汰行为，不添加任何材料外事实。`), signal());
      if (!index) firstReviewId = review.id;
      dream.resolve({ id: review.id, action: "apply" }, entries, 4);
    }
    const state = dream.view();
    expect(state.narratives).toHaveLength(8);
    expect(state.reviews.find((review) => review.id === firstReviewId)?.status).toBe("evicted");
    expect(() => dream.resolve({ id: firstReviewId, action: "undo" }, entries, 4)).toThrow("不能撤销");
  });

  it("日志裁剪保留现存叙事的来源复核并可安全重载", async () => {
    const { dream, storage, entries, evidence } = fixture();
    for (let index = 0; index < 8; index++) {
      const review = await dream.review({ entryIds: ["secret-a", "secret-b"], revision: 4 }, entries, evidence, 4, vi.fn().mockResolvedValue(`这是第${index + 1}段需要长期保留来源关联的梦境反思文本，长度足够且不增加材料外事实。`), signal());
      dream.resolve({ id: review.id, action: "apply" }, entries, 4);
    }
    for (let index = 0; index < 30; index++) {
      const review = await dream.review({ entryIds: ["secret-a", "secret-b"], revision: 4 }, entries, evidence, 4, vi.fn().mockResolvedValue(`这是第${index + 1}段随后关闭的普通草稿文本，用于验证日志裁剪不会挤掉已保存叙事的来源。`), signal());
      dream.resolve({ id: review.id, action: "dismiss" }, entries, 4);
    }
    const reloaded = createDream(storage).view();
    expect(reloaded.narratives).toHaveLength(8); expect(reloaded.reviews).toHaveLength(30);
    for (const narrative of reloaded.narratives) expect(reloaded.reviews.find((review) => review.id === narrative.reviewId)?.status).toBe("applied");
  });
});
