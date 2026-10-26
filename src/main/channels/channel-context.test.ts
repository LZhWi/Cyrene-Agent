import { describe, expect, it, vi } from "vitest";
import {
  createChannelContext,
  formatChannelUserText,
  lookupOriginalSender,
  makeSessionId,
} from "./channel-context";
import type { IncomingMessage } from "./types";

function makeIncoming(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    channel: "qq",
    chatType: "private",
    senderId: "user-1",
    senderName: "测试用户",
    chatId: "chat-1",
    text: "你好",
    at: new Date(0),
    ...overrides,
  };
}

describe("渠道上下文", () => {
  it('统一日志提交后不再双写，失败时不回落到非原子写入',async()=>{
    const appendJournal=vi.fn().mockResolvedValue(true),appendChannelHistory=vi.fn(),appendBoundConversationMessage=vi.fn();
    const context=createChannelContext({appendJournal,appendChannelHistory,appendBoundConversationMessage,migrateHistory:vi.fn()});
    const message=makeIncoming({chatType:'group',messageId:'m'}),snapshot={sessionId:'channel',boundConversationId:'desktop'};
    await context.appendIncomingContext(message,snapshot);
    expect(appendJournal).toHaveBeenCalledWith('channel','desktop','user',message.text,expect.objectContaining({modelContext:formatChannelUserText(message)}));
    expect(appendChannelHistory).not.toHaveBeenCalled();expect(appendBoundConversationMessage).not.toHaveBeenCalled();
    appendJournal.mockRejectedValueOnce(Error('transaction failed'));
    await expect(context.appendIncomingContext(message,snapshot)).rejects.toThrow('transaction failed');
    expect(appendChannelHistory).not.toHaveBeenCalled();
  });
  it("为同一渠道会话生成稳定标识", () => {
    expect(makeSessionId("feishu", "ou_abc123"))
      .toBe(makeSessionId("feishu", "ou_abc123"));
  });

  it("隔离不同渠道和不同聊天", () => {
    expect(makeSessionId("feishu", "user-x"))
      .not.toBe(makeSessionId("wechat", "user-x"));
    expect(makeSessionId("qq", "10001"))
      .not.toBe(makeSessionId("qq", "10002"));
  });

  it("生成带渠道前缀和 16 位摘要的标识", () => {
    expect(makeSessionId("feishu", "ou_abc"))
      .toMatch(/^channel:feishu:[0-9a-f]{16}$/);
  });

  it("未知会话无法反查发送者", () => {
    expect(lookupOriginalSender("channel:feishu:0000000000000000")).toBeNull();
  });

  it("群聊文本保留发送者和引用上下文", () => {
    expect(formatChannelUserText(makeIncoming({
      chatType: "group",
      senderId: "10001",
      senderName: "小明",
      chatId: "20001",
      text: "你好",
      reply: {
        messageId: "message-1",
        senderId: "10002",
        senderName: "小红",
        text: "前一条消息",
      },
    }))).toBe("[群聊发送者：小明 (10001)]\n引用 小红：前一条消息\n你好");
  });

  it("记录会话时迁移旧发送者键并支持反查", () => {
    const migrateHistory = vi.fn();
    const context = createChannelContext({
      appendChannelHistory: vi.fn(),
      migrateHistory,
    });
    const msg = makeIncoming({
      channel: "feishu",
      senderId: "ou_sender",
      chatId: "oc_chat",
    });
    const sessionId = makeSessionId(msg.channel, msg.chatId);

    context.recordIncomingSession(msg, { sessionId, boundConversationId: null });

    expect(migrateHistory).toHaveBeenCalledWith(
      makeSessionId("feishu", "ou_sender"),
      sessionId,
    );
    expect(lookupOriginalSender(sessionId)).toEqual({
      channel: "feishu",
      senderId: "ou_sender",
    });
  });

  it("绑定历史读取失败时回退到渠道历史", async () => {
    const context = createChannelContext({
      loadBoundConversationHistory: async () => {
        throw new Error("桌面对话已删除");
      },
      loadRecentChannelHistory: async () => [
        { role: "user", content: "渠道历史" },
      ],
      appendChannelHistory: vi.fn(),
      migrateHistory: vi.fn(),
    });

    await expect(context.resolvePriorMessages({
      sessionId: "channel:qq:abc",
      boundConversationId: "conversation-1",
    }, 16)).resolves.toEqual([
      { role: "user", content: "渠道历史" },
    ]);
  });

  it("历史读取只使用已经解析的绑定快照", async () => {
    const resolveBoundConversationId = vi.fn(() => "conversation-new");
    const loadBoundConversationHistory = vi.fn(async () => [
      { role: "assistant" as const, content: "桌面历史" },
    ]);
    const context = createChannelContext({
      resolveBoundConversationId,
      loadBoundConversationHistory,
      appendChannelHistory: vi.fn(),
      migrateHistory: vi.fn(),
    });

    const dispatchContext = context.resolveDispatchContext("channel:qq:abc");
    await context.resolvePriorMessages(dispatchContext, 16);

    expect(resolveBoundConversationId).toHaveBeenCalledOnce();
    expect(loadBoundConversationHistory)
      .toHaveBeenCalledWith("conversation-new", 16);
  });

  it("入站上下文始终写渠道历史，并将群聊原文镜像到绑定会话", async () => {
    const appendChannelHistory = vi.fn();
    const appendBoundConversationMessage = vi.fn();
    const context = createChannelContext({
      appendChannelHistory,
      appendBoundConversationMessage,
      migrateHistory: vi.fn(),
    });
    const msg = makeIncoming({
      chatType: "group",
      senderId: "10001",
      senderName: "小明",
      chatId: "20001",
      text: "大家好",
    });
    const dispatchContext = {
      sessionId: makeSessionId("qq", "20001"),
      boundConversationId: "conversation-group",
    };

    await context.appendIncomingContext(msg, dispatchContext);

    expect(appendChannelHistory).toHaveBeenCalledWith(
      dispatchContext.sessionId,
      "user",
      "[群聊发送者：小明 (10001)]\n大家好",
    );
    expect(appendBoundConversationMessage).toHaveBeenCalledWith(
      "conversation-group",
      "user",
      "大家好",
      {
        channel: "qq",
        chatType: "group",
        senderName: "小明",
        modelContext: "[群聊发送者：小明 (10001)]\n大家好",
      },
    );
  });

  it("助手上下文写入渠道历史和绑定会话，并保留已发送表情", async () => {
    const appendChannelHistory = vi.fn();
    const appendBoundConversationMessage = vi.fn();
    const context = createChannelContext({
      appendChannelHistory,
      appendBoundConversationMessage,
      migrateHistory: vi.fn(),
    });
    const msg = makeIncoming({ channel: "wechat" });
    const dispatchContext = {
      sessionId: makeSessionId("wechat", "chat-1"),
      boundConversationId: "conversation-1",
    };

    await context.appendAssistantContext(msg, dispatchContext, {
      message: {
        channel: "wechat",
        targetId: "chat-1",
        parts: [{ kind: "text", text: "收到" }],
      },
      assistantText: "收到",
      stickerId: "OK",
      transientFiles: [],
    });

    expect(appendChannelHistory).toHaveBeenCalledWith(
      dispatchContext.sessionId,
      "assistant",
      "收到",
    );
    expect(appendBoundConversationMessage).toHaveBeenCalledWith(
      "conversation-1",
      "assistant",
      "收到",
      {
        channel: "wechat",
        chatType: "private",
        senderName: "测试用户",
        modelContext: undefined,
        sticker: "OK",
      },
    );
  });
});
