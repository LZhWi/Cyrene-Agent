// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const listRender = vi.hoisted(() => vi.fn());

vi.mock("@ant-design/x", async () => {
  const React = await import("react");
  return {
    Bubble: { List: (props: { items: Array<{ key: string }> }) => {
      listRender(props);
      return React.createElement("div", { className: "ant-bubble-list-scroll-box" },
        React.createElement("div", { className: "ant-bubble-list-scroll-content" },
          props.items.map((item) => React.createElement("div", { key: item.key }))));
    } },
    CodeHighlighter: () => null,
    Think: ({ children }: { children?: React.ReactNode }) => React.createElement("div", null, children),
    ThoughtChain: () => null,
  };
});
vi.mock("@ant-design/x-markdown", () => ({ XMarkdown: ({ content }: { content?: string }) => content ?? null }));
vi.mock("@ant-design/x-markdown/plugins/Latex", () => ({ default: () => ({}) }));
vi.mock("../../../../../shared/renderer-base", () => ({ resolveAsset: (path: string) => path }));

import { ChatMessageList, type ChatMessageItem } from "./ChatMessageList";

afterEach(() => {
  listRender.mockClear();
});

describe("Chat message rendering", () => {
  it("renders recent Chat messages first and loads older messages only when they enter view", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("React", { createElement });
    const scrollCalls: Array<{ element: Element; top: number }> = [];
    HTMLElement.prototype.scrollTo = function (options: ScrollToOptions) {
      scrollCalls.push({ element: this, top: options.top ?? 0 });
    };
    let showFirstBubble: (() => void) | undefined;
    let observerRoot: Element | Document | null | undefined;
    class MockIntersectionObserver {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        observerRoot = options?.root;
        showFirstBubble = () => callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const messages: ChatMessageItem[] = Array.from({ length: 101 }, (_, index) => ({
      id: `message-${index}`, role: "user", content: `消息 ${index}`,
    }));
    const render = (items: ChatMessageItem[], conversationId = "session", mode: "chat" | "work" = "chat") => {
      act(() => root.render(createElement(ChatMessageList, {
        messages: items,
        conversationId,
        mode,
        preferredAddress: "",
      })));
    };

    render(messages);
    expect((listRender.mock.lastCall?.[0] as { items: unknown[] }).items).toHaveLength(40);
    expect(showFirstBubble).toBeDefined();
    const outer = host.querySelector<HTMLDivElement>(".cy-message-list")!;
    const scrollBox = host.querySelector<HTMLDivElement>(".ant-bubble-list-scroll-box")!;
    expect(scrollCalls.some((call) => call.element === outer)).toBe(true);
    expect(scrollCalls.some((call) => call.element === scrollBox && call.top === 0)).toBe(true);
    expect(observerRoot).toBe(outer);
    Object.defineProperty(outer, "scrollHeight", { value: 1000 });
    Object.defineProperty(outer, "clientHeight", { value: 400 });
    outer.scrollTop = 600;
    act(() => showFirstBubble?.());
    expect((listRender.mock.lastCall?.[0] as { items: unknown[] }).items).toHaveLength(40);
    outer.scrollTop = 0;
    act(() => showFirstBubble?.());
    expect((listRender.mock.lastCall?.[0] as { items: unknown[] }).items).toHaveLength(80);

    render([...messages, { id: "new", role: "assistant", content: "新消息" }]);
    expect((listRender.mock.lastCall?.[0] as { items: unknown[] }).items).toHaveLength(81);

    render(messages.slice(0, 90), "another-session");
    expect((listRender.mock.lastCall?.[0] as { items: unknown[] }).items).toHaveLength(40);
    expect(scrollCalls.some((call) => call.element === outer && call.top === 1000)).toBe(true);
    Object.defineProperty(scrollBox, "scrollHeight", { value: 1000 });
    Object.defineProperty(scrollBox, "clientHeight", { value: 400 });
    render(messages);
    expect((listRender.mock.lastCall?.[0] as { items: unknown[] }).items).toHaveLength(40);
    expect(observerRoot).toBe(scrollBox);
    scrollBox.scrollTop = -600;
    act(() => showFirstBubble?.());
    expect((listRender.mock.lastCall?.[0] as { items: unknown[] }).items).toHaveLength(80);
    render(messages, "work-session", "work");
    expect((listRender.mock.lastCall?.[0] as { items: unknown[] }).items).toHaveLength(101);

    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("keeps history mounted across unrelated parent renders and reuses unchanged messages during streaming", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("React", { createElement });
    HTMLElement.prototype.scrollTo = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const messages: ChatMessageItem[] = [
      { id: "first", role: "user", content: "你好" },
      { id: "second", role: "assistant", content: "第一段" },
    ];
    const render = (items: ChatMessageItem[], onDeleteMessage: (id: string) => Promise<boolean>) => {
      act(() => root.render(createElement(ChatMessageList, {
        messages: items,
        conversationId: "session",
        mode: "chat",
        preferredAddress: "",
        onDeleteMessage,
      })));
    };

    render(messages, async () => true);
    const initialCount = listRender.mock.calls.length;
    const initialItems = (listRender.mock.lastCall?.[0] as { items: unknown[] }).items;
    const latestDelete = vi.fn(async () => false);
    render(messages, latestDelete);
    expect(listRender).toHaveBeenCalledTimes(initialCount);
    type FooterAction = { props?: { onDelete?: (id: string) => Promise<boolean> } };
    type Footer = (content: string, info: { extraInfo: { messageId: string } }) => { props: { children: FooterAction[] } };
    const roles = (listRender.mock.lastCall?.[0] as { role: { user: { footer: Footer } } }).role;
    const actions = roles.user.footer("你好", { extraInfo: { messageId: "first" } });
    const deleteAction = actions.props.children.find((child) => child?.props?.onDelete);
    await deleteAction?.props?.onDelete?.("first");
    expect(latestDelete).toHaveBeenCalledWith("first");

    render([messages[0], { ...messages[1], content: "第一段，继续" }], async () => false);
    expect(listRender).toHaveBeenCalledTimes(initialCount + 1);
    const updatedItems = (listRender.mock.lastCall?.[0] as { items: unknown[] }).items;
    expect(updatedItems[0]).toBe(initialItems[0]);
    expect(updatedItems[1]).not.toBe(initialItems[1]);

    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
});
