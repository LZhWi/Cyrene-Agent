import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: vi.fn() } }));
import { LearnReviewService } from "./review-service";
import { contentHash } from "../obsidian/obsidian-markdown";
import { ObsidianWorkspaceService } from "../obsidian/obsidian-workspace-service";
import { applyProgressUpdate, loadProgress } from "../progress/learn-progress-service";
import { createObsidianWorkspace } from "../obsidian/obsidian-workspace-service";
import type { QuizQuestionInput } from "../../../shared/pop-quiz";

let root: string;
let clock: number;
const question: QuizQuestionInput = { type: "choice", question: "1+1？", options: ["2", "3"], correctIndex: 0, learningObjective: "加法", explanation: "两个一组成二" };
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "learn-review-")); clock = Date.UTC(2026, 9, 3); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { force: true, recursive: true }); });
function service() { return new LearnReviewService(root, () => clock); }
async function record(correct: boolean, id = randomUUID()) {
  await service().record({ question, origin: "quiz", attempt: { id, at: new Date(clock).toISOString(), result: correct ? "correct" : "incorrect", answer: correct ? 0 : 1, feedback: "反馈", grader: "local" } });
}
describe("Learn evidence and spaced review", () => {
  it("keeps objective attempts separate from estimated progress and hides keys in the panel", async () => {
    await record(false);
    const vault = createObsidianWorkspace(root);
    await applyProgressUpdate(vault, { hasMeaningfulChange: true, topic: "加法", masteryDelta: 80 });
    const overview = await service().overview();
    expect(overview.weakTopics).toEqual([{ objective: "加法", incorrect: 1, assessed: 1 }]);
    expect(overview.estimatedTopics).toEqual([{ topic: "加法", mastery: 80 }]);
    expect((await loadProgress(vault)).topics["加法"].mastery).toBe(80);
    expect(JSON.stringify(overview)).not.toMatch(/correctIndex|correctAnswer|referenceAnswer|rubric|两个一/);
  });
  it("expands successful recall intervals and resets after a mistake", async () => {
    await record(false);
    expect((await service().items())[0].intervalDays).toBe(1);
    clock += 86400000;
    expect((await service().overview()).dueCount).toBe(1);
    await record(true); expect((await service().items())[0].intervalDays).toBe(3);
    clock += 3 * 86400000;
    await record(true); expect((await service().items())[0].intervalDays).toBe(6);
    clock += 6 * 86400000;
    await record(true); expect((await service().items())[0].intervalDays).toBe(12);
    clock += 12 * 86400000;
    await record(false); expect((await service().items())[0]).toMatchObject({ streak: 0, intervalDays: 1 });
  });
  it("deduplicates concurrent delivery and preserves twenty distinct attempts", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, index) => record(index % 2 === 0, `delivery-${index}`)));
    await Promise.all(Array.from({ length: 20 }, (_, index) => record(index % 2 === 0, `delivery-${index}`)));
    const items = await service().items(); expect(items).toHaveLength(1); expect(items[0].attempts).toHaveLength(20);
  });
  it("does not let a late older assessment override a newer answer", async () => {
    await record(true, "new");
    clock -= 3 * 86400000;
    await record(false, "old");
    const item = (await service().items())[0];
    expect(item.attempts.at(-1)?.id).toBe("new"); expect(item.streak).toBe(1); expect(item.intervalDays).toBe(3);
  });
  it("rejects weak quote matches, stale versions, and escaping source paths", async () => {
    fs.writeFileSync(path.join(root, "source.md"), "# 加法\n两个一组成二。\n");
    const source = { file: "source.md", contentHash: contentHash(fs.readFileSync(path.join(root, "source.md"), "utf8")), quote: "两个一组成二。" };
    await service().validateSource(source);
    await expect(service().validateSource({ ...source, quote: "两个一组成九。" })).rejects.toThrow("SOURCE_CONFLICT");
    await service().record({ question, source, origin: "quiz", attempt: { id: "sourced", at: new Date(clock).toISOString(), result: "incorrect", answer: 1, feedback: "x", grader: "local" } });
    fs.appendFileSync(path.join(root, "source.md"), "材料已改\n");
    const view = (await service().overview()).reviews[0]; expect(view.sourceStatus).toBe("stale");
    await expect(service().answer(view.id, randomUUID(), { questionId: "q1", optionId: "q1-opt-1" })).rejects.toThrow("材料已变化");
    await expect(service().validateSource({ ...source, file: "../source.md" })).rejects.toThrow("PATH");
  });
  it("saves a real review answer once even after a transport retry", async () => {
    await record(false); const item = (await service().items())[0]; const id = randomUUID();
    const input = { questionId: "q1", optionId: "q1-opt-1" };
    expect(await service().answer(item.id, id, input)).toMatchObject({ result: "correct" });
    await service().answer(item.id, id, input);
    expect((await service().items())[0].attempts).toHaveLength(2);
    await expect(service().answer(item.id, id, { ...input, optionId: "q1-opt-2" })).rejects.toThrow("CONFLICT");
  });
  it("keeps written answers pending until an explicit evidence-bound grading", async () => {
    const written: QuizQuestionInput = { type: "short_answer", question: "说明加法", learningObjective: "加法", explanation: "说明", referenceAnswer: "合并数量", rubric: ["说明合并"] };
    await service().recordQuiz("written", [written], [{ questionId: "q1", learningObjective: "加法", userAnswer: "合并数量", grading: "pending_model" }]);
    const item = (await service().items())[0];
    expect(item.nextReviewAt).toBeUndefined(); expect((await service().overview()).weakTopics).toEqual([]);
    await expect(service().gradePending(item.id, "wrong", true, "合格")).rejects.toThrow("CONFLICT");
    await service().gradePending(item.id, "written:q1", true, "符合评分参考");
    expect((await service().items())[0].attempts).toHaveLength(1);
    expect((await service().items())[0].attempts[0]).toMatchObject({ result: "correct", grader: "model" });
    await expect(service().gradePending(item.id, "written:q1", true, "重复")).rejects.toThrow("CONFLICT");
  });
  it("does not overwrite unmanaged data or alter the other Vault on a failed write", async () => {
    await record(false);
    const before = fs.readFileSync(path.join(root, "learn/reviews.md"), "utf8");
    vi.spyOn(ObsidianWorkspaceService.prototype as any, "atomicWrite").mockRejectedValueOnce(new Error("synthetic disk failure"));
    await expect(record(true)).rejects.toThrow("disk failure");
    expect(fs.readFileSync(path.join(root, "learn/reviews.md"), "utf8")).toBe(before);
    expect((await service().items())[0].attempts).toHaveLength(1);
    const other = path.join(root, "B"); fs.mkdirSync(other);
    expect(await new LearnReviewService(other).items()).toEqual([]);
    fs.writeFileSync(path.join(root, "learn/reviews.md"), "user notes");
    await expect(record(true)).rejects.toThrow("FORMAT");
    expect(fs.readFileSync(path.join(root, "learn/reviews.md"), "utf8")).toBe("user notes");
  });
  it("blocks a missing review file under a junction outside the Vault", async () => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), "learn-outer-"));
    try {
      fs.symlinkSync(outer, path.join(root, "learn"), process.platform === "win32" ? "junction" : "dir");
      await expect(record(false)).rejects.toThrow("PATH"); expect(fs.readdirSync(outer)).toEqual([]);
    } finally { fs.unlinkSync(path.join(root, "learn")); fs.rmSync(outer, { recursive: true, force: true }); }
  });
});
