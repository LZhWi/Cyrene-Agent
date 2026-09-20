import { describe, expect, it, vi } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import type { Turn } from "../plugins/companion-chat/src/chat";
import { createSocialContext } from "../plugins/companion-memory/src/social-context";

function fixture(start = Date.parse("2026-09-20T08:00:00Z")) {
  const data = new Map<string, unknown>();
  const storage: PluginStorage = {
    get: (key) => structuredClone(data.get(key)) as never,
    set: (key, value) => { data.set(key, structuredClone(value)); },
    rootDir: () => "unused",
  };
  let at = start;
  const generate = vi.fn<(_: string, __: AbortSignal) => Promise<string>>().mockResolvedValue("[]");
  const social = createSocialContext(storage, generate, undefined, () => at);
  const turn = (id: string, user: string, sessionId = "chat-1"): Turn => ({
    id, sessionId, user, assistant: "好的，我们之后继续。", userAt: at - 1_000, assistantAt: at,
  });
  return { social, generate, data, turn, setNow: (value: number) => { at = value; } };
}

const signal = () => new AbortController().signal;

describe("短期状态与未完话题", () => {
  it("只接受带逐字用户证据的结构化结果，并按同一会话检索", async () => {
    const { social, generate, turn } = fixture();
    generate.mockResolvedValueOnce(JSON.stringify([
      { action: "add", type: "short_term", content: "用户明天要去复诊并等待结果", evidenceQuote: "明天要去复诊" },
      { action: "add", type: "open_loop", content: "复诊结束后继续聊检查结果", evidenceQuote: "复诊完再聊结果" },
      { action: "add", type: "short_term", content: "无效猜测", evidenceQuote: "用户没有说过" },
    ]));
    await social.extract(turn("turn-1", "我明天要去复诊，复诊完再聊结果"), signal());
    expect(social.view()).toMatchObject({ total: 2, active: 2 });
    const selected = await social.retrieve("chat-1", "复诊结束后继续聊检查结果", signal());
    expect(selected.some((atom) => atom.type === "open_loop")).toBe(true);
    expect(await social.retrieve("chat-2", "复诊结束后继续聊检查结果", signal())).toEqual([]);
    const block = social.buildBlock(selected, "Asia/Shanghai");
    expect(block).toContain("尚未接上的话题");
    expect(block).toContain("16:00");
  });

  it("短期状态 14 天、未完话题 3 天后归档，显式回忆可恢复命中项", async () => {
    const start = Date.parse("2026-09-01T00:00:00Z");
    const { social, generate, turn, setNow } = fixture(start);
    generate.mockResolvedValueOnce(JSON.stringify([
      { action: "add", type: "short_term", content: "用户本周正在准备考试复习计划", evidenceQuote: "本周正在准备考试" },
      { action: "add", type: "open_loop", content: "考试结束后继续聊考试结果", evidenceQuote: "考完以后继续聊结果" },
    ]));
    await social.extract(turn("turn-1", "我本周正在准备考试，考完以后继续聊结果"), signal());
    setNow(start + 4 * 86_400_000);
    expect((await social.retrieve("chat-1", "考试结束后的考试结果", signal())).some((atom) => atom.type === "open_loop")).toBe(false);
    expect((await social.retrieve("chat-1", "继续上次考试结束后聊考试结果", signal())).some((atom) => atom.type === "open_loop")).toBe(true);
    setNow(start + 15 * 86_400_000);
    expect((await social.retrieve("chat-1", "用户本周正在准备考试复习计划", signal())).some((atom) => atom.type === "short_term")).toBe(false);
  });

  it("仅能用本轮用户逐字证据关闭已检索的未完话题", async () => {
    const { social, generate, data, turn } = fixture();
    generate.mockResolvedValueOnce(JSON.stringify([
      { action: "add", type: "open_loop", content: "完成报告后继续讨论结论", evidenceQuote: "写完报告再聊结论" },
    ]));
    await social.extract(turn("turn-1", "我写完报告再聊结论"), signal());
    const atom = (data.get("social-context-state") as any).atoms[0];
    generate.mockResolvedValueOnce(JSON.stringify([
      { action: "resolve", targetId: atom.id, evidenceQuote: "报告已经写完了" },
    ]));
    await social.extract(turn("turn-2", "完成报告后继续讨论结论，报告已经写完了"), signal());
    expect(social.view()).toMatchObject({ total: 1, active: 0 });
  });
});
