import "../ui/base.css";
import "./work.css";
import "../ui/theme";
import {
  initCodeBlockController,
  initMarkdownRenderer,
  renderMarkdown,
} from "../chat/markdown/init";
import type {
  WorkAttachment,
  WorkMessage,
  WorkPlan,
  WorkRunEvent,
  WorkSession,
  WorkSessionMeta,
  WorkRunAttachment,
} from "../../shared/work-types";

type PendingAttachment = {
  name: string;
  kind: "document" | "image" | "unsupported";
  filePath?: string;
  mime?: string;
  reason?: string;
};

type ProcessedDocument = {
  name: string;
  kind: "text" | "indexed" | "empty" | "unsupported" | "error";
  text?: string;
  reason?: string;
  retrievedChunks?: Array<{ text: string; fileName?: string; chunkIndex?: number }>;
};

interface WorkApi {
  minimize(): void;
  close(): void;
  toggleMaximize(): void;
  listSessions(): Promise<WorkSessionMeta[]>;
  getSession(id: string): Promise<WorkSession | null>;
  createSession(title?: string): Promise<WorkSession>;
  renameSession(id: string, title: string): Promise<WorkSession | null>;
  deleteSession(id: string): Promise<boolean>;
  openFolder(): Promise<void>;
  openModelSettings(): void;
  listMemory(): Promise<Array<{ id: string; content: string; updatedAt: number }>>;
  deleteMemory(id: string): Promise<boolean>;
  ingestDroppedFiles(files: File[]): Promise<PendingAttachment[]>;
  ingestPastedImage(base64: string, mime: string): Promise<PendingAttachment | null>;
  processDocuments(filePaths: string[], query: string): Promise<ProcessedDocument[]>;
  captionImage(filePath: string): Promise<{ ok: boolean; caption?: string; error?: string }>;
  run(sessionId: string, text: string, attachments?: WorkRunAttachment[]): Promise<{ ok: boolean; error?: string }>;
  cancel(sessionId: string): Promise<boolean>;
  onEvent(callback: (event: WorkRunEvent) => void): () => void;
}

interface WorkPermissionApi {
  onPermissionApprovalRequest(callback: (request: {
    id: string;
    toolName: string;
    toolDescription: string;
    args: Record<string, unknown>;
    notifyOnly?: boolean;
  }) => void): () => void;
  resolvePermissionApproval(id: string, allowed: boolean): Promise<{ ok: boolean }>;
}

declare global {
  interface Window {
    work?: WorkApi;
    settings?: WorkPermissionApi;
  }
}

const api = window.work;
if (!api) throw new Error("Work API unavailable");

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const sessionList = byId<HTMLDivElement>("session-list");
const messagesEl = byId<HTMLDivElement>("messages");
const emptyState = byId<HTMLDivElement>("empty-state");
const sessionTitle = byId<HTMLHeadingElement>("session-title");
const inputEl = byId<HTMLTextAreaElement>("work-input");
const composer = byId<HTMLFormElement>("composer");
const sendBtn = byId<HTMLButtonElement>("send-btn");
const cancelBtn = byId<HTMLButtonElement>("cancel-btn");
const runtimeStatus = byId<HTMLDivElement>("runtime-status");
const planView = byId<HTMLDivElement>("plan-view");
const activityView = byId<HTMLDivElement>("activity-view");
const artifactView = byId<HTMLDivElement>("artifact-view");
const memoryDialog = byId<HTMLDialogElement>("memory-dialog");
const memoryList = byId<HTMLDivElement>("memory-list");
const fileInput = byId<HTMLInputElement>("file-input");
const attachBtn = byId<HTMLButtonElement>("attach-btn");
const fileTags = byId<HTMLDivElement>("file-tags");
const workShell = document.querySelector<HTMLElement>(".work-shell");
const sessionRail = byId<HTMLElement>("session-rail");
const sessionRailToggle = byId<HTMLButtonElement>("session-rail-toggle");

initMarkdownRenderer();
initCodeBlockController(messagesEl);

let activeSession: WorkSession | null = null;
let sessions: WorkSessionMeta[] = [];
let running = false;
let attachedFiles: PendingAttachment[] = [];

function setSessionRailVisible(visible: boolean): void {
  sessionRail.hidden = !visible;
  workShell?.classList.toggle("is-rail-hidden", !visible);
  sessionRailToggle.setAttribute("aria-expanded", String(visible));
  sessionRailToggle.setAttribute("aria-label", visible ? "隐藏工作会话" : "显示工作会话");
}

