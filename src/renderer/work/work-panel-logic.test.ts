import { describe, expect, it, vi } from "vitest";
import {
  attachmentKindLabel,
  emptyStateCopyFor,
  formatTime,
  planStepLabel,
  prepareRunAttachments,
  sessionHintFor,
  sessionModeBadge,
  sessionsForMode,
  type PendingAttachment,
} from "./work-panel-logic";
import type { WorkSession } from "../../shared/work-types";

const baseSession: WorkSession = {
  schemaVersion: 1,
  id: "s1",
  title: "会话",
  mode: "work",
  status: "idle",
  createdAt: 0,
  updatedAt: 0,
  messages: [],
  artifacts: [],
};

describe("work-panel-logic", () => {
  it("formatTime renders zh-CN month/day hour:minute", () => {
    expect(formatTime(new Date(2026, 6, 19, 14, 5).getTime())).toContain("14:05");
  });

  it("planStepLabel maps every step status", () => {
    expect(planStepLabel("completed")).toBe("完成");
    expect(planStepLabel("running")).toBe("进行中");
    expect(planStepLabel("failed")).toBe("失败");
    expect(planStepLabel("pending")).toBe("待处理");
  });

  it("attachmentKindLabel covers all three kinds", () => {
    expect(attachmentKindLabel("image")).toBe("图片");
    expect(attachmentKindLabel("document")).toBe("文档");
    expect(attachmentKindLabel("unsupported")).toBe("不支持");
  });

  it("sessionModeBadge only returns badges for code/learn", () => {
    expect(sessionModeBadge("code")).toEqual({ icon: "💻", title: "Code 模式" });
    expect(sessionModeBadge("learn")).toEqual({ icon: "📖", title: "Learn 模式" });
    expect(sessionModeBadge("work")).toBeNull();
    expect(sessionModeBadge(undefined)).toBeNull();
  });

  it("sessionHintFor shows bound dir status for code/learn and isolation note for work", () => {
    const bound = sessionHintFor({ ...baseSession, mode: "code", boundDir: "D:\\repo" });
    expect(bound.text).toBe("💻 Code 模式 · 只读 · 绑定：D:\\repo");
    expect(bound.title).toBe("D:\\repo");

    const unbound = sessionHintFor({ ...baseSession, mode: "learn" });
    expect(unbound.text).toContain("未绑定目录（文件工具不可用）");

    const work = sessionHintFor(baseSession);
    expect(work.text).toBe("独立历史 · 独立记忆 · 严格工作流");
    expect(work.title).toBe("");
  });

  it("sessionsForMode filters by mode, treating missing mode as work", () => {
    const list = [
      { id: "a" },
      { id: "b", mode: "work" },
      { id: "c", mode: "code" },
      { id: "d", mode: "learn" },
    ];
    expect(sessionsForMode(list, "work").map((s) => s.id)).toEqual(["a", "b"]);
    expect(sessionsForMode(list, "code").map((s) => s.id)).toEqual(["c"]);
    expect(sessionsForMode(list, "learn").map((s) => s.id)).toEqual(["d"]);
  });

  it("emptyStateCopyFor returns mode-specific copy", () => {
    expect(emptyStateCopyFor("work").title).toBe("开始一项独立工作");
    expect(emptyStateCopyFor("code").title).toBe("开始一项代码工作");
    expect(emptyStateCopyFor("code").detail).toContain("绑定代码目录");
    expect(emptyStateCopyFor("learn").title).toBe("开始一项学习任务");
    expect(emptyStateCopyFor("learn").detail).toContain("学习材料");
  });

  it("prepareRunAttachments extracts text documents and keeps error reason when empty", async () => {
    const processor = {
      processDocuments: vi.fn(async () => [
        { name: "a.md", kind: "text" as const, text: "正文" },
        { name: "empty.md", kind: "empty" as const, reason: "文档为空" },
      ]),
      captionImage: vi.fn(async () => ({ ok: true, caption: "一张图" })),
    };
    const files: PendingAttachment[] = [
      { name: "a.md", kind: "document", filePath: "C:\\a.md" },
      { name: "empty.md", kind: "document", filePath: "C:\\empty.md" },
      { name: "pic.png", kind: "image", filePath: "C:\\pic.png" },
      { name: "x.exe", kind: "unsupported", reason: "二进制" },
    ];

    const prepared = await prepareRunAttachments(files, processor, "问题");
    expect(processor.processDocuments).toHaveBeenCalledWith(["C:\\a.md", "C:\\empty.md"], "问题");
    expect(prepared).toHaveLength(4);
    expect(prepared[0]).toMatchObject({ name: "a.md", status: "done", content: "正文" });
    expect(prepared[1]).toMatchObject({ name: "empty.md", status: "error", reason: "文档为空" });
    expect(prepared[2]).toMatchObject({ name: "pic.png", status: "done", content: "一张图" });
    expect(prepared[3]).toMatchObject({ name: "x.exe", status: "error", reason: "二进制" });
  });

  it("prepareRunAttachments joins indexed chunks with file labels", async () => {
    const processor = {
      processDocuments: vi.fn(async () => [
        {
          name: "big.pdf",
          kind: "indexed" as const,
          retrievedChunks: [
            { text: "chunk-a", fileName: "big.pdf", chunkIndex: 0 },
            { text: "chunk-b", fileName: "big.pdf", chunkIndex: 2 },
          ],
        },
      ]),
      captionImage: vi.fn(),
    };

    const prepared = await prepareRunAttachments(
      [{ name: "big.pdf", kind: "document", filePath: "C:\\big.pdf" }],
      processor,
      "问题",
    );
    expect(prepared[0].content).toBe("[big.pdf #1] chunk-a\n[big.pdf #3] chunk-b");
  });

  it("prepareRunAttachments marks failed image captions as error", async () => {
    const processor = {
      processDocuments: vi.fn(async () => []),
      captionImage: vi.fn(async () => ({ ok: false, error: "VLM 超时" })),
    };

    const prepared = await prepareRunAttachments(
      [{ name: "pic.png", kind: "image", filePath: "C:\\pic.png" }],
      processor,
      "问题",
    );
    expect(prepared[0]).toMatchObject({ status: "error", reason: "VLM 超时" });
  });
});
