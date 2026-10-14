import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createObsidianWorkspace, ObsidianError } from "../obsidian/obsidian-workspace-service";
import { applyProgressUpdate, ensureProgressFile, loadProgress } from "./learn-progress-service";
import type { LearnProgressUpdate } from "./learn-progress-types";

vi.mock("./learn-progress-extractor", () => ({ extractProgress: vi.fn() }));
import { extractProgress } from "./learn-progress-extractor";
import { runLearnPostTurnHook, type LearnPostTurnDeps } from "./learn-post-turn";

let temp: string;
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "learn-progress-isolation-"));
  vi.mocked(extractProgress).mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(temp, { recursive: true, force: true });
});
function workspace(name: string) {
  const root = path.join(temp, name);
  fs.mkdirSync(root, { recursive: true });
  return createObsidianWorkspace(root);
}
function deps(bound: ReturnType<typeof workspace>, userMessage: string): LearnPostTurnDeps {
  return { workspace: bound, adapter: {} as never, cfg: {} as never, systemPrompt: "",
    userMessage, assistantMessage: "本轮学习内容，模拟模型结果，不发送任何 API 请求。".repeat(5) };
}

describe("Learn background progress isolation", () => {
  it("keeps delayed A extraction bound to A after B runs and finishes first", async () => {
    const a = workspace("A");
    const b = workspace("B");
    let finishA!: (update: LearnProgressUpdate) => void;
    const delayedA = new Promise<LearnProgressUpdate>(resolve => { finishA = resolve; });
    vi.mocked(extractProgress).mockImplementation(async input => input.userMessage === "A"
      ? delayedA : { hasMeaningfulChange: true, topic: "B-topic", masteryDelta: 5 });
    await runLearnPostTurnHook(deps(a, "A"));
    await vi.waitFor(() => expect(extractProgress).toHaveBeenCalledTimes(1));
    await runLearnPostTurnHook(deps(b, "B"));
    await vi.waitFor(async () => expect((await loadProgress(b)).topics["B-topic"]?.mastery).toBe(5));
    finishA({ hasMeaningfulChange: true, topic: "A-topic", masteryDelta: 10 });
    await vi.waitFor(async () => expect((await loadProgress(a)).topics["A-topic"]?.mastery).toBe(10));
    expect((await loadProgress(b)).topics["A-topic"]).toBeUndefined();
    expect((await loadProgress(a)).topics["B-topic"]).toBeUndefined();
  });

  it("merges every delta from separate service instances sharing the same Vault", async () => {
    const a = workspace("shared");
    const other = createObsidianWorkspace(path.join(temp, "shared"));
    await Promise.all(Array.from({ length: 20 }, (_, i) => applyProgressUpdate(i % 2 ? a : other,
      { hasMeaningfulChange: true, topic: "Shared-topic", masteryDelta: 1, unresolvedQuestionsAdded: [`q${i}`] })));
    const topic = (await loadProgress(a)).topics["Shared-topic"];
    expect(topic.mastery).toBe(20);
    expect(topic.unresolvedQuestions).toHaveLength(20);
  });

  it("retains concurrent edits and rejects stale full-file replacement hashes", async () => {
    const a = workspace("shared");
    const other = createObsidianWorkspace(path.join(temp, "shared"));
    await ensureProgressFile(a);
    const before = await a.readFile({ path: "learn/progress.md" });
    await Promise.all([
      other.edit({ operation: "append", path: "learn/progress.md", content: "Additional content", expectedContentHash: before.contentHash }),
      a.edit({ operation: "append", path: "learn/progress.md", content: "Stale content", expectedContentHash: before.contentHash }),
    ].map(p => p.catch(error => error)));
    const current = await a.readFile({ path: "learn/progress.md" });
    expect(current.content).toContain("Additional content");
    expect(current.content).not.toContain("Stale content");
    await expect(other.edit({ operation: "replace_file", path: "learn/progress.md", content: "overwrite", expectedContentHash: before.contentHash }))
      .rejects.toMatchObject({ code: "CONTENT_CONFLICT" });
  });

  it("does not fall back to an unchecked overwrite on write failure, and releases the write queue", async () => {
    const a = workspace("failure");
    await applyProgressUpdate(a, { hasMeaningfulChange: true, topic: "Existing", masteryDelta: 5 });
    const before = await a.readFile({ path: "learn/progress.md" });
    const writes = vi.spyOn(a as unknown as { atomicWrite: (file: string, content: string) => Promise<void> }, "atomicWrite")
      .mockRejectedValueOnce(new ObsidianError("WRITE_FAILED", "simulated write failure"));
    await expect(applyProgressUpdate(a, { hasMeaningfulChange: true, topic: "Lost", masteryDelta: 5 })).rejects.toThrow("simulated");
    expect((await a.readFile({ path: "learn/progress.md" })).contentHash).toBe(before.contentHash);
    await applyProgressUpdate(a, { hasMeaningfulChange: true, topic: "Next", masteryDelta: 5 });
    expect((await loadProgress(a)).topics.Next.mastery).toBe(5);
    expect(writes).toHaveBeenCalledTimes(2);
  });

  it("skips short or unchanged turns and reports extractor failures without writing to another Vault", async () => {
    const a = workspace("A");
    await runLearnPostTurnHook({ ...deps(a, "short"), assistantMessage: "短回复" });
    expect(extractProgress).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(temp, "A/learn/progress.md"))).toBe(false);
    vi.mocked(extractProgress).mockResolvedValueOnce({ hasMeaningfulChange: false });
    await runLearnPostTurnHook(deps(a, "unchanged"));
    await vi.waitFor(() => expect(extractProgress).toHaveBeenCalledTimes(1));
    vi.mocked(extractProgress).mockRejectedValueOnce(new Error("simulated extractor failure"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runLearnPostTurnHook(deps(a, "failed"));
    await vi.waitFor(() => expect(warning).toHaveBeenCalled());
    expect((await loadProgress(a)).topics).toEqual({});
  });
});