sessionRailToggle.addEventListener("click", () => setSessionRailVisible(sessionRail.hidden));

function formatTime(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function renderSessionList(): void {
  sessionList.replaceChildren();
  for (const session of sessions) {
    const button = document.createElement("button");
    button.className = `session-item${activeSession?.id === session.id ? " is-active" : ""}`;
    const title = document.createElement("strong");
    title.textContent = session.title;
    const meta = document.createElement("span");
    meta.textContent = `${session.status} · ${formatTime(session.updatedAt)}`;
    button.append(title, meta);
    button.addEventListener("click", () => void openSession(session.id));
    button.addEventListener("contextmenu", async (event) => {
      event.preventDefault();
      if (!confirm(`删除 Work 会话“${session.title}”？`)) return;
      await api.deleteSession(session.id);
      if (activeSession?.id === session.id) activeSession = null;
      await refreshSessions();
    });
    sessionList.appendChild(button);
  }
}

function renderMessages(): void {
  messagesEl.querySelectorAll(".message").forEach((node) => node.remove());
  const messages = activeSession?.messages.filter((message) => message.role !== "system") ?? [];
  emptyState.hidden = messages.length > 0;
  for (const message of messages) appendMessageElement(message);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendMessageElement(message: WorkMessage): void {
  if (message.role === "system") return;
  if (messagesEl.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)) return;
  const wrapper = document.createElement("article");
  wrapper.className = `message message--${message.role === "assistant" ? "assistant" : "user"}`;
  wrapper.dataset.messageId = message.id;
  const meta = document.createElement("div");
  meta.className = "message__meta";
  meta.textContent = `${message.role === "assistant" ? "Cyrene Work" : "你"} · ${formatTime(message.createdAt)}`;
  const body = document.createElement("div");
  body.className = `message__body${message.role === "assistant" ? " msg__bubble" : ""}`;
  if (message.role === "assistant") {
    const rendered = renderMarkdown(message.content);
    if (rendered.kind === "html") {
      const template = document.createElement("template");
      template.innerHTML = rendered.html;
      body.replaceChildren(template.content.cloneNode(true));
      if (body.querySelector("pre, table, .katex-display")) body.classList.add("has-rich-content");
    } else {
      body.textContent = rendered.text;
    }
  } else {
    body.textContent = message.content;
  }
  if (message.attachments?.length) body.appendChild(renderMessageAttachments(message.attachments));
  wrapper.append(meta, body);
  messagesEl.appendChild(wrapper);
  emptyState.hidden = true;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMessageAttachments(attachments: WorkAttachment[]): HTMLElement {
  const list = document.createElement("div");
  list.className = "message__attachments";
  for (const attachment of attachments) {
    const tag = document.createElement("span");
    tag.className = `message__attachment${attachment.status === "error" ? " is-error" : ""}`;
    const type = attachment.kind === "image" ? "图片" : attachment.kind === "document" ? "文档" : "不支持";
    tag.textContent = `${type} · ${attachment.name}`;
    list.appendChild(tag);
  }
  return list;
}

function updateFileTags(): void {
  fileTags.replaceChildren();
  attachBtn.classList.toggle("has-file", attachedFiles.length > 0);
  attachedFiles.forEach((attachment, index) => {
    const tag = document.createElement("div");
    tag.className = "composer__file-tag";
    const label = document.createElement("span");
    const type = attachment.kind === "image" ? "图片" : attachment.kind === "document" ? "文档" : "不支持";
    label.textContent = `${type} · ${attachment.name}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.ariaLabel = `移除 ${attachment.name}`;
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      attachedFiles.splice(index, 1);
      updateFileTags();
    });
    tag.append(label, remove);
    fileTags.appendChild(tag);
  });
}

async function ingestFiles(files: File[]): Promise<void> {
  if (files.length === 0 || running) return;
  attachBtn.disabled = true;
  try {
    const results = await api.ingestDroppedFiles(files);
    attachedFiles = [...attachedFiles, ...results];
    updateFileTags();
  } catch (error) {
    addActivity(`附件添加失败：${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    attachBtn.disabled = false;
    fileInput.value = "";
  }
}

async function prepareAttachments(files: PendingAttachment[], query: string): Promise<WorkRunAttachment[]> {
  const prepared: WorkRunAttachment[] = [];
  const documents = files.filter((file) => file.kind === "document" && file.filePath);
  if (documents.length > 0) {
    const results = await api.processDocuments(documents.map((file) => file.filePath!), query);
    for (const result of results) {
      const chunks = result.retrievedChunks?.map((chunk) => {
        const label = chunk.fileName
          ? `${chunk.fileName}${typeof chunk.chunkIndex === "number" ? ` #${chunk.chunkIndex + 1}` : ""}`
          : result.name;
        return `[${label}] ${chunk.text}`;
      }).join("\n");
      const content = result.kind === "text" ? result.text : chunks;
      prepared.push({
        name: result.name,
        kind: "document",
        status: content ? "done" : "error",
        ...(content ? { content } : {}),
        ...(!content ? { reason: result.reason || "文档为空或无法读取" } : {}),
      });
    }
  }

  for (const file of files) {
    if (file.kind === "image" && file.filePath) {
      const result = await api.captionImage(file.filePath);
      prepared.push({
        name: file.name,
        kind: "image",
        status: result.ok && result.caption ? "done" : "error",
        ...(result.caption ? { content: result.caption } : {}),
        ...(!result.caption ? { reason: result.error || "图片分析失败" } : {}),
      });
    } else if (file.kind === "unsupported") {
      prepared.push({ name: file.name, kind: "unsupported", status: "error", reason: file.reason || "不支持的附件格式" });
    }
  }
  return prepared;
}

function renderPlan(plan?: WorkPlan): void {
  planView.replaceChildren();
  if (!plan) {
    planView.className = "plan-view muted";
    planView.textContent = "尚未开始";
    return;
  }
  planView.className = "plan-view";
  for (const step of plan.steps) {
    const row = document.createElement("div");
    row.className = "plan-step";
    row.dataset.status = step.status;
    const marker = document.createElement("span");
    marker.className = "plan-step__marker";
    marker.setAttribute("aria-hidden", "true");
    const content = document.createElement("span");
    const label = step.status === "completed" ? "完成" : step.status === "running" ? "进行中" : step.status === "failed" ? "失败" : "待处理";
    content.textContent = `${label} · ${step.objective}`;
    row.append(marker, content);
    planView.appendChild(row);
  }
}

function renderArtifacts(session: WorkSession | null): void {
  artifactView.replaceChildren();
  if (!session?.artifacts.length) {
    artifactView.className = "artifact-view muted";
    artifactView.textContent = "暂无产物";
    return;
  }
  artifactView.className = "artifact-view";
  for (const artifact of session.artifacts) {
    const row = document.createElement("div");
    row.className = "artifact-item";
    row.title = artifact.path;
    row.textContent = artifact.name;
    artifactView.appendChild(row);
  }
}

function addActivity(text: string, error = false): void {
  if (activityView.classList.contains("muted")) {
    activityView.replaceChildren();
    activityView.classList.remove("muted");
  }
  const row = document.createElement("div");
  row.className = `activity-item${error ? " is-error" : ""}`;
  row.textContent = text;
  activityView.prepend(row);
}

async function refreshSessions(): Promise<void> {
  sessions = await api.listSessions();
  if (!activeSession && sessions.length) activeSession = await api.getSession(sessions[0].id);
  if (!activeSession) activeSession = await api.createSession();
  sessions = await api.listSessions();
  renderSessionList();
  renderCurrentSession();
}

async function openSession(id: string): Promise<void> {
  if (running) return;
  activeSession = await api.getSession(id);
  renderSessionList();
  renderCurrentSession();
}

function renderCurrentSession(): void {
  sessionTitle.textContent = activeSession?.title ?? "新工作";
  renderMessages();
  renderPlan(activeSession?.plan);
  renderArtifacts(activeSession);
}

byId<HTMLButtonElement>("new-session-btn").addEventListener("click", async () => {
  if (running) return;
  activeSession = await api.createSession();
  await refreshSessions();
  inputEl.focus();
});

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if ((!text && attachedFiles.length === 0) || !activeSession || running) return;
  const filesForThisTurn = [...attachedFiles];
  running = true;
  sendBtn.disabled = true;
  attachBtn.disabled = true;
  cancelBtn.hidden = false;
  inputEl.value = "";
  attachedFiles = [];
  updateFileTags();
  const optimistic: WorkMessage = {
    id: `optimistic-${Date.now()}`,
    role: "user",
    content: text,
    createdAt: Date.now(),
    attachments: filesForThisTurn.map((file) => ({
      name: file.name,
      kind: file.kind,
      status: file.kind === "unsupported" ? "error" : "done",
    })),
  };
  appendMessageElement(optimistic);
  runtimeStatus.textContent = filesForThisTurn.length > 0 ? "正在读取附件" : "正在执行";
  try {
    const attachments = await prepareAttachments(filesForThisTurn, text);
    runtimeStatus.textContent = "正在执行";
    const result = await api.run(activeSession.id, text, attachments);
    if (!result.ok && result.error) addActivity(result.error, true);
  } catch (error) {
    addActivity(error instanceof Error ? error.message : String(error), true);
    running = false;
    sendBtn.disabled = false;
    attachBtn.disabled = false;
    cancelBtn.hidden = true;
    runtimeStatus.textContent = "执行失败";
  }
});

inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 160)}px`;
});

inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

attachBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files?.length) void ingestFiles(Array.from(fileInput.files));
});

let dragDepth = 0;
document.addEventListener("dragenter", (event) => {
  event.preventDefault();
  dragDepth += 1;
  workShell?.classList.add("is-drag-over");
});
document.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
});
document.addEventListener("dragleave", (event) => {
  event.preventDefault();
  dragDepth -= 1;
  if (dragDepth <= 0) {
    dragDepth = 0;
    workShell?.classList.remove("is-drag-over");
  }
});
document.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  workShell?.classList.remove("is-drag-over");
  if (event.dataTransfer?.files.length) void ingestFiles(Array.from(event.dataTransfer.files));
});

document.addEventListener("paste", async (event) => {
  if (running) return;
  const images = Array.from(event.clipboardData?.items ?? [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  if (images.length === 0) return;
  event.preventDefault();
  for (const file of images) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      const attachment = await api.ingestPastedImage(btoa(binary), file.type);
      if (attachment) attachedFiles.push(attachment);
    } catch (error) {
      addActivity(`粘贴图片失败：${error instanceof Error ? error.message : String(error)}`, true);
    }
  }
  updateFileTags();
});

cancelBtn.addEventListener("click", () => {
  if (activeSession) void api.cancel(activeSession.id);
});

api.onEvent(async (event) => {
  switch (event.type) {
    case "status":
      runtimeStatus.textContent = event.text;
      break;
    case "plan":
      renderPlan(event.plan);
      break;
    case "tool_start":
      addActivity(`调用：${event.label}`);
      break;
    case "tool_end":
      addActivity(`${event.ok ? "完成" : "失败"}：${event.toolId} · ${event.summary}`, !event.ok);
      break;
    case "message":
      appendMessageElement(event.message);
      break;
    case "error":
      addActivity(event.message, true);
      runtimeStatus.textContent = "执行失败";
      break;
    case "done":
      running = false;
      sendBtn.disabled = false;
      attachBtn.disabled = false;
      cancelBtn.hidden = true;
      activeSession = await api.getSession(event.sessionId);
      await refreshSessions();
      runtimeStatus.textContent = activeSession?.status === "failed"
        ? "执行失败"
        : activeSession?.status === "cancelled" ? "已取消" : "就绪";
      break;
  }
});

window.settings?.onPermissionApprovalRequest((request) => {
  const detail = Object.keys(request.args ?? {}).length
    ? `\n\n参数：${JSON.stringify(request.args, null, 2).slice(0, 1_500)}`
    : "";
  const prompt = request.notifyOnly
    ? `Work 即将执行：${request.toolName}\n${request.toolDescription}${detail}\n\n是否允许继续？`
    : `Work 请求执行：${request.toolName}\n${request.toolDescription}${detail}\n\n是否授权？`;
  const allowed = confirm(prompt);
  void window.settings?.resolvePermissionApproval(request.id, allowed);
});

byId<HTMLButtonElement>("memory-btn").addEventListener("click", async () => {
  const entries = await api.listMemory();
  memoryList.replaceChildren();
  if (!entries.length) memoryList.textContent = "暂无 Work 记忆。";
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "memory-item";
    const content = document.createElement("p");
    content.textContent = entry.content;
    const remove = document.createElement("button");
    remove.textContent = "删除";
    remove.addEventListener("click", async () => {
      await api.deleteMemory(entry.id);
      row.remove();
    });
    row.append(content, remove);
    memoryList.appendChild(row);
  }
  memoryDialog.showModal();
});

byId<HTMLButtonElement>("model-settings-btn").addEventListener("click", () => api.openModelSettings());
byId<HTMLButtonElement>("memory-close-btn").addEventListener("click", () => memoryDialog.close());
byId<HTMLButtonElement>("folder-btn").addEventListener("click", () => void api.openFolder());
byId<HTMLButtonElement>("minimize-btn").addEventListener("click", () => api.minimize());
byId<HTMLButtonElement>("maximize-btn").addEventListener("click", () => api.toggleMaximize());
byId<HTMLButtonElement>("close-btn").addEventListener("click", () => api.close());

void refreshSessions();
