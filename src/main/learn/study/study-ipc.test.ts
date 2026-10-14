import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ showOpenDialog: vi.fn(), protocol: vi.fn() }));
vi.mock("electron", () => ({ dialog: { showOpenDialog: mock.showOpenDialog }, protocol: { handle: mock.protocol }, BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: vi.fn() } }));
import { registerLearnStudyIpc } from "./study-ipc";
import { LearnVideoService } from "./video-service";
import { createExamPaperStore } from "../exam-paper-store";
import { createExamDraftStore } from "../exam-draft";
import { createLearnExamTools } from "../../orchestrator/learn-exam-tools";
import { LearnReviewService } from "./review-service";
import { contentHash } from "../obsidian/obsidian-markdown";
import type { IpcScope } from "../../application/ipc-scope";
import { IPC } from "../../../shared/ipc-channels";
let temp: string; let root: string; let other: string; let mode: string;
let handlers: Map<string, (...args: any[]) => any>; let sender: any; let event: any;
let store: ReturnType<typeof createExamPaperStore>;
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "learn-study-ipc-")); root = path.join(temp, "A"); other = path.join(temp, "B"); fs.mkdirSync(root); fs.mkdirSync(other);
  mode = "learn"; handlers = new Map(); sender = { mainFrame: {}, send: vi.fn() }; event = { sender, senderFrame: sender.mainFrame };
  store = createExamPaperStore(path.join(temp, "userData")); mock.protocol.mockReset(); mock.showOpenDialog.mockReset();
  registerLearnStudyIpc({ handle: (channel, callback) => handlers.set(channel, callback) } as IpcScope,
    { getWindow: () => ({ webContents: sender, isDestroyed: () => false }) as any, getSession: () => ({ mode, workspaceBinding: { workspaceRoot: root } }) }, store);
});
afterEach(() => { fs.rmSync(temp, { recursive: true, force: true }); });
function invoke(channel: string, payload: any = {}, source = event) { return handlers.get(channel)!(source, { conversationId: "learn-a", ...payload }); }
describe("Learn-only IPC and exam review integration", () => {
  it("denies every route from Chat, other windows, and subframes without writing", async () => {
    for (const channel of handlers.keys()) {
      mode = "chat"; await expect(invoke(channel)).rejects.toThrow("FORBIDDEN");
      mode = "learn";
      await expect(invoke(channel, {}, { sender: {}, senderFrame: sender.mainFrame })).rejects.toThrow("FORBIDDEN");
      await expect(invoke(channel, {}, { sender, senderFrame: {} })).rejects.toThrow("FORBIDDEN");
    }
    expect(fs.readdirSync(root)).toEqual([]); expect(fs.existsSync(path.join(temp, "userData"))).toBe(false);
  });
  it("preserves the chosen Vault through a delayed file dialog and rejects rebinding", async () => {
    let finish!: (value: any) => void;
    mock.showOpenDialog.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const originalRoot = root;
    const choosing = invoke(IPC.LEARN_VIDEO_CHOOSE);
    await vi.waitFor(() => expect(finish).toBeDefined());
    root = other; finish({ canceled: false, filePaths: [path.join(originalRoot, "course.mp4")] });
    await expect(choosing).rejects.toThrow("已变化");
    expect(fs.readdirSync(other)).toEqual([]);
  });
  it("issues media capabilities only for managed Vault videos and revokes them after rebinding", async () => {
    fs.writeFileSync(path.join(root, "course.mp4"), "0123456789");
    await new LearnVideoService(root).add("course.mp4");
    const [video] = await invoke(IPC.LEARN_VIDEO_LIST);
    const media = mock.protocol.mock.calls[0][1];
    const response = await media(new Request(video.url, { headers: { range: "bytes=2-4" } }));
    expect(response.status).toBe(206); expect(await response.text()).toBe("234");
    expect((await media(new Request("cyrene-learn://video/unknown"))).status).toBe(403);
    expect((await media(new Request("cyrene-learn://secret/../../../secret"))).status).toBe(404);
    root = other; expect((await media(new Request(video.url))).status).toBe(403);
  });
  it("imports subtitle text, does not overwrite source media, and restricts selections", async () => {
    fs.writeFileSync(path.join(root, "course.mp4"), "video"); fs.writeFileSync(path.join(root, "course.srt"), "1\n00:00:03,000 --> 00:00:04,000\n原文字幕");
    mock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [path.join(root, "course.mp4")] });
    const video = await invoke(IPC.LEARN_VIDEO_CHOOSE);
    mock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [path.join(root, "course.srt")] });
    await invoke(IPC.LEARN_VIDEO_SUBTITLES, { videoId: video.id, workspaceId: video.workspaceId });
    expect((await invoke(IPC.LEARN_VIDEO_LIST))[0].entries[0]).toMatchObject({ seconds: 3, text: "原文字幕" });
    mock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [path.join(other, "escape.mp4")] });
    await expect(invoke(IPC.LEARN_VIDEO_CHOOSE)).rejects.toThrow("PATH");
    expect(fs.readFileSync(path.join(root, "course.mp4"), "utf8")).toBe("video");
  });
  it("records grading in the exam's original Vault and deduplicates recovery on refresh", async () => {
    const original = root;
    const drafts = createExamDraftStore(path.join(temp, "userData"), store); const tools = createLearnExamTools(store, drafts);
    const ctx = { mode: "learn" as const, conversationId: "learn-a", runId: "exam-run", userQuery: "exam", resolvedWorkspaceRoot: root };
    const { draftId } = JSON.parse(await tools.createPlan.execute({ schemaVersion: 1, title: "测试", subject: "加法", durationMinutes: 1, totalPoints: 1,
      quotas: [{ type: "true_false", count: 1, points: 1, learningObjectives: ["加法"] }] }, ctx));
    await tools.addTrueFalse.execute({ draftId, questions: [{ type: "true_false", prompt: "1+1=2", correct: true, points: 1, learningObjective: "加法", explanation: "相加" }] }, ctx);
    const { examId } = JSON.parse(await tools.publish.execute({ draftId }, ctx)); const exam = (await store.get(examId))!;
    await store.saveAnswer(examId, exam.questions[0].id, { value: false }); await store.submit(examId);
    root = other; ctx.resolvedWorkspaceRoot = other;
    await tools.saveGrading.execute({ examId, result: { totalScore: 0, summary: "需复习", questionResults: [{ questionId: exam.questions[0].id, awardedPoints: 0, feedback: "错误" }], abilityAnalysis: [], nextSteps: ["复习加法"] } }, ctx);
    expect(await new LearnReviewService(original).items()).toHaveLength(1); expect(await new LearnReviewService(other).items()).toEqual([]);
    expect((await invoke(IPC.LEARN_STUDY_OVERVIEW)).reviews).toEqual([]);
    root = original;
    await invoke(IPC.LEARN_STUDY_OVERVIEW); await invoke(IPC.LEARN_STUDY_OVERVIEW);
    expect((await new LearnReviewService(original).items())[0].attempts).toHaveLength(1);
  });
  it("validates formal question evidence and recovers a failed review write after grading", async () => {
    fs.writeFileSync(path.join(root, "material.md"), "# 加法\n两个一组成二。\n");
    const sourceRef = { file: "material.md", contentHash: contentHash(fs.readFileSync(path.join(root, "material.md"), "utf8")), quote: "两个一组成二。" };
    const drafts = createExamDraftStore(path.join(temp, "userData"), store); const tools = createLearnExamTools(store, drafts);
    const ctx = { mode: "learn" as const, conversationId: "learn-a", runId: "source-run", userQuery: "exam", resolvedWorkspaceRoot: root };
    const { draftId } = JSON.parse(await tools.createPlan.execute({ schemaVersion: 1, title: "应用", subject: "加法", durationMinutes: 1, totalPoints: 1,
      quotas: [{ type: "true_false", count: 1, points: 1, learningObjectives: ["加法"] }] }, ctx));
    const question = { type: "true_false", prompt: "两个物品各添加一个，总数四个", correct: true, points: 1, learningObjective: "加法", explanation: "合并", kind: "transfer", sourceRef };
    await expect(tools.addTrueFalse.execute({ draftId, questions: [{ ...question, sourceRef: { ...sourceRef, quote: "两个一组成九。" } }] }, ctx)).rejects.toThrow("CONFLICT");
    await tools.addTrueFalse.execute({ draftId, questions: [question] }, ctx);
    const { examId } = JSON.parse(await tools.publish.execute({ draftId }, ctx)); const exam = (await store.get(examId))!;
    expect(exam.questions[0]).toMatchObject({ kind: "transfer", sourceRef });
    await store.saveAnswer(examId, exam.questions[0].id, { value: true }); await store.submit(examId);
    const spy = vi.spyOn(LearnReviewService.prototype, "recordExam").mockRejectedValueOnce(new Error("synthetic review failure"));
    const result = JSON.parse(await tools.saveGrading.execute({ examId, result: { totalScore: 1, summary: "合格", questionResults: [{ questionId: exam.questions[0].id, awardedPoints: 1, feedback: "正确" }], abilityAnalysis: [], nextSteps: [] } }, ctx));
    expect(result.reviewWarning).toContain("评分已保存"); expect((await store.get(examId))!.status).toBe("graded"); spy.mockRestore();
    const overview = await invoke(IPC.LEARN_STUDY_OVERVIEW);
    expect(overview.reviews[0]).toMatchObject({ kind: "transfer", sourceStatus: "current", origin: "exam" });
    expect((await new LearnReviewService(root).items())[0].attempts).toHaveLength(1);
  });
  it("rejects old panel writes after rebinding even when both Vaults contain the same video ID", async () => {
    fs.writeFileSync(path.join(root, "course.mp4"), "A"); fs.writeFileSync(path.join(other, "course.mp4"), "B");
    const a = await new LearnVideoService(root).add("course.mp4"); const b = await new LearnVideoService(other).add("course.mp4"); expect(a.id).toBe(b.id);
    const [view] = await invoke(IPC.LEARN_VIDEO_LIST); root = other;
    await expect(invoke(IPC.LEARN_VIDEO_NOTE, { workspaceId: view.workspaceId, videoId: view.id, seconds: 0, text: "A笔记" })).rejects.toThrow("BINDING_CHANGED");
    await expect(invoke(IPC.LEARN_STUDY_ANSWER, { workspaceId: view.workspaceId, itemId: "item", attemptId: "attempt", answer: {} })).rejects.toThrow("BINDING_CHANGED");
    expect((await new LearnVideoService(other).list())[0].entries).toEqual([]);
  });
});
