import { BrowserWindow, ipcMain, type WebContents } from "electron";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { IPC } from "../../shared/ipc-channels";
import type { WorkAttachment, WorkMessage, WorkRunAttachment, WorkRunEvent } from "../../shared/work-types";
import type { ToolDefinition } from "../orchestrator/tool-registry";
import type { VendorConfig } from "../orchestrator/vendors";
import { decodeTextBuffer, hasUtf16Bom, isBinary, isDocumentExt } from "../rag/file-ingest";
import { runWorkAgent } from "./work-agent";
import { deleteWorkMemory, listWorkMemory } from "./work-memory-store";
import {
  appendWorkMessage,
  createWorkSession,
  deleteWorkSession,
  getWorkSession,
  listWorkSessions,
  openWorkFolder,
  renameWorkSession,
  updateWorkExecutionState,
} from "./work-store";

export interface RegisterWorkIpcDeps {
  createWorkWindow: () => void;
  getWorkWindow: () => BrowserWindow | null;
  resolveModelConfig: () => VendorConfig;
  getTools: () => ToolDefinition[];
  loadPrompt: (name: "system" | "style" | "router" | "plan" | "actionGate") => string;
}

const activeRuns = new Map<string, AbortController>();
const MAX_ATTACHMENT_CONTEXT_CHARS = 60_000;
const MAX_WORK_DOCUMENT_BYTES = 5 * 1024 * 1024;

function processWorkDocuments(value: unknown): Array<Record<string, unknown>> {
  const paths = value && typeof value === "object" && Array.isArray((value as { filePaths?: unknown }).filePaths)
    ? (value as { filePaths: unknown[] }).filePaths.filter((item): item is string => typeof item === "string").slice(0, 12)
    : [];
  let remaining = MAX_ATTACHMENT_CONTEXT_CHARS;
  return paths.map((filePath) => {
    const name = path.basename(filePath);
    try {
      if (!isDocumentExt(path.extname(filePath))) return { name, kind: "unsupported", reason: "不支持的文档格式" };
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return { name, kind: "error", reason: "附件不是文件" };
      if (stat.size > MAX_WORK_DOCUMENT_BYTES) return { name, kind: "error", reason: "附件超过 5 MB 限制" };
      const buffer = fs.readFileSync(filePath);
      if (!hasUtf16Bom(buffer) && isBinary(buffer)) return { name, kind: "unsupported", reason: "附件不是文本文件" };
      const text = decodeTextBuffer(buffer).trim();
      if (!text) return { name, kind: "empty", reason: "文档为空" };
      const content = text.slice(0, remaining);
      remaining -= content.length;
      return content
        ? { name, kind: "text", text: content }
        : { name, kind: "error", reason: "附件总内容超过 60000 字符限制" };
    } catch (error) {
      return { name, kind: "error", reason: error instanceof Error ? error.message : String(error) };
    }
  });
}

function normalizeAttachments(value: unknown): WorkRunAttachment[] {
  if (!Array.isArray(value)) return [];
  let remaining = MAX_ATTACHMENT_CONTEXT_CHARS;
  return value.slice(0, 12).flatMap((item): WorkRunAttachment[] => {
    if (!item || typeof item !== "object") return [];
    const source = item as Record<string, unknown>;
    const kind = source.kind;
    if (kind !== "document" && kind !== "image" && kind !== "unsupported") return [];
    const name = typeof source.name === "string" ? source.name.trim().slice(0, 260) : "";
    if (!name) return [];
    const status = source.status === "done" ? "done" : "error";
    const rawContent = typeof source.content === "string" ? source.content : "";
    const content = rawContent.slice(0, remaining);
    remaining -= content.length;
    return [{
      name,
      kind,
      status,
      ...(content ? { content } : {}),
      ...(typeof source.reason === "string" ? { reason: source.reason.slice(0, 1_000) } : {}),
    }];
  });
}

function buildAttachmentContext(attachments: WorkRunAttachment[]): string | undefined {
  if (attachments.length === 0) return undefined;
  return attachments.map((attachment) => {
    if (attachment.status === "done" && attachment.content) {
      return `[${attachment.kind}: ${attachment.name}]\n${attachment.content}`;
    }
    return `[${attachment.kind}: ${attachment.name}] 无法读取：${attachment.reason || "附件处理失败"}`;
  }).join("\n\n");
}

function send(sender: WebContents, event: WorkRunEvent): void {
  if (!sender.isDestroyed()) sender.send(IPC.WORK_EVENT, event);
}

