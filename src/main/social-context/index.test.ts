import { describe, expect, it } from "vitest";
import { buildSocialContextBlock, type SocialAtom } from "./index";

function atom(id: string, type: SocialAtom["type"], content: string): SocialAtom {
  return {
    id, conversationId: "session", type, content, evidenceTurnId: "turn",
    evidenceQuote: content, createdAt: 1, updatedAt: 1, expiresAt: 2, status: "active",
  };
}

describe("social context injection", () => {
  it("groups only short-term state and open loops without changing chat history", () => {
    const first = atom("1", "short_term", "用户这周在准备考试");
    const second = atom("2", "open_loop", "等用户考完后继续聊结果");
    first.createdAt = Date.UTC(2026, 7, 4, 4, 30);
    second.createdAt = Date.UTC(2026, 7, 4, 5, 45);
    const block = buildSocialContextBlock([first, second], "Asia/Shanghai");

    expect(block).toContain("近期状态：\n- [形成于 2026-08-04 12:30, Asia/Shanghai] 用户这周在准备考试");
    expect(block).toContain("尚未接上的话题：\n- [形成于 2026-08-04 13:45, Asia/Shanghai] 等用户考完后继续聊结果");
    expect(block).toContain("不要声称自己拥有额外记忆能力");
  });

  it("returns no model-visible text when nothing is relevant", () => {
    expect(buildSocialContextBlock([])).toBe("");
  });
});
