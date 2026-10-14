import { dialog, protocol, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { IPC } from "../../../shared/ipc-channels";
import type { LearnVideo, LearnVideoView } from "../../../shared/learn-study";
import type { IpcScope } from "../../application/ipc-scope";
import type { ExamPaperStore } from "../exam-paper-store";
import { LearnReviewService } from "./review-service";
import { LearnVideoService, parseSubtitles } from "./video-service";
import { studyPath, studyWorkspaceId } from "./study-path";
import { videoResponse } from "./video-response";

interface StudyHost {
  getWindow(): BrowserWindow | null;
  getSession(id: string): { mode?: string; workspaceBinding?: { workspaceRoot: string } } | null;
}
export function registerLearnStudyIpc(ipc: IpcScope, host: StudyHost, exams: ExamPaperStore): void {
  const media = new Map<string, { conversationId: string; root: string; file: string }>();
  function boundRoot(conversationId: string): string {
    const session = host.getSession(conversationId);
    if (session?.mode !== "learn" || !session.workspaceBinding?.workspaceRoot) throw new Error("E_LEARN_STUDY_FORBIDDEN");
    return fs.realpathSync(session.workspaceBinding.workspaceRoot);
  }
  function authorize(event: IpcMainInvokeEvent, payload: any): { conversationId: string; root: string; window: BrowserWindow } {
    const window = host.getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame
      || typeof payload?.conversationId !== "string") throw new Error("E_LEARN_STUDY_FORBIDDEN");
    return { conversationId: payload.conversationId, root: boundRoot(payload.conversationId), window };
  }
  function view(video: LearnVideo, conversationId: string, root: string): LearnVideoView {
    let token = [...media.entries()].find(([, value]) => value.conversationId === conversationId && value.root === root && value.file === video.file)?.[0];
    if (!token) { token = randomUUID(); media.set(token, { conversationId, root, file: video.file }); }
    return { ...video, workspaceId: studyWorkspaceId(root), url: `cyrene-learn://video/${token}` };
  }
  protocol.handle("cyrene-learn", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "video" || url.search || url.hash) return new Response(null, { status: 404 });
      const value = media.get(url.pathname.slice(1));
      const window = host.getWindow();
      if (!value || !window || window.isDestroyed() || boundRoot(value.conversationId) !== value.root) return new Response(null, { status: 403 });
      return await videoResponse(new LearnVideoService(value.root).resolve(value.file), request);
    } catch { return new Response(null, { status: 404 }); }
  });
  ipc.handle(IPC.LEARN_STUDY_OVERVIEW, async (event, payload) => {
    const { conversationId, root } = authorize(event, payload);
    const reviews = new LearnReviewService(root);
    for (const exam of await exams.listByConversation(conversationId)) {
      if (exam.gradingResult && exam.reviewWorkspaceRoot === root) await reviews.recordExam(exam);
    }
    return reviews.overview();
  });
  ipc.handle(IPC.LEARN_STUDY_ANSWER, async (event, payload) => {
    const { root } = authorize(event, payload);
    if (payload.workspaceId !== studyWorkspaceId(root)) throw new Error("E_LEARN_STUDY_BINDING_CHANGED");
    if (typeof payload.itemId !== "string" || typeof payload.attemptId !== "string" || !payload.answer || typeof payload.answer !== "object") throw new Error("E_LEARN_REVIEW_ANSWER");
    return new LearnReviewService(root).answer(payload.itemId, payload.attemptId, payload.answer);
  });
  ipc.handle(IPC.LEARN_VIDEO_LIST, async (event, payload) => {
    const { conversationId, root } = authorize(event, payload);
    return (await new LearnVideoService(root).list()).map((video) => view(video, conversationId, root));
  });
  ipc.handle(IPC.LEARN_VIDEO_CHOOSE, async (event, payload) => {
    const { conversationId, root, window } = authorize(event, payload);
    const selected = await dialog.showOpenDialog(window, { title: "选择 Vault 内的课程视频", defaultPath: root, properties: ["openFile"], filters: [{ name: "课程视频", extensions: ["mp4", "webm", "m4v", "ogv"] }] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    authorize(event, payload);
    if (boundRoot(conversationId) !== root) throw new Error("学习工作区已变化，请重新选择视频");
    const service = new LearnVideoService(root);
    const video = await service.add(path.relative(root, selected.filePaths[0]));
    return view(video, conversationId, root);
  });
  ipc.handle(IPC.LEARN_VIDEO_NOTE, async (event, payload) => {
    const { root } = authorize(event, payload);
    if (payload.workspaceId !== studyWorkspaceId(root)) throw new Error("E_LEARN_STUDY_BINDING_CHANGED");
    if (typeof payload.videoId !== "string") throw new Error("E_LEARN_VIDEO_ID");
    await new LearnVideoService(root).addNote(payload.videoId, payload.seconds, payload.text);
  });
  ipc.handle(IPC.LEARN_VIDEO_SUBTITLES, async (event, payload) => {
    const { conversationId, root, window } = authorize(event, payload);
    if (payload.workspaceId !== studyWorkspaceId(root)) throw new Error("E_LEARN_STUDY_BINDING_CHANGED");
    if (typeof payload.videoId !== "string" || !(await new LearnVideoService(root).list()).some((video) => video.id === payload.videoId)) throw new Error("E_LEARN_VIDEO_ID");
    const selected = await dialog.showOpenDialog(window, { title: "选择 Vault 内的 SRT/VTT 字幕", defaultPath: root, properties: ["openFile"], filters: [{ name: "字幕", extensions: ["srt", "vtt"] }] });
    if (selected.canceled || !selected.filePaths[0]) return;
    authorize(event, payload);
    if (boundRoot(conversationId) !== root) throw new Error("学习工作区已变化，请重新导入字幕");
    const file = studyPath(root, path.relative(root, selected.filePaths[0]));
    if (![".srt", ".vtt"].includes(path.extname(file).toLowerCase()) || fs.statSync(file).size > 2 * 1024 * 1024) throw new Error("E_LEARN_SUBTITLE_FILE");
    await new LearnVideoService(root).addEntries(payload.videoId, parseSubtitles(await readFile(file, "utf8")));
  });
}
