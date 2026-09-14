import { describe, expect, it, vi } from "vitest";
import { processDocumentIndexRequest } from "./document-index-ipc";

describe("document index IPC core", () => {
  it("forwards document indexing progress to the requesting sender", async () => {
    const send = vi.fn();
    const result = await processDocumentIndexRequest({
      filePaths: ["C:\\tmp\\large.md"],
      query: "summarize",
      sender: { send },
      enqueue: async (input) => {
        input.onProgress({
          jobId: "job-1",
          filePath: input.filePath,
          fileName: "large.md",
          status: "embedding",
          completedChunks: 1,
          totalChunks: 2,
        });
        return { kind: "indexed", name: "large.md", chunks: 2, importId: "import-1" };
      },
      retrieve: vi.fn().mockResolvedValue([]),
    });

    expect(send).toHaveBeenCalledWith("chat:document-index-progress", expect.objectContaining({
      fileName: "large.md",
      status: "embedding",
    }));
    expect(result).toMatchObject([{ kind: "indexed", importId: "import-1" }]);
  });

  it("keeps indexed small-document text and skips redundant same-turn retrieval", async () => {
    const retrieve = vi.fn();
    const result = await processDocumentIndexRequest({
      filePaths: ["C:\\tmp\\small.md"],
      query: "summarize",
      sender: { send: vi.fn() },
      enqueue: async () => ({
        kind: "indexed",
        name: "small.md",
        chunks: 1,
        importId: "import-small",
        text: "small document body",
      }),
      retrieve,
    });

    expect(retrieve).not.toHaveBeenCalled();
    expect(result).toMatchObject([{
      kind: "indexed",
      importId: "import-small",
      text: "small document body",
    }]);
  });
});
