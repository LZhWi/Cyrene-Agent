import type { IpcMainInvokeEvent, BrowserWindow } from "electron";
import type { IpcScope } from "../application/ipc-scope";
import { IPC } from "../../shared/ipc-channels";
import { toLearnExamView, type LearnExamChangedEvent, type LearnExamCreatedEvent } from "../../shared/learn-exam";
import type { ExamPaperStore } from "./exam-paper-store";
import { publishLearnExamPageChanged } from "./exam-page-authority";

interface ExamHost {
  getWindow(): BrowserWindow | null;
  getMode(conversationId: string): string | undefined;
  open(examId: string, conversationId: string): Promise<void>;
}
let host: ExamHost | undefined;

export function publishLearnExamCreated(event: LearnExamCreatedEvent): void {
  const window = host?.getWindow();
  if (host?.getMode(event.conversationId) !== "learn" || !window || window.isDestroyed()) return;
  window.webContents.send(IPC.LEARN_EXAM_CREATED, event);
  void host.open(event.examId, event.conversationId).catch((error) => console.error("[LearnExam] open failed", error));
}

export function publishLearnExamChanged(event: LearnExamChangedEvent): void {
  const window = host?.getWindow();
  if (window && !window.isDestroyed()) window.webContents.send(IPC.LEARN_EXAM_CHANGED, event);
  publishLearnExamPageChanged(event);
}

export function registerExamPaperIpc(store: ExamPaperStore, ipc: IpcScope, examHost: ExamHost): void {
  host = examHost;
  let recovery: Promise<void> | undefined;
  function authorize(event: IpcMainInvokeEvent, conversationId: unknown): asserts conversationId is string {
    const window = examHost.getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== event.sender.mainFrame || typeof conversationId !== "string"
      || examHost.getMode(conversationId) !== "learn") throw new Error("E_LEARN_EXAM_FORBIDDEN");
  }
  async function prepare() {
    if (!recovery) recovery = store.recoverInterruptedGrading().catch((error) => { recovery = undefined; throw error; });
    await recovery;
  }
  ipc.handle(IPC.LEARN_EXAM_LIST, async (event, payload) => {
    authorize(event, payload?.conversationId);
    await prepare();
    return (await store.listByConversation(payload.conversationId)).map(toLearnExamView);
  });
  for (const channel of [IPC.LEARN_EXAM_OPEN, IPC.LEARN_EXAM_BEGIN_GRADING, IPC.LEARN_EXAM_FINISH_GRADING]) {
    ipc.handle(channel, async (event, payload) => {
      authorize(event, payload?.conversationId);
      await prepare();
      if (typeof payload?.examId !== "string") throw new Error("E_LEARN_EXAM_INVALID_ID");
      const record = await store.get(payload.examId);
      if (!record || record.conversationId !== payload.conversationId) throw new Error("E_LEARN_EXAM_NOT_FOUND");
      if (channel === IPC.LEARN_EXAM_OPEN) await examHost.open(record.examId, record.conversationId);
      else if (channel === IPC.LEARN_EXAM_BEGIN_GRADING) {
        if (!record.submittedAnswers || !(await store.setStatus(record.examId, "grading"))) throw new Error("E_LEARN_EXAM_NOT_READY");
      } else await store.setStatus(record.examId, "grading_failed");
      publishLearnExamChanged({ examId: record.examId, conversationId: record.conversationId });
      return { ok: true };
    });
  }
}
