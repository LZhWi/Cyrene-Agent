import { describe, expect, it, vi } from "vitest";
import { ILinkBotAdapter } from "./ilink-bot-adapter";
import type { OutgoingMessage } from "../../types";

vi.mock("electron", () => ({
  app: {
    getPath: () => "C:/tmp/cyrene-test-user-data",
  },
}));

function message(parts: OutgoingMessage["parts"]): OutgoingMessage {
  return {
    channel: "wechat",
    targetId: "wx-user-1",
    parts,
  };
}

describe("ILinkBotAdapter.send", () => {
  it("sends text replies through the protocol client with the cached context token", async () => {
    const adapter = new ILinkBotAdapter();
    const sendText = vi.fn(async () => ({ ok: true }));
    (adapter as any).client = { sendText };
    (adapter as any).replyContextByTarget.set("wx-user-1", "ctx-1");

    const result = await adapter.send(message([{ kind: "text", text: "你好" }]));

    expect(result).toEqual({ ok: true });
    expect(sendText).toHaveBeenCalledWith("wx-user-1", "你好", "ctx-1");
  });
});
