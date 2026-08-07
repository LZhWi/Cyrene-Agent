import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions, type WebContents } from "electron";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { IPC } from "../../shared/ipc-channels";
import type { WorkAttachment, WorkMessage, WorkRunAttachment, WorkRunEvent, WorkSessionMode } from "../../shared/work-types";
import type { ToolDefinition } from "../orchestrator/tool-registry";
import type { VendorConfig } from "../orchestrator/vendors";
import { decodeTextBuffer, hasUtf16Bom, isBinary, isDocumentExt } from "../rag/file-ingest";
import { buildDirTools } from "./dir-tools";
import { runWorkAgent } from "./work-agent";
import { deleteWorkMemory, listWorkMemory } from "./work-memory-store";
import {
  appendWorkMessage,
  bindWorkSessionDir,
  createWorkSession,
  deleteWorkSession,
  getWorkSession,
  listWorkSessions,
  openWorkFolder,
  renameWorkSession,
  updateWorkExecutionState,
  workSessionMode,
} from "./work-store";

export interface RegisterWorkIpcDeps {
  /** 侧边栏"工作"入口：打开 chat 窗口并切到 Work 视图（Work 视图内嵌在 chat 窗口）。 */
  openChatWorkView: () => void;
  resolveModelConfig: () => VendorConfig;
  getTools: () => ToolDefinition[];
  /** mode 用于选择模式专属 system prompt（code/learn），缺省走通用 work prompt。 */
  loadPrompt: (name: "system" | "style" | "router" | "plan" | "actionGate", mode?: WorkSessionMode) => string;
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

/** 把渲染层的创建入参归一化：兼容旧版字符串 title 调用。 */
function normalizeCreateSessionPayload(payload: unknown): { title?: string; mode?: WorkSessionMode; boundDir?: string } {
  if (typeof payload === "string") return { title: payload };
  if (!payload || typeof payload !== "object") return {};
  const source = payload as Record<string, unknown>;
  const mode = source.mode === "code" || source.mode === "learn" ? source.mode : undefined;
  const boundDir = typeof source.boundDir === "string" && source.boundDir.trim() ? source.boundDir.trim() : undefined;
  return {
    ...(typeof source.title === "string" && source.title.trim() ? { title: source.title } : {}),
    ...(mode ? { mode } : {}),
    ...(mode && boundDir ? { boundDir } : {}),
  };
}

/** code/learn 会话的模式上下文块：告知绑定目录、可用文件工具与只读约束。 */
function buildModeContextBlock(mode: WorkSessionMode, boundDir?: string): string {
  if (mode === "work" || !boundDir) return "";
  const role = mode === "code"
    ? "当前是 Code 模式：你正在协助用户理解和分析一个代码项目。"
    : "当前是 Learn 模式：你正在陪伴用户学习，这个目录是用户的笔记库（Obsidian Vault）和学习材料。";
  return `[模式上下文]
${role}
本会话绑定目录：${boundDir}
你可以使用以下只读文件工具访问该目录内的内容：
- file_list：列出子目录结构
- file_read：读取文本文件（可分段）
- file_search：按内容搜索文件行
注意：所有路径参数都使用相对绑定目录的路径。当前阶段你只能读取，不能创建、修改或删除任何文件；需要改动时只给出具体建议。`;
}

export function registerWorkIpc(deps: RegisterWorkIpcDeps): void {
  ipcMain.on(IPC.SIDEBAR_OPEN_WORK, () => deps.openChatWorkView());

  ipcMain.handle(IPC.WORK_SESSIONS_LIST, () => listWorkSessions());
  ipcMain.handle(IPC.WORK_SESSIONS_GET, (_event, id: string) => getWorkSession(id));
  ipcMain.handle(IPC.WORK_SESSIONS_CREATE, (_event, payload: unknown) => {
    const { title, mode, boundDir } = normalizeCreateSessionPayload(payload);
    return createWorkSession(title, mode, boundDir);
  });
  ipcMain.handle(IPC.WORK_SESSIONS_RENAME, (_event, payload: { id: string; title: string }) => (
    renameWorkSession(payload.id, payload.title)
  ));
  ipcMain.handle(IPC.WORK_SESSIONS_DELETE, (_event, id: string) => {
    activeRuns.get(id)?.abort();
    activeRuns.delete(id);
    return deleteWorkSession(id);
  });
  // 目录绑定与会话创建解耦：code/learn 会话建好后可随时绑定/更换目录
  ipcMain.handle(IPC.WORK_SESSIONS_BIND_DIR, (_event, payload: { id: string; boundDir?: string }) => (
    bindWorkSessionDir(payload.id, payload.boundDir)
  ));
  ipcMain.handle(IPC.WORK_OPEN_FOLDER, () => openWorkFolder());
  // 为 code/learn 会话选择绑定目录：返回选中的绝对路径，取消返回 null。
  // 父窗口优先取发起方（从 Chat 窗口内嵌视图发起），兜底当前聚焦窗口。
  ipcMain.handle(IPC.WORK_SELECT_DIR, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
    const options: OpenDialogOptions = { title: "选择要绑定的目录", properties: ["openDirectory"] };
    const result = await (win && !win.isDestroyed()
      ? dialog.showOpenDialog(win, options)
      : dialog.showOpenDialog(options)
    ).catch(() => null);
    if (!result || result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

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
    // code/learn 会话：绑定目录有效时注入沙箱只读文件工具（不进全局注册表）。
    const sessionMode = workSessionMode(nextSession);
    const boundDirUsable = Boolean(nextSession.boundDir && fs.existsSync(nextSession.boundDir) && fs.statSync(nextSession.boundDir).isDirectory());
    const tools: ToolDefinition[] = [
      ...deps.getTools(),
      ...(sessionMode !== "work" && boundDirUsable ? buildDirTools(nextSession.boundDir!) : []),
    ];
    const modeContext = sessionMode !== "work" && boundDirUsable
      ? buildModeContextBlock(sessionMode, nextSession.boundDir)
      : sessionMode !== "work"
        ? `[模式上下文]\n本会话未绑定有效目录，文件工具不可用。请提醒用户在创建会话时选择要绑定的目录。`
        : "";
    try {
      await runWorkAgent({
        session: nextSession,
        userText: text || "请处理附件",
        attachmentContext: buildAttachmentContext(attachments),
        config,
        tools,
        prompts: {
          system: [deps.loadPrompt("system", sessionMode), modeContext].filter(Boolean).join("\n\n"),
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
