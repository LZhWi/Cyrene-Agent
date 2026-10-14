import type { PluginConversationsService } from "@playa0v0/cyrene-plugin-sdk";

/** 按本地日程边界读取 Chat 消息的文字与已有图片描述。 */
export async function readLifeDayMessages(conversations: PluginConversationsService, startAt: number, endAt: number) {
  const messages: Array<{ id: string; role: "user" | "model"; content: string; at: number;
    images?: Array<{ name: string; summary: string }> }> = [];
  let listCursor: string | undefined;
  do {
    const sessions = await conversations.list({ cursor: listCursor, limit: 100 });
    for (const session of sessions.items.filter((item) => item.mode === "chat")) {
      let cursor: string | undefined;
      do {
        const page = await conversations.getMessages({ conversationId: session.id, cursor, limit: 100 });
        for (const message of page.items) {
          const at = Date.parse(message.at);
          const images = (message as typeof message & { images?: Array<{ name: string; caption: string; summary?: string }> })
            .images?.flatMap((image) => {
              const summary = image.summary?.trim() || image.caption.trim();
              return summary ? [{ name: image.name, summary }] : [];
            }) ?? [];
          if (at >= startAt && at < endAt && (message.text.trim() || images.length)) messages.push({
            id: message.id, role: message.role === "assistant" ? "model" : "user", content: message.text, at,
            ...(images.length ? { images } : {}),
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    listCursor = sessions.nextCursor;
  } while (listCursor);
  return messages.sort((a, b) => a.at - b.at);
}
