import { describe, expect, it, vi } from "vitest";
import {
  deleteCompanionMemoryEntry,
  editCompanionMemoryEntry,
  loadCompanionMemoryPanelData,
  saveCompanionProfile,
} from "./companion-memory-panel";

describe("companion memory native panel adapter", () => {
  it("projects profiles, every lifecycle status, evidence text and reviews", async () => {
    const invoke = vi.fn(async () => ({ ok: true, data: {
      revision: 3,
      profiles: {
        l0: { preferredName: { content: "P宝" } },
        l1: { currentProject: { content: "Cyrene" } },
      },
      entries: [{ id: "e1", content: "喜欢乌龙茶", sourceQuote: "我喜欢乌龙茶", status: "superseded", sourceAt: 12, sourceEndAt: 13, confidence: 0.8 }],
      profileChanges: [{ id: "p1", layer: "L0", status: "accepted", after: { content: "P宝", sourceAt: 11 } }],
      entryReviews: [], compressionReviews: [],
    } }));
    const result = await loadCompanionMemoryPanelData(invoke, [{ importId: "d", fileName: "a.txt", chunkCount: 1, lastImportedAt: 9 }]);
    expect(result.l0.preferredName).toBe("P宝");
    expect(result.l1.currentProject).toBe("Cyrene");
    expect(result.l2[0]).toMatchObject({ status: "superseded", triggerText: "我喜欢乌龙茶", weight: 0.8, sourceAt: 12, sourceEndAt: 13 });
    expect(result.reflections[0]).toMatchObject({ id: "p1", body: "P宝" });
    expect(result.importedDocs).toHaveLength(1);
  });

  it("writes only changed profile fields and advances revision", async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: { revision: 5, profiles: { l0: { preferredName: { content: "旧称呼" } }, l1: {} } } })
      .mockResolvedValueOnce({ ok: true, data: { revision: 6, profiles: { l0: { preferredName: { content: "新称呼" } }, l1: {} } } })
      .mockResolvedValueOnce({ ok: true, data: { revision: 7, profiles: { l0: { preferredName: { content: "新称呼" }, language: { content: "中文" } }, l1: {} } } });
    await saveCompanionProfile(invoke, "L0", { preferredName: " 新称呼 ", occupation: "", language: "中文" });
    expect(invoke).toHaveBeenNthCalledWith(2, "edit-profile", { layer: "L0", field: "preferredName", content: "新称呼", revision: 5 });
    expect(invoke).toHaveBeenNthCalledWith(3, "edit-profile", { layer: "L0", field: "language", content: "中文", revision: 6 });
  });

  it("edits an entry with its current revision while preserving lifecycle fields", async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: { revision: 8, entries: [{ id: "e1", content: "旧内容", pinned: true, status: "aging" }] } })
      .mockResolvedValueOnce({ ok: true, data: { revision: 9, entries: [{ id: "e1", content: "新内容", pinned: true, status: "aging" }] } });

    await expect(editCompanionMemoryEntry(invoke, " e1 ", " 新内容 ")).resolves.toEqual({ ok: true, indexed: true });
    expect(invoke).toHaveBeenNthCalledWith(2, "edit-entry", {
      id: "e1", content: "新内容", pinned: true, status: "aging", revision: 8,
    });
  });

  it("deletes an existing entry with its current revision", async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: { revision: 4, entries: [{ id: "e2", content: "待删除" }] } })
      .mockResolvedValueOnce({ ok: true, data: { revision: 5, entries: [] } });

    await expect(deleteCompanionMemoryEntry(invoke, "e2")).resolves.toEqual({ ok: true, deleted: true, deletedVectors: 0 });
    expect(invoke).toHaveBeenNthCalledWith(2, "delete-entry", { id: "e2", revision: 4 });
  });

  it("enforces the companion entry content limit", async () => {
    const invoke = vi.fn();
    await expect(editCompanionMemoryEntry(invoke, "e1", "x".repeat(2001))).rejects.toThrow("2000");
    expect(invoke).not.toHaveBeenCalled();
  });
});
