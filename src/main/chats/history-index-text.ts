import type { ChatMessage } from "../../shared/chat-types";
import { describeMarkersForLlm, getStickerDescription } from "../channels/mobile-markers";

/** Stable history text from the saved message, never from per-run modelContext. */
export function historyIndexText(message: ChatMessage): string {
  const role = message.role === "user" ? "user" : "assistant";
  const parts = [describeMarkersForLlm(message.content, role).trim()];
  if (role === "user") {
    if (message.sticker && !message.content.includes(`[sticker:${message.sticker}]`)) {
      const description = getStickerDescription(message.sticker);
      parts.push(description ? `（用户发送表情包：${description}）` : "（用户发送表情包）");
    }
    if (!/\[image:[^\]]+\]/u.test(message.content)) {
      for (const attachment of message.attachments ?? []) {
        if (attachment.kind === "image") parts.push("（用户发送了图片）");
      }
    }
    for (const attachment of message.attachments ?? []) {
      if (attachment.kind === "document") parts.push(`（用户附加文档：${attachment.name}）`);
    }
  }
  return parts.filter(Boolean).join("\n").trim();
}
