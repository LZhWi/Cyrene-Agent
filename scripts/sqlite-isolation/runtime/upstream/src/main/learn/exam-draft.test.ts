import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LearnExamPlanInput, LearnExamQuestionInput, LearnExamRecord } from "../../shared/learn-exam";
import type { ExamPaperStore } from "./exam-paper-store";
import { createExamDraftStore, validateLearnExamPlan } from "./exam-draft";

const owner = { conversationId: "conversation-a", runId: "run-a" };

function plan(overrides: Partial<LearnExamPlanInput> = {}): LearnExamPlanInput {
  return {
    schemaVersion: 1,
    title: "微积分基础测试",
    subject: "数学",
    durationMinutes: 40,
    totalPoints: 20,
    quotas: [{ type: "single_choice", count: 2, points: 20, learningObjectives: ["极限"] }],
    ...overrides,
  };
}

function singleChoice(prompt: string, points = 10): LearnExamQuestionInput {
  return { type: "single_choice", prompt, points, learningObjective: "极限", explanation: "说明", options: ["A", "B"], correctIndex: 0 };
}

describe("Learn exam draft domain store", () => {
  let userDataDir: string;
  let records: LearnExamRecord[];
  let store: ReturnType<typeof createExamDraftStore>;

  beforeEach(async () => {
    userDataDir = await mkdtemp(path.join(os.tmpdir(), "cyrene-exam-draft-"));
    records = [];
    const paperStore = {
      create: async (record: LearnExamRecord) => { records.push(record); return record; },
      get: async (examId: string) => records.find((record) => record.examId === examId) ?? null,
    } as ExamPaperStore;
    store = createExamDraftStore(userDataDir, paperStore);
  });

  afterEach(async () => rm(userDataDir, { recursive: true, force: true }));

  it("rejects a plan when type quotas do not add up to the paper total", () => {
    const result = validateLearnExamPlan(plan({ totalPoints: 21 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("totalPoints");
  });

  it("reports the remaining count and points after an accepted batch", async () => {
    const draft = await store.createDraft(plan(), owner);
    const result = await store.appendBatch(draft.draftId, "single_choice", [singleChoice("题目一")], owner);
    expect(result.progress).toEqual({ completed: 1, remaining: 1, pointsCompleted: 10, pointsRemaining: 10, totalCompleted: 1, totalQuestions: 2 });
  });

  it("rejects a batch whose question type differs from its tool type without writing any question", async () => {
    const draft = await store.createDraft(plan(), owner);
    const otherType = { ...singleChoice("判断"), type: "true_false", correct: true } as unknown as LearnExamQuestionInput;
    await expect(store.appendBatch(draft.draftId, "single_choice", [singleChoice("有效"), otherType], owner)).rejects.toMatchObject({ code: "E_LEARN_EXAM_DRAFT_TYPE_MISMATCH" });
    expect((await store.getDraft(draft.draftId, owner))?.questions).toHaveLength(0);
  });

  it("rejects batches exceeding the planned point quota without partial writes", async () => {
    const draft = await store.createDraft(plan(), owner);
    await expect(store.appendBatch(draft.draftId, "single_choice", [singleChoice("第一题", 15), singleChoice("第二题", 10)], owner)).rejects.toMatchObject({ code: "E_LEARN_EXAM_DRAFT_POINTS_EXCEEDED" });
    expect((await store.getDraft(draft.draftId, owner))?.questions).toHaveLength(0);
  });

  it("rejects missing question fields and out-of-range answer indexes", async () => {
    const draft = await store.createDraft(plan(), owner);
    await expect(store.appendBatch(draft.draftId, "single_choice", [{ type: "single_choice", prompt: "不完整", points: 10 }], owner)).rejects.toMatchObject({ code: "E_LEARN_EXAM_DRAFT_INVALID_QUESTION" });
    await expect(store.appendBatch(draft.draftId, "single_choice", [{ ...singleChoice("索引越界"), correctIndex: 2 }], owner)).rejects.toMatchObject({ code: "E_LEARN_EXAM_DRAFT_INVALID_QUESTION" });
    expect((await store.getDraft(draft.draftId, owner))?.questions).toHaveLength(0);
  });

  it("publishes only when every quota count and point total is complete", async () => {
    const draft = await store.createDraft(plan(), owner);
    await store.appendBatch(draft.draftId, "single_choice", [singleChoice("题目一")], owner);
    await expect(store.publish(draft.draftId, owner)).rejects.toMatchObject({ code: "E_LEARN_EXAM_DRAFT_INCOMPLETE" });
    expect(records).toHaveLength(0);
    await store.appendBatch(draft.draftId, "single_choice", [singleChoice("题目二")], owner);
    const published = await store.publish(draft.draftId, owner);
    expect(published.record.questions).toHaveLength(2);
    expect(records).toHaveLength(1);
    expect(await store.getDraft(draft.draftId, owner)).toMatchObject({ status: "published", examId: published.record.examId });
    expect(await store.publish(draft.draftId, owner)).toMatchObject({ record: { examId: published.record.examId }, alreadyPublished: true });
  });

  it("does not expose a draft to another conversation or run", async () => {
    const draft = await store.createDraft(plan(), owner);
    await expect(store.getDraft(draft.draftId, { conversationId: "conversation-b", runId: "run-a" })).rejects.toMatchObject({ code: "E_LEARN_EXAM_DRAFT_NOT_FOUND" });
    await expect(store.appendBatch(draft.draftId, "single_choice", [singleChoice("越权")], { ...owner, runId: "run-b" })).rejects.toMatchObject({ code: "E_LEARN_EXAM_DRAFT_NOT_FOUND" });
  });

  it("removes expired draft records", async () => {
    let clock = 1_000;
    const paperStore = { create: async (record: LearnExamRecord) => record, get: async () => null } as unknown as ExamPaperStore;
    const expiringStore = createExamDraftStore(userDataDir, paperStore, { now: () => clock });
    await expiringStore.createDraft(plan(), owner);
    clock += 24 * 60 * 60 * 1000 + 1;
    expect(await expiringStore.deleteExpired()).toBe(1);
  });
});
