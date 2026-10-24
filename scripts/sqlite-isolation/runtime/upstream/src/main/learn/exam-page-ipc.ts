import { IPC } from "../../shared/ipc-channels";
import { toLearnExamView, type LearnExamAnswerValue, type LearnExamPageResult } from "../../shared/learn-exam";
import type { IpcScope } from "../application/ipc-scope";
import { publishLearnExamChanged } from "./exam-paper-ipc";
import type { ExamPaperStore } from "./exam-paper-store";
import { getTrustedExamPageSource, type ExamPageSource } from "./exam-page-authority";

interface PageIpcEvent { sender: ExamPageSource }

function forbidden(): LearnExamPageResult {
  return { ok: false, error: "E_LEARN_EXAM_PAGE_FORBIDDEN" };
}

export function registerLearnExamPageIpc(store: ExamPaperStore, ipc: IpcScope): void {
  async function readOwnedRecord(event: PageIpcEvent) {
    const page = getTrustedExamPageSource(event.sender);
    if (!page) return null;
    const record = await store.get(page.examId);
    if (!record || record.conversationId !== page.conversationId) return null;
    return { page, record };
  }

  ipc.handle(IPC.LEARN_EXAM_PAGE_GET, async (event: PageIpcEvent) => {
    const owned = await readOwnedRecord(event);
    if (!owned) return forbidden();
    return { ok: true, exam: toLearnExamView(owned.record) } satisfies LearnExamPageResult;
  });

  ipc.handle(IPC.LEARN_EXAM_PAGE_SAVE_ANSWER, async (event: PageIpcEvent, payload: unknown) => {
    const owned = await readOwnedRecord(event);
    if (!owned) return forbidden();
    if (!payload || typeof payload !== "object" || typeof (payload as Record<string, unknown>).questionId !== "string") {
      return { ok: false, error: "E_LEARN_EXAM_INVALID_REQUEST" } satisfies LearnExamPageResult;
    }
    const value = payload as Record<string, unknown>;
    const answer = value.answer === null ? null : value.answer as LearnExamAnswerValue;
    const updated = await store.saveAnswer(owned.page.examId, value.questionId as string, answer);
    if (!updated || updated.conversationId !== owned.page.conversationId) return { ok: false, error: "E_LEARN_EXAM_ANSWER_INVALID_OR_LOCKED" } satisfies LearnExamPageResult;
    return { ok: true, exam: toLearnExamView(updated) } satisfies LearnExamPageResult;
  });

  ipc.handle(IPC.LEARN_EXAM_PAGE_SAVE_NAVIGATION, async (event: PageIpcEvent, payload: unknown) => {
    const owned = await readOwnedRecord(event);
    if (!owned) return forbidden();
    if (!payload || typeof payload !== "object") return { ok: false, error: "E_LEARN_EXAM_INVALID_REQUEST" } satisfies LearnExamPageResult;
    const value = payload as Record<string, unknown>;
    if (typeof value.activeQuestionId !== "string" || !Array.isArray(value.flaggedQuestionIds)) return { ok: false, error: "E_LEARN_EXAM_INVALID_REQUEST" } satisfies LearnExamPageResult;
    const updated = await store.saveNavigation(owned.page.examId, value.activeQuestionId, value.flaggedQuestionIds.filter((item): item is string => typeof item === "string"));
    if (!updated || updated.conversationId !== owned.page.conversationId) return { ok: false, error: "E_LEARN_EXAM_NAVIGATION_INVALID_OR_LOCKED" } satisfies LearnExamPageResult;
    return { ok: true, exam: toLearnExamView(updated) } satisfies LearnExamPageResult;
  });

  ipc.handle(IPC.LEARN_EXAM_PAGE_SUBMIT, async (event: PageIpcEvent) => {
    const owned = await readOwnedRecord(event);
    if (!owned) return forbidden();
    const result = await store.submit(owned.page.examId);
    if (!result.record || result.record.conversationId !== owned.page.conversationId) return { ok: false, error: "E_LEARN_EXAM_SUBMIT_FAILED" } satisfies LearnExamPageResult;
    publishLearnExamChanged({
      conversationId: owned.page.conversationId,
      examId: owned.page.examId,
      ...(result.alreadySubmitted ? {} : { gradingRequested: true }),
    });
    return { ok: true, shouldStartGrading: !result.alreadySubmitted, exam: toLearnExamView(result.record) } satisfies LearnExamPageResult;
  });

  ipc.handle(IPC.LEARN_EXAM_PAGE_RETRY, async (event: PageIpcEvent) => {
    const owned = await readOwnedRecord(event);
    if (!owned || !owned.record.submittedAnswers
      || (owned.record.status !== "submitted" && owned.record.status !== "grading_failed")) {
      return { ok: false, error: "E_LEARN_EXAM_RETRY_NOT_ALLOWED" } satisfies LearnExamPageResult;
    }
    const updated = owned.record.status === "grading_failed"
      ? await store.resetForRetry(owned.page.examId)
      : owned.record;
    if (!updated || updated.conversationId !== owned.page.conversationId) {
      return { ok: false, error: "E_LEARN_EXAM_RETRY_FAILED" } satisfies LearnExamPageResult;
    }
    publishLearnExamChanged({ conversationId: owned.page.conversationId, examId: owned.page.examId, gradingRequested: true });
    return { ok: true, shouldStartGrading: true, exam: toLearnExamView(updated) } satisfies LearnExamPageResult;
  });
}
