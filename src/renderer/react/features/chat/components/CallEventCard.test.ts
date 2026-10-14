import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CallEventCard } from "./CallEventCard";
import { MusicEventCard } from "./MusicEventCard";
import { resolveRevisableLastTurn } from "./last-turn-actions";
import { toUiMessages } from "../pages/chat-page-normalizers";
import { createMessageItems } from "./ChatMessageList";
vi.mock("@ant-design/x", () => ({ Bubble: {}, CodeHighlighter: () => null, Think: () => null, ThoughtChain: () => null }));
vi.mock("@ant-design/x-markdown", () => ({ XMarkdown: () => null }));
vi.mock("@ant-design/x-markdown/plugins/Latex", () => ({ default: () => ({}) }));

describe("imported call event", () => {
  it("renders persisted listening events as collapsed track lists", () => {
    vi.stubGlobal("React", { createElement });
    const musicEvent = { startedAt: 1, tracks: [{ id: "a", name: "Song A", artists: ["Artist"], playedAt: 2 }] };
    const messages = toUiMessages({ id: "chat", title: "Chat", identityId: null, mode: "chat", schemaVersion: 1, createdAt: 1, updatedAt: 2,
      messages: [{ id: "music", role: "user", content: "", at: 2, musicEvent }] });
    const [item] = createMessageItems(messages, [], "chat");
    expect(item.extraInfo.musicEvent).toEqual(musicEvent);
    expect(resolveRevisableLastTurn([...messages, { id: "reply", role: "assistant", content: "hello" }], "chat")).toBeNull();
    const html = renderToStaticMarkup(createElement(MusicEventCard, { event: item.extraInfo.musicEvent }));
    expect(html).toContain("听歌记录"); expect(html).toContain("Song A"); expect(html).toContain("Artist");
    expect(html).not.toContain("open=");
  });
  it("carries an empty-content call through hydration and bubble creation", () => {
    vi.stubGlobal("React", { createElement });
    const callEvent = { callId: "call-1", startedAt: 1, endedAt: 120001, summary: "<script>private summary</script>" };
    const messages = toUiMessages({ id: "chat", title: "Chat", identityId: null, mode: "chat", schemaVersion: 1, createdAt: 1, updatedAt: 2,
      messages: [{ id: "call", role: "user", content: "", at: 2, callEvent }] });
    const items = createMessageItems(messages, [], "chat");
    expect(items).toHaveLength(1);
    expect(items[0].extraInfo.callEvent).toEqual(callEvent);
    const html = renderToStaticMarkup(createElement(CallEventCard, { event: items[0].extraInfo.callEvent }));
    expect(html).toContain("持续约 2 分钟");
    expect(html).toContain("<details>");
    expect(html).not.toContain("<script>");
  });
});

vi.mock("../../../../../shared/renderer-base", () => ({ resolveAsset: (path: string) => path }));
