import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc-channels";
import type { LearnExamPageApi, LearnExamChangedEvent, LearnExamAnswerValue } from "../shared/learn-exam";

const api: LearnExamPageApi = {
  getExam: () => ipcRenderer.invoke(IPC.LEARN_EXAM_PAGE_GET),
  saveAnswer: (questionId: string, answer: LearnExamAnswerValue | null) =>
    ipcRenderer.invoke(IPC.LEARN_EXAM_PAGE_SAVE_ANSWER, { questionId, answer }),
  saveNavigation: (activeQuestionId: string, flaggedQuestionIds: string[]) =>
    ipcRenderer.invoke(IPC.LEARN_EXAM_PAGE_SAVE_NAVIGATION, { activeQuestionId, flaggedQuestionIds }),
  submit: () => ipcRenderer.invoke(IPC.LEARN_EXAM_PAGE_SUBMIT),
  retry: () => ipcRenderer.invoke(IPC.LEARN_EXAM_PAGE_RETRY),
  onChanged: (callback: (event: LearnExamChangedEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: LearnExamChangedEvent) => callback(payload);
    ipcRenderer.on(IPC.LEARN_EXAM_PAGE_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC.LEARN_EXAM_PAGE_CHANGED, listener);
  },
};

contextBridge.exposeInMainWorld("learnExamPage", api);
