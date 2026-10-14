import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: vi.fn() } }));
import { popQuizTool } from "../../orchestrator/pop-quiz";
import { createLearnReviewTools } from "./review-tools";
import { LearnReviewService } from "./review-service";
import { contentHash } from "../obsidian/obsidian-markdown";
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "learn-review-tools-")); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { force: true, recursive: true }); });
const question = { type: "choice", question: "测试", options: ["a", "b"], correctIndex: 0, learningObjective: "目标", explanation: "解释" };
const result = { quizId: "quiz-test", status: "submitted", answers: [{ questionId: "q1", learningObjective: "目标", userAnswer: 0, correctAnswer: 0, grading: "correct" }] };
describe("Learn review tool boundaries", () => {
  it("blocks other modes and missing roots before tools or files are used", async () => {
    const original = vi.spyOn(popQuizTool, "execute");
    for (const tool of createLearnReviewTools()) for (const mode of ["chat", "work", "code"] as const) {
      await expect(tool.execute({ questions: [question] }, { mode, userQuery: "x", resolvedWorkspaceRoot: root })).rejects.toThrow("FORBIDDEN");
    }
    await expect(createLearnReviewTools()[0].execute({ questions: [question] }, { mode: "learn", userQuery: "x" })).rejects.toThrow("FORBIDDEN");
    expect(original).not.toHaveBeenCalled(); expect(fs.readdirSync(root)).toEqual([]);
  });
  it("pins the quiz write to its starting root through an awaited quiz", async () => {
    const other = path.join(root, "B"); fs.mkdirSync(other);
    let resolve!: (value: string) => void;
    vi.spyOn(popQuizTool, "execute").mockImplementation(() => new Promise((done) => { resolve = done; }));
    const context = { mode: "learn" as const, userQuery: "x", runId: "run-a", resolvedWorkspaceRoot: root };
    const running = createLearnReviewTools()[0].execute({ questions: [question] }, context);
    await vi.waitFor(() => expect(resolve).toBeDefined());
    context.resolvedWorkspaceRoot = other; resolve(JSON.stringify(result)); await running;
    expect(await new LearnReviewService(root).items()).toHaveLength(1); expect(await new LearnReviewService(other).items()).toHaveLength(0);
  });
  it("does not record a skipped quiz or run a transfer quiz with unsupported evidence", async () => {
    const original = vi.spyOn(popQuizTool, "execute").mockResolvedValue(JSON.stringify({ quizId: "skip", status: "skipped" }));
    const ctx = { mode: "learn" as const, userQuery: "x", runId: "run-a", resolvedWorkspaceRoot: root };
    const tool = createLearnReviewTools()[0];
    await tool.execute({ questions: [question] }, ctx);
    expect(await new LearnReviewService(root).items()).toEqual([]);
    await expect(tool.execute({ questions: [{ ...question, kind: "transfer" }] }, ctx)).rejects.toThrow("依据");
    expect(original).toHaveBeenCalledTimes(1);
    fs.writeFileSync(path.join(root, "material.md"), "# 目标\n真实原文依据\n");
    const sourceRef = { file: "material.md", quote: "真实原文依据", contentHash: contentHash(fs.readFileSync(path.join(root, "material.md"), "utf8")) };
    original.mockResolvedValue(JSON.stringify(result));
    await tool.execute({ questions: [{ ...question, kind: "transfer", sourceRef }] }, ctx);
    expect((await new LearnReviewService(root).items())[0]).toMatchObject({ kind: "transfer", source: sourceRef });
  });
});
