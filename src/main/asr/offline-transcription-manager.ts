import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from "electron";
import fs from "node:fs";
import path from "node:path";
import { IPC } from "../../shared/ipc-channels";
import { transcribeLocalAudioFile, type OfflineTranscriptionFormat, type OfflineTranscriptionProfile } from "./offline-transcription";

export type OfflineTranscriptionUiState = "idle" | "decoding" | "segmenting" | "loading" | "transcribing" | "completed" | "cancelled" | "error";

export interface OfflineTranscriptionSnapshot {
  state: OfflineTranscriptionUiState;
  message: string;
  inputPath?: string;
  outputPath?: string;
  completedSegments?: number;
  totalSegments?: number;
  format?: OfflineTranscriptionFormat;
  includeTimestamps?: boolean;
}

interface StartRequest {
  inputPath?: string;
  outputPath?: string;
  profile?: string;
  language?: string;
  hotwords?: unknown;
  format?: string;
  includeTimestamps?: boolean;
}

let controller: AbortController | null = null;
let owner: WebContents | null = null;
let snapshot: OfflineTranscriptionSnapshot = { state: "idle", message: "请选择音频和输出位置" };
const approvedInputs = new WeakMap<WebContents, string>();
const approvedOutputs = new WeakMap<WebContents, string>();

function isRunningState(state: OfflineTranscriptionUiState): boolean {
  return ["decoding", "segmenting", "loading", "transcribing"].includes(state);
}

function publish(next: OfflineTranscriptionSnapshot): void {
  snapshot = next;
  if (owner && !owner.isDestroyed()) owner.send(IPC.ASR_TRANSCRIPTION_PROGRESS, next);
}

function normalizeProfile(profile: string | undefined): OfflineTranscriptionProfile {
  return profile === "qwen06-stream" ? "qwen06-stream" : "qwen17-stream";
}

function normalizeLanguage(language: string | undefined): "zh" | "en" | "auto" {
  return language === "en" || language === "auto" ? language : "zh";
}

function normalizeFormat(format: string | undefined): OfflineTranscriptionFormat {
  return format === "txt" || format === "docx" ? format : "md";
}

function validatePath(value: string | undefined, label: string): string {
  if (!value || !path.isAbsolute(value)) throw new Error(`${label}无效`);
  return path.normalize(value);
}

export function isOfflineTranscriptionActive(): boolean {
  return isRunningState(snapshot.state);
}

export function getOfflineTranscriptionState(): OfflineTranscriptionSnapshot {
  return { ...snapshot };
}

export function cancelOfflineTranscription(): boolean {
  if (!controller) return false;
  controller.abort();
  return true;
}

async function pickInput(sender: WebContents): Promise<{ inputPath: string; suggestedOutputPath: string } | null> {
  const parent = BrowserWindow.fromWebContents(sender);
  const options = {
    title: "选择要转写的音频",
    properties: ["openFile"] as Array<"openFile">,
    filters: [
      { name: "音频和视频", extensions: ["m4a", "mp3", "wav", "flac", "ogg", "aac", "mp4", "webm", "mov"] },
      { name: "所有文件", extensions: ["*"] },
    ],
  };
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return null;
  const inputPath = result.filePaths[0];
  approvedInputs.set(sender, path.normalize(inputPath));
  const parsed = path.parse(inputPath);
  return { inputPath, suggestedOutputPath: path.join(parsed.dir, `${parsed.name} 转写.md`) };
}

async function pickOutput(sender: WebContents, request?: { suggestedPath?: string; format?: string }): Promise<string | null> {
  const parent = BrowserWindow.fromWebContents(sender);
  const format = normalizeFormat(request?.format);
  const extension = `.${format}`;
  const suggestedPath = request?.suggestedPath;
  const defaultPath = suggestedPath && path.isAbsolute(suggestedPath)
    ? path.join(path.dirname(suggestedPath), `${path.parse(suggestedPath).name}${extension}`)
    : `转写结果${extension}`;
  const formatNames: Record<OfflineTranscriptionFormat, string> = { md: "Markdown 文档", txt: "纯文本文档", docx: "Word 文档" };
  const options = {
    title: "选择转写结果保存位置",
    defaultPath,
    filters: [{ name: formatNames[format], extensions: [format] }],
  };
  const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;
  const parsed = path.parse(result.filePath);
  const outputPath = parsed.ext.toLowerCase() === extension ? result.filePath : path.join(parsed.dir, `${parsed.name}${extension}`);
  approvedOutputs.set(sender, path.normalize(outputPath));
  return outputPath;
}

