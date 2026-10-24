import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import type { LearnExamRecord } from "../../shared/learn-exam";
import type { IpcScope } from "../application/ipc-scope";
import type { ExamPaperStore } from "./exam-paper-store";
import { registerExamPageSource, unregisterExamPageSource } from "./exam-page-authority";
import { registerLearnExamPageIpc } from "./exam-page-ipc";

const changed = vi.hoisted(() => vi.fn());
vi.mock("./exam-paper-ipc", () => ({ publishLearnExamChanged: changed }));

const examId = "exam-123e4567-e89b-12d3-a456-426614174000";
const conversationId = "conversation-a";
const record: LearnExamRecord = {
  schemaVersion: 1, examId, conversationId, title: "测试卷", subject: "数学", durationMinutes: 10, totalPoints: 10,
  questions: [{ id: "q1", type: "single_choice", prompt: "题目", points: 10, learningObjective: "极限", explanation: "解析", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correctOptionId: "a" }],
  answers: {}, activeQuestionId: "q1", flaggedQuestionIds: [], status: "draft", createdAt: 1, updatedAt: 1,
};

describe("restricted Learn exam page IPC", () => {
  afterEach(() => { unregisterExamPageSource(41); changed.mockClear(); });

  it("rejects an unregistered sender without reading any exam record", async () => {
    const get = vi.fn(async () => record);
    const { handlers } = register({ get } as unknown as ExamPaperStore);
    const result = await handlers[IPC.LEARN_EXAM_PAGE_GET]({ sender: source(42) }, {});
    expect(result).toEqual({ ok: false, error: "E_LEARN_EXAM_PAGE_FORBIDDEN" });
    expect(get).not.toHaveBeenCalled();
  });

  it("binds exam and conversation to the trusted sender instead of renderer payload", async () => {
    const get = vi.fn(async (id: string) => id === examId ? record : null);
    const { handlers, trusted } = register({ get } as unknown as ExamPaperStore);
    const result = await handlers[IPC.LEARN_EXAM_PAGE_GET]({ sender: trusted }, { examId: "attacker-exam", conversationId: "attacker-conversation" }) as { ok: boolean; exam?: unknown };
    expect(get).toHaveBeenCalledWith(examId);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.exam)).not.toContain("correctOptionId");
  });

  it("submits only the exam bound to the trusted page and notifies the chat flow", async () => {
    const submit = vi.fn(async () => ({ record: { ...record, status: "submitted" as const, submittedAnswers: {} }, alreadySubmitted: false }));
    const { handlers, trusted } = register({ get: async () => record, submit } as unknown as ExamPaperStore);
    await handlers[IPC.LEARN_EXAM_PAGE_SUBMIT]({ sender: trusted }, { examId: "attacker-exam", conversationId: "attacker-conversation" });
    expect(submit).toHaveBeenCalledWith(examId);
    expect(changed).toHaveBeenCalledWith({ conversationId, examId, gradingRequested: true });
  });
});

function source(id: number) {
  return { id, getURL: () => `cyrene-exam://paper/${examId}`, isDestroyed: () => false, send: vi.fn() };
}

function register(store: ExamPaperStore) {
  const trusted = source(41);
  registerExamPageSource(trusted, examId, conversationId);
  const handlers: Record<string, (...args: any[]) => any> = {};
  const scope = { handle: (channel: string, handler: (...args: any[]) => any) => { handlers[channel] = handler; } } as IpcScope;
  registerLearnExamPageIpc(store, scope);
  return { handlers, trusted };
}
