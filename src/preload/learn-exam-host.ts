import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc-channels";
import type { LearnExamHostApi } from "../shared/learn-exam-host";
import type { LearnExamCreatedEvent } from "../shared/learn-exam";
import type { LearnStudyHostApi } from "../shared/learn-study";

export function exposeLearnExamHost(): void {
  const api: LearnExamHostApi = {
    list: (conversationId) => ipcRenderer.invoke(IPC.LEARN_EXAM_LIST, { conversationId }),
    open: (conversationId, examId) => ipcRenderer.invoke(IPC.LEARN_EXAM_OPEN, { conversationId, examId }),
    beginGrading: (conversationId, examId) => ipcRenderer.invoke(IPC.LEARN_EXAM_BEGIN_GRADING, { conversationId, examId }),
    finishGrading: (conversationId, examId) => ipcRenderer.invoke(IPC.LEARN_EXAM_FINISH_GRADING, { conversationId, examId }),
    onChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, event: LearnExamCreatedEvent) => callback(event);
      ipcRenderer.on(IPC.LEARN_EXAM_CREATED, listener);
      ipcRenderer.on(IPC.LEARN_EXAM_CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(IPC.LEARN_EXAM_CREATED, listener);
        ipcRenderer.removeListener(IPC.LEARN_EXAM_CHANGED, listener);
      };
    },
  };
  contextBridge.exposeInMainWorld("learnExams", api);
  const study: LearnStudyHostApi = {
    overview: (conversationId) => ipcRenderer.invoke(IPC.LEARN_STUDY_OVERVIEW, { conversationId }),
    answer: (conversationId, workspaceId, itemId, attemptId, answer) => ipcRenderer.invoke(IPC.LEARN_STUDY_ANSWER, { conversationId, workspaceId, itemId, attemptId, answer }),
    videos: (conversationId) => ipcRenderer.invoke(IPC.LEARN_VIDEO_LIST, { conversationId }),
    chooseVideo: (conversationId) => ipcRenderer.invoke(IPC.LEARN_VIDEO_CHOOSE, { conversationId }),
    addVideoNote: (conversationId, workspaceId, videoId, seconds, text) => ipcRenderer.invoke(IPC.LEARN_VIDEO_NOTE, { conversationId, workspaceId, videoId, seconds, text }),
    importSubtitles: (conversationId, workspaceId, videoId) => ipcRenderer.invoke(IPC.LEARN_VIDEO_SUBTITLES, { conversationId, workspaceId, videoId }),
    onWorkspaceChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, event: { sessionId: string }) => callback(event.sessionId);
      ipcRenderer.on(IPC.CHATS_WORKSPACE_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC.CHATS_WORKSPACE_CHANGED, listener);
    },
  };
  contextBridge.exposeInMainWorld("learnStudy", study);
}
