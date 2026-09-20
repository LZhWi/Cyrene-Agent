import { normalizeMobileMessageSegmentationMode, type MobileMessageSegmentationMode } from "../../shared/preferences";
import { splitTextBySentenceBreaks } from "../../shared/message-segmentation";
import type { ChannelManager } from "./manager";
import { appendHistory as appendChannelHistory } from "./history-log";
import { appendLog as appendChannelLog, type LogEntry } from "./message-log";
import type { ChannelId, IncomingMessage, OutgoingMessage } from "./types";
import { loadWechatRecipient, rememberWechatRecipientSession } from "./adapters/wechat/recipient-store";

export type ProactiveMobileChannel = Extract<ChannelId, "wechat" | "feishu">;

export interface RecentProactiveChannelRecipient {
  targetId: string;
  threadId?: string;
  sessionId: string;
  updatedAt: number;
}

export interface ProactiveChannelRecipientRegistry {
  remember(message: IncomingMessage, sessionId: string): void;
  get(channel: ProactiveMobileChannel): RecentProactiveChannelRecipient | null;
}

interface ProactiveChannelRecipientRegistryOptions {
  loadWechat?: () => RecentProactiveChannelRecipient | null;
  persistWechat?: (recipient: RecentProactiveChannelRecipient) => void;
}

export function createProactiveChannelRecipientRegistry(
  options: ProactiveChannelRecipientRegistryOptions = {},
): ProactiveChannelRecipientRegistry {
  const recipients = new Map<ProactiveMobileChannel, RecentProactiveChannelRecipient>();
  let loadedWechat = false;
  const ensureWechatLoaded = (): void => {
    if (loadedWechat && recipients.has("wechat")) return;
    loadedWechat = true;
    const saved = options.loadWechat?.();
    if (saved) recipients.set("wechat", saved);
  };
  return {
    remember(message, sessionId): void {
      if (message.channel === "wechat") ensureWechatLoaded();
      const targetId = message.chatId.trim();
      if (!targetId || !sessionId) return;
      const recipient = {
        targetId,
        ...(message.threadId ? { threadId: message.threadId } : {}),
        sessionId,
        updatedAt: message.at.getTime(),
      };
      recipients.set(message.channel, recipient);
      if (message.channel === "wechat") options.persistWechat?.(recipient);
    },
    get(channel): RecentProactiveChannelRecipient | null {
      if (channel === "wechat") ensureWechatLoaded();
      return recipients.get(channel) ?? null;
    },
  };
}

const defaultRecipientRegistry = createProactiveChannelRecipientRegistry({
  loadWechat: () => {
    const saved = loadWechatRecipient();
    if (!saved) return null;
    return {
      targetId: saved.targetId,
      // 微信实际历史写入 proactive-chat；旧 channel sessionId 仅为接口兼容字段。
      sessionId: saved.sessionId ?? "desktop:proactive-chat",
      updatedAt: saved.updatedAt,
    };
  },
  persistWechat: (recipient) => {
    rememberWechatRecipientSession(recipient);
  },
});

export function rememberProactiveChannelRecipient(message: IncomingMessage, sessionId: string): void {
  defaultRecipientRegistry.remember(message, sessionId);
}

export function canStartProactiveChannelDelivery(
  channel: ProactiveMobileChannel,
  manager: Pick<ChannelManager, "getAdapter">,
  recipientRegistry: ProactiveChannelRecipientRegistry = defaultRecipientRegistry,
): boolean {
  const adapter = manager.getAdapter(channel);
  return adapter?.getStatus().phase === "running" && recipientRegistry.get(channel) !== null;
}

export type ProactiveChannelDeliveryResult =
  | { kind: "committed"; deliveredParts: number; totalParts: number }
  | { kind: "cancelled"; reason: string };

interface ProactiveChannelDeliveryInput {
  channel: ProactiveMobileChannel;
  text: string;
  mobileMessageSegmentation: MobileMessageSegmentationMode;
  manager: Pick<ChannelManager, "getAdapter">;
  recipientRegistry?: ProactiveChannelRecipientRegistry;
  appendHistory?: typeof appendChannelHistory;
  appendLog?: (entry: Omit<LogEntry, "at">) => void;
  canContinue?: () => boolean;
}

export async function sendProactiveChannelMessage(
  input: ProactiveChannelDeliveryInput,
): Promise<ProactiveChannelDeliveryResult> {
  const adapter = input.manager.getAdapter(input.channel);
  if (!adapter || adapter.getStatus().phase !== "running") {
    return { kind: "cancelled", reason: "channel_offline" };
  }

  const recipient = (input.recipientRegistry ?? defaultRecipientRegistry).get(input.channel);
  if (!recipient) return { kind: "cancelled", reason: "recipient_unavailable" };

  const mode = normalizeMobileMessageSegmentationMode(input.mobileMessageSegmentation);
  const texts = mode === "on" ? splitTextBySentenceBreaks(input.text) : [input.text.trim()].filter(Boolean);
  if (texts.length === 0) return { kind: "cancelled", reason: "empty_text" };

  const deliveredTexts: string[] = [];
  for (const text of texts) {
    if (input.canContinue && !input.canContinue()) break;
    if (adapter.getStatus().phase !== "running") break;
    const message: OutgoingMessage = {
      channel: input.channel,
      targetId: recipient.targetId,
      ...(recipient.threadId ? { threadId: recipient.threadId } : {}),
      parts: [{ kind: "text", text }],
    };
    try {
      const result = await adapter.send(message);
      if (!result.ok) break;
      deliveredTexts.push(text);
    } catch {
      break;
    }
  }

  if (deliveredTexts.length === 0) return { kind: "cancelled", reason: "send_failed" };

  const deliveredText = deliveredTexts.join("");
  (input.appendHistory ?? appendChannelHistory)(recipient.sessionId, "assistant", deliveredText);
  (input.appendLog ?? appendChannelLog)({
    dir: "outgoing",
    channel: input.channel,
    senderId: recipient.targetId,
    chatId: recipient.targetId,
    text: deliveredText,
    hasAttachments: false,
  });

  return {
    kind: "committed",
    deliveredParts: deliveredTexts.length,
    totalParts: texts.length,
  };
}
