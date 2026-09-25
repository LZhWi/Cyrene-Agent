import type { ChatMessage } from "../../shared/chat-types";
import { BUILT_IN_STICKER_DESCRIPTIONS } from "../sticker-descriptions";
import { loadUserStickerManifest } from "../sticker-storage";

function stickerDescription(id: string): string {
  const builtIn = BUILT_IN_STICKER_DESCRIPTIONS[id];
  if (builtIn?.phrases.length) return builtIn.phrases.join("，");
  const custom = loadUserStickerManifest()[id];
  return custom ? (custom.phrases.length ? custom.phrases.join("，") : custom.description) : "";
}

/** Stable retrieval text; modelContext and full visual descriptions stay out of chat history. */
export function historyIndexText(message: ChatMessage): string {
  const user = message.role === "user";
  let content = message.content.replace(/\[sticker:([A-Za-z0-9_-]+)\]/gu, (_match, id: string) => {
    if (!user) return "";
    const description = stickerDescription(id);
    return description ? `（用户发送表情包：${description}）` : "（用户发送表情包）";
  }).replace(/\[image:[A-Za-z0-9_-]+\]/gu, user ? "（用户发送了图片）" : "");
  if (!user) {
    content = content
      .replace(/[（(]\s*(?:我|你|用户|对方|她)?\s*发送?了?\s*表情包(?:\s*[:：][^）)]*)?\s*[）)]/g, "")
      .replace(/[（(]\s*(?:我|你|用户|对方|她)?\s*发送?了?\s*图片\s*[）)]/g, "")
      .replace(/[ \t]{2,}/g, " ");
  }
  const parts = [content.trim()];
  if (user) {
    if (message.sticker && !message.content.includes(`[sticker:${message.sticker}]`)) {
      const description = stickerDescription(message.sticker);
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
