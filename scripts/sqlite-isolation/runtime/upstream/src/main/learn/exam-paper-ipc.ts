import { BrowserWindow } from "electron";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import { IPC } from "../../shared/ipc-channels";
import { toLearnExamView, type LearnExamAnswerValue, type LearnExamChangedEvent, type LearnExamCreatedEvent } from "../../shared/learn-exam";
import type { ExamPaperStore } from "./exam-paper-store";
import { publishLearnExamPageChanged } from "./exam-page-authority";

function publish(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function readIds(payload: unknown): { conversationId: string; examId: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (typeof value.conversationId !== "string" || !value.conversationId
    || typeof value.examId !== "string" || !value.examId) return null;
  return { conversationId: value.conversationId, examId: value.examId };
}

export function registerExamPaperIpc(store: ExamPaperStore, ipcOption?: IpcScope): void {
  const ipc = ipcOption ?? createIpcScope();

  ipc.handle(IPC.LEARN_EXAM_LIST, async (_event, payload: { conversationId?: unknown }) => {
    const conversationId = typeof payload?.conversationId === "string" ? payload.conversationId : "";
    if (!conversationId) return [];
    const records = await store.listByConversation(conversationId);
    return records.map(toLearnExamView);
  });

  ipc.handle(IPC.LEARN_EXAM_GET, async (_event, payload: unknown) => {
    const ids = readIds(payload);
    if (!ids) return { ok: false, error: "E_LEARN_EXAM_INVALID_REQUEST" };
    const record = await store.get(ids.examId);
    if (!record || record.conversationId !== ids.conversationId) return { ok: false, error: "E_LEARN_EXAM_NOT_FOUND" };
    return { ok: true, exam: toLearnExamView(record) };
  });

  ipc.handle(IPC.LEARN_EXAM_SAVE_ANSWER, async (_event, payload: unknown) => {
    const ids = readIds(payload);
    if (!ids || typeof (payload as Record<string, unknown>).questionId !== "string") return { ok: false, error: "E_LEARN_EXAM_INVALID_REQUEST" };
    const value = payload as Record<string, unknown>;
    const record = await store.get(ids.examId);
    if (!record || record.conversationId !== ids.conversationId) return { ok: false, error: "E_LEARN_EXAM_NOT_FOUND" };
    const answer = value.answer === null ? null : value.answer as LearnExamAnswerValue;
    const updated = await store.saveAnswer(ids.examId, value.questionId as string, answer);
    if (!updated) return { ok: false, error: "E_LEARN_EXAM_ANSWER_INVALID_OR_LOCKED" };
    return { ok: true, exam: toLearnExamView(updated) };
  });

  ipc.handle(IPC.LEARN_EXAM_SAVE_NAVIGATION, async (_event, payload: unknown) => {
    const ids = readIds(payload);
    if (!ids || typeof (payload as Record<string, unknown>).activeQuestionId !== "string"
      || !Array.isArray((payload as Record<string, unknown>).flaggedQuestionIds)) return { ok: false, error: "E_LEARN_EXAM_INVALID_REQUEST" };
    const value = payload as Record<string, unknown>;
    const record = await store.get(ids.examId);
    if (!record || record.conversationId !== ids.conversationId) return { ok: false, error: "E_LEARN_EXAM_NOT_FOUND" };
    const updated = await store.saveNavigation(ids.examId, value.activeQuestionId as string, value.flaggedQuestionIds as string[]);
    if (!updated) return { ok: false, error: "E_LEARN_EXAM_NAVIGATION_INVALID_OR_LOCKED" };
    return { ok: true, exam: toLearnExamView(updated) };
  });

  ipc.handle(IPC.LEARN_EXAM_SUBMIT, async (_event, payload: unknown) => {
    const ids = readIds(payload);
    if (!ids) return { ok: false, error: "E_LEARN_EXAM_INVALID_REQUEST" };
    const current = await store.get(ids.examId);
    if (!current || current.conversationId !== ids.conversationId) return { ok: false, error: "E_LEARN_EXAM_NOT_FOUND" };
    const result = await store.submit(ids.examId);
    if (!result.record) return { ok: false, error: "E_LEARN_EXAM_SUBMIT_FAILED" };
    publish(IPC.LEARN_EXAM_CHANGED, { conversationId: ids.conversationId, examId: ids.examId } satisfies LearnExamChangedEvent);
    return { ok: true, exam: toLearnExamView(result.record), shouldStartGrading: !result.alreadySubmitted };
  });

  ipc.handle(IPC.LEARN_EXAM_RETRY, async (_event, payload: unknown) => {
    const ids = readIds(payload);
    if (!ids) return { ok: false, error: "E_LEARN_EXAM_INVALID_REQUEST" };
    const record = await store.get(ids.examId);
    if (!record || record.conversationId !== ids.conversationId) return { ok: false, error: "E_LEARN_EXAM_NOT_FOUND" };
    if (!record.submittedAnswers || (record.status !== "submitted" && record.status !== "grading_failed")) {
      return { ok: false, error: "E_LEARN_EXAM_NOT_RETRYABLE" };
    }
    const updated = record.status === "grading_failed" ? await store.resetForRetry(ids.examId) : record;
    if (!updated) return { ok: false, error: "E_LEARN_EXAM_RETRY_FAILED" };
    publish(IPC.LEARN_EXAM_CHANGED, { conversationId: ids.conversationId, examId: ids.examId } satisfies LearnExamChangedEvent);
    return { ok: true, exam: toLearnExamView(updated), shouldStartGrading: true };
  });

  ipc.handle(IPC.LEARN_EXAM_MARK_GRADING_FAILED, async (_event, payload: unknown) => {
    const ids = readIds(payload);
    if (!ids) return { ok: false, error: "E_LEARN_EXAM_INVALID_REQUEST" };
    const record = await store.get(ids.examId);
    if (!record || record.conversationId !== ids.conversationId) return { ok: false, error: "E_LEARN_EXAM_NOT_FOUND" };
    const updated = await store.setStatus(ids.examId, "grading_failed");
    if (!updated) return { ok: false, error: "E_LEARN_EXAM_STATUS_NOT_CHANGED" };
    publish(IPC.LEARN_EXAM_CHANGED, { conversationId: ids.conversationId, examId: ids.examId } satisfies LearnExamChangedEvent);
    return { ok: true, exam: toLearnExamView(updated) };
  });
}

export function publishLearnExamCreated(event: LearnExamCreatedEvent): void {
  publish(IPC.LEARN_EXAM_CREATED, event);
}

export function publishLearnExamChanged(event: LearnExamChangedEvent): void {
  publish(IPC.LEARN_EXAM_CHANGED, event);
  publishLearnExamPageChanged(event);
}
