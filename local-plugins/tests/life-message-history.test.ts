import { describe, expect, it } from "vitest";
import type { PluginConversationsService } from "@playa0v0/cyrene-plugin-sdk";
import { readLifeDayMessages } from "../plugins/companion-chat/src/life-message-history";

describe("日记消息区间", () => {
  it("跨全部 Chat 会话读取 4:00 到次日 2:00，保留全文并按时间排序", async () => {
    const startAt = new Date(2026, 8, 1, 4).getTime();
    const endAt = new Date(2026, 8, 2, 2).getTime();
    const longText = "内容".repeat(300);
    const service = {
      list: async () => ({ items: [
        { id: "a", mode: "chat" }, { id: "b", mode: "chat" }, { id: "c", mode: "work" },
      ] }),
      getMessages: async ({ conversationId }: { conversationId: string }) => ({ items: conversationId === "a" ? [
        { id: "1", role: "user", text: "边界前", at: new Date(startAt - 1).toISOString() },
        { id: "2", role: "user", text: longText, at: new Date(startAt).toISOString() },
        { id: "3", role: "assistant", text: "边界后", at: new Date(endAt).toISOString() },
      ] : conversationId === "b" ? [
        { id: "4", role: "assistant", text: "较晚回复", at: new Date(startAt + 60_000).toISOString() },
      ] : [{ id: "5", role: "user", text: "工作消息", at: new Date(startAt).toISOString() }] }),
    } as unknown as PluginConversationsService;
    expect(await readLifeDayMessages(service, startAt, endAt)).toEqual([
      { id: "2", role: "user", content: longText, at: startAt },
      { id: "4", role: "model", content: "较晚回复", at: startAt + 60_000 },
    ]);
  });

  it("将已有图片摘要随消息交给日记，纯图片消息也保留", async () => {
    const startAt = new Date(2026, 8, 1, 4).getTime();
    const endAt = new Date(2026, 8, 2, 2).getTime();
    const service = {
      list: async () => ({ items: [{ id: "a", mode: "chat" }] }),
      getMessages: async () => ({ items: [
        { id: "1", role: "user", text: "", at: new Date(startAt).toISOString(), images: [
          { name: "花瓶.png", caption: "窗边的蓝色花瓶与白花", summary: "窗边有蓝色花瓶" },
          { name: "旧照片.png", caption: "一张旧照片" },
        ] },
        { id: "2", role: "user", text: "", at: new Date(endAt).toISOString(), images: [
          { name: "区间外.png", caption: "区间外图片" },
        ] },
      ] }),
    } as unknown as PluginConversationsService;
    expect(await readLifeDayMessages(service, startAt, endAt)).toEqual([{
      id: "1", role: "user", content: "", at: startAt, images: [
        { name: "花瓶.png", summary: "窗边有蓝色花瓶" },
        { name: "旧照片.png", summary: "一张旧照片" },
      ],
    }]);
  });
});
