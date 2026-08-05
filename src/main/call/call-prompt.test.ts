import { describe, expect, it } from "vitest";
import {
  buildCallConversation,
  buildCallMessages,
  findLatestChatContextSessionId,
  trimSoulForCall,
} from "./call-prompt";

describe("buildCallMessages", () => {
  it("places tone-anchor after call history and the current user message", () => {
    const messages = buildCallMessages(
      { system: "PHONE_SYSTEM", tailAnchor: "TONE_ANCHOR" },
      [
        { role: "user", content: "上一问" },
        { role: "assistant", content: "上一答" },
      ],
      "当前问题",
    );

    expect(messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      "system:PHONE_SYSTEM",
      "user:上一问",
      "assistant:上一答",
      "user:当前问题",
      "system:TONE_ANCHOR",
    ]);
  });

  it("does not add an empty tail system message", () => {
    const messages = buildCallMessages({ system: "PHONE_SYSTEM" }, [], "你好");
    expect(messages).toHaveLength(2);
    expect(messages.at(-1)?.role).toBe("user");
  });
});

describe("Phone-only prompt helpers", () => {
  it("builds a conversation without injecting a system message", () => {
    expect(buildCallConversation([{ role: "assistant", content: "上一答" }], "当前问题"))
      .toEqual([
        { role: "assistant", content: "上一答" },
        { role: "user", content: "当前问题" },
      ]);
  });

  it("removes the chat-only Live2D section from the Phone soul", () => {
    expect(trimSoulForCall("共同人格\n\n## Live2D 与聊天文字的分工\n聊天专用规则"))
      .toBe("共同人格");
  });
});

describe("findLatestChatContextSessionId", () => {
  it("uses the latest Chat/Collab/Proactive session", () => {
    expect(findLatestChatContextSessionId([
      { id: "proactive", updatedAt: 300, purpose: "proactive-chat" },
      { id: "older", updatedAt: 100 },
      { id: "latest", updatedAt: 200 },
    ])).toBe("proactive");
  });
});