export async function startOfflineTranscription(
  sender: WebContents,
  request: StartRequest,
  isCallActive: () => boolean,
  isAsrTestActive: () => boolean,
): Promise<{ ok: boolean; error?: string }> {
  if (isOfflineTranscriptionActive()) return { ok: false, error: "已有长音频正在转写" };
  if (isCallActive()) return { ok: false, error: "语音通话正在进行，请先结束通话" };
  if (isAsrTestActive()) return { ok: false, error: "麦克风识别测试正在进行，请先停止测试" };

  try {
    const inputPath = validatePath(request.inputPath, "输入文件");
    const outputPath = validatePath(request.outputPath, "输出文件");
    const format = normalizeFormat(request.format);
    const includeTimestamps = request.includeTimestamps !== false;
    if (approvedInputs.get(sender)?.toLowerCase() !== inputPath.toLowerCase()) throw new Error("请通过“选择音频”选择输入文件");
    if (approvedOutputs.get(sender)?.toLowerCase() !== outputPath.toLowerCase()) throw new Error("请通过“选择保存位置”指定输出文件");
    if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) throw new Error("输入音频不存在");
    if (path.extname(outputPath).toLowerCase() !== `.${format}`) throw new Error(`输出文件扩展名必须是 .${format}`);
    if (path.resolve(inputPath).toLowerCase() === path.resolve(outputPath).toLowerCase()) throw new Error("输出位置不能覆盖输入音频");
    const hotwords = Array.isArray(request.hotwords)
      ? request.hotwords.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 200)
      : [];
    owner = sender;
    controller = new AbortController();
    publish({ state: "decoding", message: "正在准备本地转写…", inputPath, outputPath, format, includeTimestamps });
    void transcribeLocalAudioFile({
      inputPath,
      outputPath,
      appRoot: app.getAppPath(),
      userDataPath: app.getPath("userData"),
      profile: normalizeProfile(request.profile),
      language: normalizeLanguage(request.language),
      hotwords,
      format,
      includeTimestamps,
      overwrite: true,
      signal: controller.signal,
      onProgress: (progress) => publish({
        state: progress.phase,
        message: progress.message,
        inputPath,
        outputPath,
        completedSegments: progress.completedSegments,
        totalSegments: progress.totalSegments,
        format,
        includeTimestamps,
      }),
    }).then((result) => {
      publish({
        state: "completed",
        message: `转写完成，共 ${result.segmentCount} 段`,
        inputPath,
        outputPath: result.outputPath,
        completedSegments: result.segmentCount,
        totalSegments: result.segmentCount,
        format,
        includeTimestamps,
      });
    }).catch((error) => {
      const cancelled = error instanceof Error && error.name === "AbortError";
      publish({ state: cancelled ? "cancelled" : "error", message: cancelled ? "转写已取消；若已有识别内容，会保留临时文本" : (error instanceof Error ? error.message : String(error)), inputPath, outputPath, format, includeTimestamps });
    }).finally(() => { controller = null; });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function registerOfflineTranscriptionIpc(isCallActive: () => boolean, isAsrTestActive: () => boolean): void {
  ipcMain.handle(IPC.ASR_TRANSCRIPTION_PICK_INPUT, (event) => pickInput(event.sender));
  ipcMain.handle(IPC.ASR_TRANSCRIPTION_PICK_OUTPUT, (event, request?: { suggestedPath?: string; format?: string }) => pickOutput(event.sender, request));
  ipcMain.handle(IPC.ASR_TRANSCRIPTION_GET_STATE, (event) => { owner = event.sender; return getOfflineTranscriptionState(); });
  ipcMain.handle(IPC.ASR_TRANSCRIPTION_START, (event, request: StartRequest) => startOfflineTranscription(event.sender, request, isCallActive, isAsrTestActive));
  ipcMain.handle(IPC.ASR_TRANSCRIPTION_CANCEL, () => cancelOfflineTranscription());
  ipcMain.handle(IPC.ASR_TRANSCRIPTION_OPEN_OUTPUT, async (_event, outputPath?: string) => {
    if (!outputPath || snapshot.state !== "completed" || snapshot.outputPath?.toLowerCase() !== path.normalize(outputPath).toLowerCase() || !fs.existsSync(outputPath)) {
      return { ok: false, error: "转写结果不存在" };
    }
    const error = await shell.openPath(outputPath);
    return error ? { ok: false, error } : { ok: true };
  });
}
