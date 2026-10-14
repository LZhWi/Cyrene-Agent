import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import { toLearnExamView } from "../../shared/learn-exam";
import type { IpcScope } from "../application/ipc-scope";
import { createExamPaperStore } from "./exam-paper-store";
import { createExamDraftStore } from "./exam-draft";
import { registerExamPageSource } from "./exam-page-authority";
import { registerLearnExamPageIpc } from "./exam-page-ipc";
import { registerExamPaperIpc } from "./exam-paper-ipc";
import { createLearnExamTools } from "../orchestrator/learn-exam-tools";
import { parseLearnExamPageRequest, resolveLearnExamPageAsset } from "../protocols/learn-exam-page-protocol";

const context = { mode: "learn" as const, conversationId: "learn-a", runId: "run-a", userQuery: "test" };
describe("isolated Learn formal exam contract", () => {
  let root: string;
  let store: ReturnType<typeof createExamPaperStore>;
  let drafts: ReturnType<typeof createExamDraftStore>;
  let tools: ReturnType<typeof createLearnExamTools>;
  let handlers: Map<string, (...args: any[]) => any>;
  let revoke: (() => void) | undefined;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "cyrene-exam-integration-"));
    store = createExamPaperStore(root); drafts = createExamDraftStore(root, store);
    tools = createLearnExamTools(store, drafts); handlers = new Map();
  });
  afterEach(async () => { revoke?.(); revoke = undefined; await rm(root, { recursive: true, force: true }); });
  function ipc() { return { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) } as IpcScope; }
  async function paper() {
    const { draftId } = JSON.parse(await tools.createPlan.execute({ schemaVersion: 1, title: "数学", subject: "基础", durationMinutes: 10,
      totalPoints: 10, quotas: [{ type: "fill_blank", count: 1, points: 10, learningObjectives: ["加法"] }] }, context));
    await tools.addFillBlank.execute({ draftId, questions: [{ type: "fill_blank", prompt: "1+1=__，2+2=__", points: 10, learningObjective: "加法", explanation: "private explanation",
      blanks: [{ referenceAnswer: "2", rubric: ["private rubric"] }, { referenceAnswer: "4", rubric: ["private rubric"] }] }] }, context);
    const { examId } = JSON.parse(await tools.publish.execute({ draftId }, context));
    return (await store.get(examId))!;
  }
  it("does not touch storage when constructed; hard rejects Chat/Work/Code even when tools are enabled", async () => {
    expect(await readdir(root)).toEqual([]);
    for (const mode of ["chat", "work", "code"] as const) for (const tool of Object.values(tools)) {
      const args = tool.id === "learn_exam_save_grading" ? { examId: "exam", result: { totalScore: 0, summary: "test", questionResults: [{ questionId: "q", awardedPoints: 0, feedback: "x" }], abilityAnalysis: [], nextSteps: [] } } : { examId: "exam", draftId: "draft", questions: [] };
      await expect(tool.execute(args, { ...context, mode })).rejects.toMatchObject({ code: "E_LEARN_EXAM_MODE_FORBIDDEN" });
    }
    expect(await readdir(root)).toEqual([]);
  });
  it("keeps all keys, explanation and rubrics private, freezes answers exactly once, and saves validated grading", async () => {
    const record = await paper(); const question = record.questions[0];
    const view = JSON.stringify(toLearnExamView(record));
    expect(view).not.toContain("referenceAnswer"); expect(view).not.toContain("private"); expect(view).not.toContain("rubric");
    expect(await store.saveAnswer(record.examId, question.id, { value: ["2"] })).toBeNull();
    await store.saveAnswer(record.examId, question.id, { value: ["2", "4"] });
    expect((await store.submit(record.examId)).alreadySubmitted).toBe(false);
    expect(await store.saveAnswer(record.examId, question.id, { value: ["bad", "bad"] })).toBeNull();
    expect((await store.submit(record.examId)).alreadySubmitted).toBe(true);
    expect(JSON.parse(await tools.getSubmission.execute({ examId: record.examId }, context)).submittedAnswers[question.id]).toEqual({ value: ["2", "4"] });
    const result = { totalScore: 10, summary: "掌握", questionResults: [{ questionId: question.id, awardedPoints: 10, feedback: "正确" }], abilityAnalysis: [], nextSteps: [] };
    await expect(tools.saveGrading.execute({ examId: record.examId, result: { ...result, totalScore: 9 } }, context)).rejects.toMatchObject({ code: "E_LEARN_EXAM_INVALID_GRADING" });
    await tools.saveGrading.execute({ examId: record.examId, result }, context);
    expect(toLearnExamView((await store.get(record.examId))!).gradingResult).toEqual(result);
    expect(await store.setStatus(record.examId, "grading_failed")).toBeNull();
  });
  it("rejects another conversation and restores interrupted grading as retryable", async () => {
    const record = await paper();
    await expect(tools.getSubmission.execute({ examId: record.examId }, { ...context, conversationId: "learn-b" })).rejects.toMatchObject({ code: "E_LEARN_EXAM_NOT_FOUND" });
    await store.submit(record.examId); await store.setStatus(record.examId, "grading");
    await createExamPaperStore(root).recoverInterruptedGrading();
    expect((await store.get(record.examId))?.status).toBe("grading_failed");
    expect((await store.resetForRetry(record.examId))?.status).toBe("submitted");
  });
  it("binds the narrow page API to the actual window, exam and main frame", async () => {
    const record = await paper(); let url = `cyrene-exam://paper/${record.examId}`;
    const frame = {};
    const sender = { id: 91, mainFrame: frame, getURL: () => url, isDestroyed: () => false, send: vi.fn() };
    revoke = registerExamPageSource(sender, record.examId, record.conversationId);
    registerLearnExamPageIpc(store, ipc());
    const invoke = handlers.get(IPC.LEARN_EXAM_PAGE_GET)!;
    expect(await invoke({ sender, senderFrame: frame })).toMatchObject({ ok: true });
    expect(await invoke({ sender: { ...sender }, senderFrame: frame })).toMatchObject({ ok: false });
    expect(await invoke({ sender, senderFrame: {} })).toMatchObject({ ok: false });
    url = "https://example.com";
    expect(await invoke({ sender, senderFrame: frame })).toMatchObject({ ok: false });
  });
  it("restricts management IPC to the workspace window and Learn-owned records", async () => {
    const record = await paper(); const frame = {}; const sender = { mainFrame: frame, send: vi.fn() };
    const open = vi.fn(async () => undefined);
    registerExamPaperIpc(store, ipc(), { getWindow: () => ({ webContents: sender, isDestroyed: () => false }) as any, getMode: (id) => id === "chat" ? "chat" : "learn", open });
    const list = handlers.get(IPC.LEARN_EXAM_LIST)!;
    await expect(list({ sender: {}, senderFrame: frame }, { conversationId: context.conversationId })).rejects.toThrow("FORBIDDEN");
    await expect(list({ sender, senderFrame: frame }, { conversationId: "chat" })).rejects.toThrow("FORBIDDEN");
    expect(await list({ sender, senderFrame: frame }, { conversationId: context.conversationId })).toHaveLength(1);
    await expect(handlers.get(IPC.LEARN_EXAM_OPEN)!({ sender, senderFrame: frame }, { conversationId: "learn-b", examId: record.examId })).rejects.toThrow("NOT_FOUND");
    expect(open).not.toHaveBeenCalled();
  });
  it("blocks encoded path traversal and accepts only bundled exam assets", () => {
    expect(parseLearnExamPageRequest("cyrene-exam://paper/assets/%2e%2e/secret.js")).toBeNull();
    expect(parseLearnExamPageRequest("cyrene-exam://paper/assets/foo%2fbar.js")).toBeNull();
    expect(resolveLearnExamPageAsset(root, "assets/../../secret.js")).toBeNull();
    expect(resolveLearnExamPageAsset(root, "assets/exam.js")).toBe(path.join(root, "assets", "exam.js"));
  });
});