export function registerWorkIpc(deps: RegisterWorkIpcDeps): void {
  ipcMain.on(IPC.SIDEBAR_OPEN_WORK, () => deps.createWorkWindow());
  ipcMain.on(IPC.WORK_MINIMIZE, () => deps.getWorkWindow()?.minimize());
  ipcMain.on(IPC.WORK_CLOSE, () => deps.getWorkWindow()?.close());
  ipcMain.on(IPC.WORK_TOGGLE_MAXIMIZE, () => {
    const win = deps.getWorkWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle(IPC.WORK_IS_MAXIMIZED, () => deps.getWorkWindow()?.isMaximized() ?? false);

  ipcMain.handle(IPC.WORK_SESSIONS_LIST, () => listWorkSessions());
  ipcMain.handle(IPC.WORK_SESSIONS_GET, (_event, id: string) => getWorkSession(id));
  ipcMain.handle(IPC.WORK_SESSIONS_CREATE, (_event, title?: string) => createWorkSession(title));
  ipcMain.handle(IPC.WORK_SESSIONS_RENAME, (_event, payload: { id: string; title: string }) => (
    renameWorkSession(payload.id, payload.title)
  ));
  ipcMain.handle(IPC.WORK_SESSIONS_DELETE, (_event, id: string) => {
    activeRuns.get(id)?.abort();
    activeRuns.delete(id);
    return deleteWorkSession(id);
  });
  ipcMain.handle(IPC.WORK_OPEN_FOLDER, () => openWorkFolder());

  ipcMain.handle(IPC.WORK_MEMORY_LIST, () => listWorkMemory());
  ipcMain.handle(IPC.WORK_MEMORY_DELETE, (_event, id: string) => deleteWorkMemory(id));
  ipcMain.handle(IPC.WORK_PROCESS_DOCUMENTS, (_event, payload: unknown) => processWorkDocuments(payload));

  ipcMain.handle(IPC.WORK_CANCEL, (_event, sessionId: string) => {
    const controller = activeRuns.get(sessionId);
    if (!controller) return false;
    controller.abort();
    return true;
  });

  ipcMain.handle(IPC.WORK_RUN, async (event, payload: { sessionId: string; text: string; attachments?: unknown }) => {
    const text = payload.text?.trim();
    const attachments = normalizeAttachments(payload.attachments);
    if (!text && attachments.length === 0) throw new Error("Work request cannot be empty");
    if (activeRuns.has(payload.sessionId)) throw new Error("This Work session is already running");
    const session = getWorkSession(payload.sessionId);
    if (!session) throw new Error("Work session not found");
    const config = deps.resolveModelConfig();
    const userMessage: WorkMessage = {
      id: randomUUID(),
      role: "user",
      content: text,
      createdAt: Date.now(),
      attachments: attachments.map(({ name, kind, status }): WorkAttachment => ({ name, kind, status })),
    };
    const nextSession = appendWorkMessage(session.id, userMessage);
    if (!nextSession) throw new Error("Unable to update Work session");
    const controller = new AbortController();
    activeRuns.set(session.id, controller);
    try {
      await runWorkAgent({
        session: nextSession,
        userText: text || "请处理附件",
        attachmentContext: buildAttachmentContext(attachments),
        config,
        tools: deps.getTools(),
        prompts: {
          system: deps.loadPrompt("system"),
          style: deps.loadPrompt("style"),
          router: deps.loadPrompt("router"),
          plan: deps.loadPrompt("plan"),
          actionGate: deps.loadPrompt("actionGate"),
        },
        signal: controller.signal,
        approvalWebContentsId: event.sender.id,
        onEvent: (workEvent) => send(event.sender, workEvent),
      });
      return { ok: true };
    } catch (error) {
      if (controller.signal.aborted) {
        const current = getWorkSession(session.id);
        if (current?.plan) {
          current.plan.status = "cancelled";
          current.plan.updatedAt = Date.now();
        }
        updateWorkExecutionState(session.id, { status: "cancelled", plan: current?.plan });
        send(event.sender, { type: "status", status: "cancelled", text: "已取消" });
        send(event.sender, { type: "done", sessionId: session.id });
        return { ok: true };
      }
      const message = error instanceof Error ? error.message : String(error);
      updateWorkExecutionState(session.id, { status: "failed" });
      send(event.sender, { type: "error", message });
      send(event.sender, { type: "done", sessionId: session.id });
      return { ok: false, error: message };
    } finally {
      activeRuns.delete(session.id);
    }
  });
}
