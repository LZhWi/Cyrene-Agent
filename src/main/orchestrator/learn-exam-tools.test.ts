import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LearnExamRecord } from "../../shared/learn-exam";
import type { ExamPaperStore } from "../learn/exam-paper-store";
import { createExamDraftStore } from "../learn/exam-draft";
import { createLearnExamTools } from "./learn-exam-tools";

const events = vi.hoisted(() => ({ created: vi.fn(), changed: vi.fn() }));
vi.mock("../learn/exam-paper-ipc", () => ({
  publishLearnExamCreated: events.created,
  publishLearnExamChanged: events.changed,
}));

const context = { userQuery: "出一份测试卷", conversationId: "conversation-a", runId: "run-a", mode: "learn" as const };

describe("staged Learn exam tools", () => {
  let root: string;
  let records: LearnExamRecord[];
  let tools: ReturnType<typeof createLearnExamTools>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "cyrene-learn-tools-"));
    records = [];
    events.created.mockClear();
    events.changed.mockClear();
    const paperStore = {
      create: async (record: LearnExamRecord) => { records.push(record); return record; },
      get: async (examId: string) => records.find((record) => record.examId === examId) ?? null,
    } as unknown as ExamPaperStore;
    const draftStore = createExamDraftStore(root, paperStore);
    tools = createLearnExamTools(paperStore, draftStore);
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  it("exposes the plan, five type-specific writers and publish tool only in Learn mode", () => {
    expect(Object.keys(tools)).toEqual(["createPlan", "addSingleChoice", "addMultipleChoice", "addTrueFalse", "addFillBlank", "addWritten", "publish", "getSubmission", "saveGrading"]);
    for (const tool of Object.values(tools)) expect(tool.modes).toEqual(["learn"]);
    expect("create" in tools).toBe(false);
  });

  it("rejects a question whose type does not match the selected writer", async () => {
    const result = await tools.createPlan.execute({
      schemaVersion: 1, title: "测试卷", subject: "数学", durationMinutes: 10, totalPoints: 10,
      quotas: [{ type: "single_choice", count: 1, points: 10, learningObjectives: ["极限"] }],
    }, context);
    const { draftId } = JSON.parse(result) as { draftId: string };
    await expect(tools.addSingleChoice.execute({ draftId, questions: [{ type: "true_false", prompt: "题目", points: 10, learningObjective: "极限", explanation: "", correct: true }] }, context))
      .rejects.toMatchObject({ code: "E_LEARN_EXAM_DRAFT_TYPE_MISMATCH" });
  });

  it("does not announce an incomplete paper and announces a successfully published paper once", async () => {
    const result = await tools.createPlan.execute({
      schemaVersion: 1, title: "测试卷", subject: "数学", durationMinutes: 10, totalPoints: 10,
      quotas: [{ type: "single_choice", count: 1, points: 10, learningObjectives: ["极限"] }],
    }, context);
    const { draftId } = JSON.parse(result) as { draftId: string };
    await expect(tools.publish.execute({ draftId }, context)).rejects.toMatchObject({ code: "E_LEARN_EXAM_DRAFT_INCOMPLETE" });
    expect(events.created).not.toHaveBeenCalled();

    await tools.addSingleChoice.execute({ draftId, questions: [{ type: "single_choice", prompt: "题目", points: 10, learningObjective: "极限", explanation: "", options: ["A", "B"], correctIndex: 0 }] }, context);
    const published = JSON.parse(await tools.publish.execute({ draftId }, context)) as { examId: string };
    expect(records).toHaveLength(1);
    expect(events.created).toHaveBeenCalledTimes(1);
    expect(events.created).toHaveBeenCalledWith({ conversationId: context.conversationId, examId: published.examId });
    await tools.publish.execute({ draftId }, context);
    expect(events.created).toHaveBeenCalledTimes(1);
  });
});
