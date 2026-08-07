/**
 * Work 面板装配层：mountWorkPanel(root) 把 Work UI 挂到任意容器。
 *
 * 设计约束：
 * - 所有控件 id 带 wp- 前缀且通过 root.querySelector 查找，嵌入 Chat 窗口时
 *   不与 chat 的 #messages/#composer/#file-tags 等同名控件冲突；
 * - 例外：会话栏开关 / 运行状态 / 记忆·模型设置·目录按钮位于宿主 chat 的
 *   常驻标题栏（root 之外），按全局唯一 wp- id 从 document 查找；
 * - 拖拽/粘贴监听绑在 root 而非 document，避免与宿主页面的附件处理双触发；
 * - api.onEvent 与权限审批监听在挂载时注册一次（懒挂载保证单例），卸载不销毁。
 * 样式由宿主页面的 <link> 引入（chat/index.html），这里不重复 import。
 */
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
import {
  attachmentKindLabel,
  emptyStateCopyFor,
  formatTime,
  planStepLabel,
  prepareRunAttachments,
  sessionHintFor,
  sessionModeBadge,
  sessionsForMode,
  type PendingAttachment,
  type WorkPanelMode,
} from "./work-panel-logic";

export interface WorkApi {
  listSessions(): Promise<WorkSessionMeta[]>;
  getSession(id: string): Promise<WorkSession | null>;
  createSession(options?: string | { title?: string; mode?: "work" | "code" | "learn"; boundDir?: string }): Promise<WorkSession>;
  renameSession(id: string, title: string): Promise<WorkSession | null>;
  deleteSession(id: string): Promise<boolean>;
  openFolder(): Promise<void>;
  selectDir(): Promise<string | null>;
  bindDir(id: string, boundDir?: string): Promise<WorkSession | null>;
  openModelSettings(): void;
  listMemory(): Promise<Array<{ id: string; content: string; updatedAt: number }>>;
  deleteMemory(id: string): Promise<boolean>;
  ingestDroppedFiles(files: File[]): Promise<PendingAttachment[]>;
  ingestPastedImage(base64: string, mime: string): Promise<PendingAttachment | null>;
  processDocuments(filePaths: string[], query: string): Promise<Array<{
    name: string;
    kind: "text" | "indexed" | "empty" | "unsupported" | "error";
    text?: string;
    reason?: string;
    retrievedChunks?: Array<{ text: string; fileName?: string; chunkIndex?: number }>;
  }>>;
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

/** mountWorkPanel 返回的控制句柄：Chat 模式下拉切换 work/code/learn 时通知面板。 */
export interface WorkPanelHandle {
  /** 切换面板当前模式：会话列表按模式过滤，空态文案同步更新。 */
  setMode(mode: WorkPanelMode): void;
}

/**
 * 把 Work UI 挂到 root（root 内须包含 wp-* 前缀的面板标记）。
 * 只应调用一次：状态保留在闭包里，重复挂载会双注册事件。
 */
export function mountWorkPanel(root: HTMLElement): WorkPanelHandle {
  const api = window.work;
  if (!api) throw new Error("Work API unavailable");

  const byId = <T extends HTMLElement>(id: string): T => root.querySelector(`#${id}`) as T;
  const maybeById = <T extends HTMLElement>(id: string): T | null => root.querySelector(`#${id}`);
  // 标题栏控件位于宿主 chat 常驻标题栏（work-view root 之外），按全局唯一 wp- id 查找
  const inTitlebar = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const sessionList = byId<HTMLDivElement>("wp-session-list");
  const messagesEl = byId<HTMLDivElement>("wp-messages");
  const emptyState = byId<HTMLDivElement>("wp-empty-state");
  const sessionTitle = byId<HTMLHeadingElement>("wp-session-title");
  const inputEl = byId<HTMLTextAreaElement>("wp-input");
  const composer = byId<HTMLFormElement>("wp-composer");
  const sendBtn = byId<HTMLButtonElement>("wp-send-btn");
  const cancelBtn = byId<HTMLButtonElement>("wp-cancel-btn");
  const runtimeStatus = inTitlebar<HTMLDivElement>("wp-runtime-status");
  const planView = byId<HTMLDivElement>("wp-plan-view");
  const activityView = byId<HTMLDivElement>("wp-activity-view");
  const artifactView = byId<HTMLDivElement>("wp-artifact-view");
  const memoryDialog = byId<HTMLDialogElement>("wp-memory-dialog");
  const memoryList = byId<HTMLDivElement>("wp-memory-list");
  const fileInput = byId<HTMLInputElement>("wp-file-input");
  const attachBtn = byId<HTMLButtonElement>("wp-attach-btn");
  const fileTags = byId<HTMLDivElement>("wp-file-tags");
  const workShell = root.querySelector<HTMLElement>(".work-shell");
  const sessionRail = byId<HTMLElement>("wp-session-rail");
  const sessionRailToggle = inTitlebar<HTMLButtonElement>("wp-session-rail-toggle");
  const sessionHint = byId<HTMLParagraphElement>("wp-session-hint");
  const bindDirBtn = maybeById<HTMLButtonElement>("wp-bind-dir-btn");

  initMarkdownRenderer();
  initCodeBlockController(messagesEl);

  let activeSession: WorkSession | null = null;
  let sessions: WorkSessionMeta[] = [];
  let running = false;
  let attachedFiles: PendingAttachment[] = [];
  /** 面板当前模式：由 Chat 模式下拉通过 handle.setMode 驱动，决定会话过滤与新建会话的模式。 */
  let currentMode: WorkPanelMode = "work";

  function setSessionRailVisible(visible: boolean): void {
    sessionRail.hidden = !visible;
    workShell?.classList.toggle("is-rail-hidden", !visible);
    sessionRailToggle.setAttribute("aria-expanded", String(visible));
    sessionRailToggle.setAttribute("aria-label", visible ? "隐藏工作会话" : "显示工作会话");
  }

  sessionRailToggle.addEventListener("click", () => setSessionRailVisible(sessionRail.hidden));

  function renderSessionList(): void {
    sessionList.replaceChildren();
    for (const session of sessions) {
      const button = document.createElement("button");
      button.className = `session-item${activeSession?.id === session.id ? " is-active" : ""}`;
      const title = document.createElement("strong");
      title.textContent = session.title;
      const badge = sessionModeBadge(session.mode);
      if (badge) {
        const badgeEl = document.createElement("span");
        badgeEl.className = "session-mode-badge";
        badgeEl.textContent = badge.icon;
        badgeEl.title = badge.title;
        title.prepend(badgeEl, " ");
      }
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
      tag.textContent = `${attachmentKindLabel(attachment.kind)} · ${attachment.name}`;
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
      label.textContent = `${attachmentKindLabel(attachment.kind)} · ${attachment.name}`;
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
      content.textContent = `${planStepLabel(step.status)} · ${step.objective}`;
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
    // 会话懒创建：只列出当前模式的会话；无会话时空态引导，不自动创建
    const all = await api.listSessions();
    sessions = sessionsForMode(all, currentMode);
    if (activeSession && (activeSession.mode ?? "work") !== currentMode) activeSession = null;
    if (!activeSession && sessions.length) activeSession = await api.getSession(sessions[0].id);
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
    renderSessionHint();
    renderMessages();
    renderPlan(activeSession?.plan);
    renderArtifacts(activeSession);
    // 绑定目录按钮只在 code/learn 未绑定会话上出现
    const needBind = !!activeSession
      && (activeSession.mode === "code" || activeSession.mode === "learn")
      && !activeSession.boundDir;
    if (bindDirBtn) bindDirBtn.hidden = !needBind;
  }

  /** 空态文案随当前模式更新（strong 标题 + 非角标 span 描述）。 */
  function renderEmptyCopy(): void {
    const copy = emptyStateCopyFor(currentMode);
    const titleEl = emptyState.querySelector("strong");
    const detailEl = emptyState.querySelector("span:not(.empty-state__mark)");
    if (titleEl) titleEl.textContent = copy.title;
    if (detailEl) detailEl.textContent = copy.detail;
  }

  function renderSessionHint(): void {
    const hint = sessionHintFor(activeSession);
    sessionHint.textContent = hint.text;
    sessionHint.title = hint.title;
  }

  async function createNewSession(): Promise<void> {
    // 当前模式直接创建，不再弹三选一弹窗；目录绑定与创建解耦，
    // code/learn 会话建好后通过"绑定目录"按钮随时绑定
    activeSession = await api.createSession(
      currentMode === "work" ? undefined : { mode: currentMode },
    );
    await refreshSessions();
    inputEl.focus();
  }

  byId<HTMLButtonElement>("wp-new-session-btn").addEventListener("click", () => {
    if (running) return;
    void createNewSession();
  });

  // 目录绑定解耦：code/learn 未绑定会话随时选目录绑定（按钮显隐见 renderCurrentSession）
  bindDirBtn?.addEventListener("click", async () => {
    if (!activeSession || running) return;
    const selected = await api.selectDir();
    if (!selected) return;
    try {
      const updated = await api.bindDir(activeSession.id, selected);
      if (updated) {
        activeSession = updated;
        renderCurrentSession();
        addActivity(`已绑定目录：${selected}`);
      }
    } catch (error) {
      addActivity(`绑定目录失败：${error instanceof Error ? error.message : String(error)}`, true);
    }
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
      const attachments = await prepareRunAttachments(filesForThisTurn, api, text);
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

  // 拖拽/粘贴绑定在 root 上：嵌入 Chat 窗口时只有 Work 视图可见且焦点在面板内
  // 才会触发，不会与 Chat 自己的附件处理双触发
  let dragDepth = 0;
  root.addEventListener("dragenter", (event) => {
    event.preventDefault();
    dragDepth += 1;
    workShell?.classList.add("is-drag-over");
  });
  root.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  root.addEventListener("dragleave", (event) => {
    event.preventDefault();
    dragDepth -= 1;
    if (dragDepth <= 0) {
      dragDepth = 0;
      workShell?.classList.remove("is-drag-over");
    }
  });
  root.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    workShell?.classList.remove("is-drag-over");
    if (event.dataTransfer?.files.length) void ingestFiles(Array.from(event.dataTransfer.files));
  });

  root.addEventListener("paste", async (event) => {
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

  inTitlebar<HTMLButtonElement>("wp-memory-btn").addEventListener("click", async () => {
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

  inTitlebar<HTMLButtonElement>("wp-model-settings-btn").addEventListener("click", () => api.openModelSettings());
  byId<HTMLButtonElement>("wp-memory-close-btn").addEventListener("click", () => memoryDialog.close());
  inTitlebar<HTMLButtonElement>("wp-folder-btn").addEventListener("click", () => void api.openFolder());

  renderEmptyCopy();
  void refreshSessions();

  return {
    setMode(mode: WorkPanelMode): void {
      if (mode === currentMode) return;
      currentMode = mode;
      renderEmptyCopy();
      void refreshSessions();
    },
  };
}
