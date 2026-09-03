import { describe, expect, it, vi } from "vitest";
import { createChatMessageNotifier } from "./chat-message-notifier";

function setup(overrides: Partial<Parameters<typeof createChatMessageNotifier>[0]> = {}) {
  let click: (() => void) | undefined;
  const show = vi.fn();
  const openChat = vi.fn();
  const createNotification = vi.fn(() => ({
    show,
    on: vi.fn((_event: "click", listener: () => void) => { click = listener; }),
  }));
  const notifier = createChatMessageNotifier({
    platform: "win32",
    isSupported: () => true,
    isChatFocused: () => false,
    createNotification,
    openChat,
    ...overrides,
  });
  return { notifier, createNotification, show, openChat, click: () => click?.() };
}

describe("chat message notifier", () => {
  it("shows one native notification and opens the matching chat when clicked", () => {
    const ctx = setup();
    expect(ctx.notifier.notify({ messageId: "m1", sessionId: "s1", text: " 新消息\n来了 " })).toBe(true);
    expect(ctx.createNotification).toHaveBeenCalledWith({ title: "昔涟", body: "新消息 来了" });
    expect(ctx.show).toHaveBeenCalledOnce();
    ctx.click();
    expect(ctx.openChat).toHaveBeenCalledWith("s1");
  });

  it("does not notify while the chat window is focused", () => {
    const ctx = setup({ isChatFocused: () => true });
    expect(ctx.notifier.notify({ messageId: "m1", text: "你好" })).toBe(false);
    expect(ctx.createNotification).not.toHaveBeenCalled();
  });

  it("deduplicates the same completed message", () => {
    const ctx = setup();
    expect(ctx.notifier.notify({ messageId: "m1", text: "你好" })).toBe(true);
    expect(ctx.notifier.notify({ messageId: "m1", text: "你好" })).toBe(false);
    expect(ctx.show).toHaveBeenCalledOnce();
  });

  it("ignores unsupported platforms and blank messages", () => {
    const unsupported = setup({ platform: "linux" });
    expect(unsupported.notifier.notify({ messageId: "m1", text: "你好" })).toBe(false);
    const blank = setup();
    expect(blank.notifier.notify({ messageId: "m2", text: "  " })).toBe(false);
  });

  it("does not throw when the native notification fails", () => {
    const warn = vi.fn();
    const ctx = setup({
      createNotification: () => { throw new Error("failed"); },
      warn,
    });
    expect(ctx.notifier.notify({ messageId: "m1", text: "你好" })).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });
});
