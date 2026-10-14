// @vitest-environment jsdom
// Use the real virtualizer; only the heavy bubble renderer is replaced.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BubbleItemType } from "@ant-design/x";

vi.mock("@ant-design/x", async () => {
  const React = await import("react");
  return { Bubble: { List: ({ items, role, autoScroll }: {
    items: BubbleItemType[]; role: unknown; autoScroll: boolean;
  }) => React.createElement("div", { "data-key": items[0].key, "data-autoscroll": String(autoScroll) },
    role ? String(items[0].content) : "missing roles") } };
});
import { VirtualChatMessageList } from "./VirtualChatMessageList";

let root: Root;
let host: HTMLDivElement;
let scroll: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("React", { createElement });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function () {
    return this.classList.contains("cy-message-list__virtual-row") ? 160 : 480;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  HTMLElement.prototype.scrollTo = vi.fn();
  scroll = document.createElement("div");
  host = document.createElement("div");
  scroll.appendChild(host);
  document.body.appendChild(scroll);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  scroll.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("VirtualChatMessageList", () => {
  it("mounts only the viewport plus overscan and reaches distant rows using the real virtualizer", () => {
    const items: BubbleItemType[] = Array.from({ length: 1000 }, (_, index) => ({
      key: `message-${index}`, role: "assistant", content: `内容${index}`,
    }));
    const roles = { assistant: { placement: "start" as const } };
    act(() => root.render(createElement(VirtualChatMessageList, {
      items, roles, scrollRef: { current: scroll }, nearBottomRef: { current: false }, layoutKey: "work",
    })));
    expect(host.querySelectorAll(".cy-message-list__virtual-row").length).toBeGreaterThan(0);
    expect(host.querySelectorAll(".cy-message-list__virtual-row").length).toBeLessThan(25);
    expect(host.textContent).toContain("内容0");
    expect(host.textContent).not.toContain("missing roles");
    act(() => {
      scroll.scrollTop = 160 * 500;
      scroll.dispatchEvent(new Event("scroll"));
    });
    expect(host.querySelectorAll(".cy-message-list__virtual-row").length).toBeLessThan(25);
    expect(host.querySelector('[data-key="message-500"]')).not.toBeNull();
    expect(host.querySelector('[data-key="message-0"]')).toBeNull();
    expect(host.querySelector('[data-autoscroll="false"]')).not.toBeNull();
  });

  it("preserves a user's history position during streaming, and follows growth only when near the bottom", () => {
    const nearBottomRef = { current: false };
    const scrollRef = { current: scroll };
    const roles = { assistant: { placement: "start" as const } };
    const render = (content: string) => act(() => root.render(createElement(VirtualChatMessageList, {
      items: [{ key: "assistant", role: "assistant", content }], roles, scrollRef, nearBottomRef, layoutKey: "work",
    })));
    Object.defineProperty(scroll, "scrollHeight", { value: 3000, configurable: true });
    scroll.scrollTop = 200;
    render("开始");
    render("继续生成");
    expect(scroll.scrollTop).toBe(200);
    nearBottomRef.current = true;
    render("完成");
    expect(scroll.scrollTop).toBe(3000);
  });
});
