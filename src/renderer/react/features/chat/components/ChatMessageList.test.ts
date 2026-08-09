import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ant-design/x", () => ({
  Bubble: { List: () => null },
  CodeHighlighter: () => null,
  Think: () => null,
  ThoughtChain: () => null,
}));
vi.mock("@ant-design/x-markdown", () => ({ XMarkdown: ({ content }: { content?: string }) => content ?? null }));
vi.mock("@ant-design/x-markdown/plugins/Latex", () => ({ default: () => ({}) }));
vi.mock("../../../../../shared/renderer-base", () => ({ resolveAsset: (path: string) => path }));

import { createMessageItems, RunActivityDetail, type ChatMessageItem } from "./ChatMessageList";
import { extractMessageStickerId, stripMessageStickerMarkers } from "./message-sticker";

describe("React chat sticker messages", () => {
  it("extracts a persisted user sticker marker and hides the raw marker", () => {
    expect(extractMessageStickerId("[sticker:hugtight]")).toBe("hugtight");
    expect(stripMessageStickerMarkers("[sticker:hugtight]")).toBe("");
  });

  it("keeps user text while removing only its sticker marker", () => {
    expect(stripMessageStickerMarkers("给你一个 [sticker:hugtight]")).toBe("给你一个");
  });
});

describe("React Code run messages", () => {
  it("places a deterministic verification result in the assistant timeline", () => {
    const message = {
      id: "assistant-code-1",
      role: "assistant",
      content: "任务已完成。",
      responseStarted: true,
      codeRun: {
        run: null,
        approval: null,
        card: {
          runId: "run-1",
          status: "completed_verified",
          workspaceRoot: "C:\\repo",
          mutations: { created: [], modified: ["src/a.ts"], deleted: [], touchedPreExisting: [] },
          verification: { status: "passed", steps: [] },
          warnings: [],
        },
      },
    } as ChatMessageItem & { codeRun: unknown };

    const items = createMessageItems([message], []);

    expect(items.map((item) => item.role)).toContain("codeRun");
  });
});

describe("formal answer visibility", () => {
  it("keeps an interrupted run in the process area without creating an empty assistant bubble", () => {
    const message: ChatMessageItem = {
      id: "assistant-interrupted",
      role: "assistant",
      content: "",
      responseStarted: false,
      runActivity: { startedAt: 1, completedAt: 2, reasoningMs: 0, keepExpanded: true },
      processMessages: [{ id: "process-1", content: "已经检查了文件", afterToolCount: 0 }],
    };

    expect(createMessageItems([message], []).map((item) => item.role)).toEqual(["activity"]);
  });
});

describe("function-calling round presentation", () => {
  it("renders one collapsible activity group per model round with reasoning inside", () => {
    (globalThis as typeof globalThis & { React: typeof React }).React = React;
    const html = renderToStaticMarkup(React.createElement(RunActivityDetail, {
      agentRounds: [
        { id: "round-0", status: "completed", startedAt: 1, completedAt: 2 },
        { id: "round-1", status: "running", startedAt: 3 },
      ],
      processMessages: [
        { id: "process-0", roundId: "round-0", content: "先看项目结构" },
        { id: "process-1", roundId: "round-1", content: "继续检查取消链路" },
      ],
      reasoningBlocks: [{ id: "reason-1", roundId: "round-1", content: "查找 IPC 入口" }],
      tools: [
        { id: "tool-0", roundId: "round-0", name: "list_dir", status: "success" },
        { id: "tool-1", roundId: "round-1", name: "read_file", status: "running" },
      ],
      interrupted: false,
    }));

    expect(html.match(/class="cy-agent-round(?: is-(?:running|complete))?"/g)).toHaveLength(2);
    expect(html).toContain("昔涟已完成 · 浏览 1 个目录");
    expect(html).toContain("昔涟正在读取文件");
    expect(html).toContain("继续检查取消链路");
    expect(html).toContain("查找 IPC 入口");
  });

  it("does not render an empty final-answer round as a fake completed operation", () => {
    (globalThis as typeof globalThis & { React: typeof React }).React = React;
    const html = renderToStaticMarkup(React.createElement(RunActivityDetail, {
      agentRounds: [{ id: "round-final", status: "completed", startedAt: 1, completedAt: 2 }],
      processMessages: [],
      reasoningBlocks: [],
      tools: [],
      interrupted: false,
    }));
    expect(html).not.toContain("cy-agent-round");
  });
});
