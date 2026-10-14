import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as filesystem from "node:fs/promises";
import type { LearnExamRecord } from "../../shared/learn-exam";
import { createExamPaperStore } from "./exam-paper-store";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

describe("exam atomic replacement", () => {
  let root: string;
  let store: ReturnType<typeof createExamPaperStore>;
  const record: LearnExamRecord = {
    schemaVersion: 1, examId: "exam-11111111-1111-1111-1111-111111111111", conversationId: "learn",
    title: "Synthetic", subject: "Math", durationMinutes: 1, totalPoints: 1,
    questions: [{ id: "q", type: "true_false", prompt: "1+1=2", points: 1, learningObjective: "Addition", explanation: "Synthetic", correct: true }],
    answers: {}, activeQuestionId: "q", flaggedQuestionIds: [], status: "draft", createdAt: 1, updatedAt: 1,
  };
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "exam-replacement-"));
    vi.mocked(filesystem.rename).mockClear();
    store = createExamPaperStore(root);
    await store.create(structuredClone(record));
    vi.mocked(filesystem.rename).mockClear();
  });
  afterEach(async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(filesystem.rename).mockImplementation(actual.rename);
    await rm(root, { recursive: true, force: true });
  });
  it("retries a temporary sharing failure and then saves navigation and freezes answers", async () => {
    vi.mocked(filesystem.rename).mockRejectedValueOnce(Object.assign(new Error("sharing violation"), { code: "EPERM" }));
    await store.saveNavigation(record.examId, "q", ["q"]);
    expect(filesystem.rename).toHaveBeenCalledTimes(2);
    await store.saveAnswer(record.examId, "q", { value: false });
    expect((await store.submit(record.examId)).record?.submittedAnswers).toEqual({ q: { value: false } });
    expect((await store.get(record.examId))?.flaggedQuestionIds).toEqual(["q"]);
  });
  it("bounds repeated sharing failures, keeps the previous record and removes only its temporary file", async () => {
    vi.mocked(filesystem.rename).mockRejectedValue(Object.assign(new Error("locked"), { code: "EPERM" }));
    await expect(store.saveNavigation(record.examId, "q", ["q"])).rejects.toMatchObject({ code: "EPERM" });
    expect(filesystem.rename).toHaveBeenCalledTimes(5);
    expect(await store.get(record.examId)).toEqual(record);
    expect(await readdir(path.join(root, "learn-exams"))).toEqual([`${record.examId}.json`]);
  });
  it("does not retry unrelated filesystem errors", async () => {
    vi.mocked(filesystem.rename).mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    await expect(store.saveNavigation(record.examId, "q", ["q"])).rejects.toMatchObject({ code: "ENOSPC" });
    expect(filesystem.rename).toHaveBeenCalledTimes(1);
    expect(await store.get(record.examId)).toEqual(record);
  });
  it.each(["submitted", "grading", "grading_failed", "graded"] as const)("persists navigation after %s without changing frozen answers", async (status) => {
    const examId = "exam-22222222-2222-2222-2222-222222222222";
    const saved = { ...structuredClone(record), examId, status,
      questions: [...record.questions, { ...record.questions[0], id: "q2" }],
      answers: { q: { value: true } }, submittedAnswers: { q: { value: true } }, submittedAt: 10 };
    await store.create(saved);
    expect(await store.saveNavigation(examId, "q2", ["q2", "missing", "q2"])).not.toBeNull();
    expect(await store.saveAnswer(examId, "q", { value: false })).toBeNull();
    expect(await store.saveAnswer(examId, "q", null)).toBeNull();
    const reopened = await createExamPaperStore(root).get(examId);
    expect(reopened).toEqual({ ...saved, activeQuestionId: "q2", flaggedQuestionIds: ["q2"], updatedAt: expect.any(Number) });
    expect(await store.saveNavigation(examId, "missing", [])).toBeNull();
    expect(await store.get(examId)).toEqual(reopened);
  });
});
