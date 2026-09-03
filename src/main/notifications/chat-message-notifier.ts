export interface ChatMessageNotificationInput {
  messageId: string;
  sessionId?: string;
  text: string;
}

interface NativeNotificationLike {
  show(): void;
  on(event: "click", listener: () => void): unknown;
}

interface ChatMessageNotifierDeps {
  platform: NodeJS.Platform;
  isSupported: () => boolean;
  isChatFocused: () => boolean;
  createNotification: (options: { title: string; body: string }) => NativeNotificationLike;
  openChat: (sessionId?: string) => void;
  warn?: (message: string, error: unknown) => void;
}

const MAX_PREVIEW_CHARS = 80;
const MAX_REMEMBERED_MESSAGE_IDS = 256;

function parseInput(value: unknown): ChatMessageNotificationInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<ChatMessageNotificationInput>;
  const messageId = typeof input.messageId === "string" ? input.messageId.trim() : "";
  const text = typeof input.text === "string" ? input.text.replace(/\s+/g, " ").trim() : "";
  if (!messageId || !text) return null;
  return {
    messageId,
    text,
    sessionId: typeof input.sessionId === "string" && input.sessionId.trim()
      ? input.sessionId.trim()
      : undefined,
  };
}

export function createChatMessageNotifier(deps: ChatMessageNotifierDeps) {
  const notifiedIds = new Set<string>();

  function notify(value: unknown): boolean {
    const input = parseInput(value);
    if (!input || deps.platform !== "win32" || !deps.isSupported() || deps.isChatFocused()) return false;
    if (notifiedIds.has(input.messageId)) return false;

    const body = input.text.length > MAX_PREVIEW_CHARS
      ? input.text.slice(0, MAX_PREVIEW_CHARS) + "…"
      : input.text;
    try {
      const notification = deps.createNotification({ title: "昔涟", body });
      notification.on("click", () => deps.openChat(input.sessionId));
      notification.show();
      notifiedIds.add(input.messageId);
      if (notifiedIds.size > MAX_REMEMBERED_MESSAGE_IDS) {
        const oldest = notifiedIds.values().next().value;
        if (oldest) notifiedIds.delete(oldest);
      }
      return true;
    } catch (error) {
      deps.warn?.("发送 Windows 消息通知失败", error);
      return false;
    }
  }

  return { notify };
}
