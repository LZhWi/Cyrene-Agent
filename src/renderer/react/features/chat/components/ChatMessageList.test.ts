import { describe, expect, it, vi } from "vitest";

vi.mock("@ant-design/x", () => ({
  Bubble: { List: () => null },
  CodeHighlighter: () => null,
  Think: () => null,
  ThoughtChain: () => null,
}));
vi.mock("@ant-design/x-markdown", () => ({ XMarkdown: () => null }));
vi.mock("@ant-design/x-markdown/plugins/Latex", () => ({ default: () => ({}) }));
vi.mock("../../../../../shared/renderer-base", () => ({ resolveAsset: (path: string) => path }));

import { createMessageItems, type ChatMessageItem } from "./ChatMessageList";
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
