import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../shared/chat-types";
import { historyIndexText } from "./history-index-text";

describe("historyIndexText", () => {
  it("keeps the user-visible sticker description, not its raw marker or modelContext", () => {
    const message: ChatMessage = {
      id: "u1", role: "user", at: 1,
      content: "你好 [sticker:HI]", modelContext: "【图片视觉信息】临时描述",
      attachments: [
        { kind: "image", name: "photo.png", filePath: "photo.png", mime: "image/png", caption: "完整画面描述", status: "done" },
        { kind: "document", name: "notes.txt", filePath: "notes.txt", status: "done" },
      ],
    };
    expect(historyIndexText(message)).toBe("你好 （用户发送表情包：嗨，想我了吗）\n（用户发送了图片）\n（用户附加文档：notes.txt）");
  });

  it("indexes an attachment-only message and does not duplicate an inline sticker", () => {
    const message: ChatMessage = { id: "u2", role: "user", at: 2, content: "[sticker:HI]", sticker: "HI" };
    expect(historyIndexText(message)).toBe("（用户发送表情包：嗨，想我了吗）");
  });

  it("does not turn the assistant's sticker stage direction into user history", () => {
    const message: ChatMessage = { id: "a1", role: "model", at: 3, content: "好的 （我发送了表情包：开心） [sticker:HI]" };
    expect(historyIndexText(message)).toBe("好的");
  });
});
