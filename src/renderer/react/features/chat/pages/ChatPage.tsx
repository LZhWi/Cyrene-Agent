import { useEffect, useRef, useState, type DragEvent } from "react";
import { ChatComposer, type ComposerAttachment } from "../components/ChatComposer";
import { ChatMessageList, type ChatMessageItem } from "../components/ChatMessageList";
import { SidebarToggle } from "../../../components/ui/SidebarToggle";
import { ModeSwitch } from "../../../components/ui/ModeSwitch";
import { CharacterStatusPill } from "../../../components/ui/CharacterStatusPill";
import { WindowControls } from "../../../components/ui/WindowControls";
import { SettingsButton } from "../../../components/ui/SettingsButton";
import { UserAvatar } from "../../../components/ui/UserAvatar";
import { NewTaskButton } from "../../../components/ui/NewTaskButton";
import "../../../components/ui/SidebarToggle.css";
import "../../../components/ui/ModeSwitch.css";
import "../../../components/ui/CharacterStatusPill.css";
import "../../../components/ui/WindowControls.css";
import "../../../components/ui/SettingsButton.css";
import "../../../components/ui/UserAvatar.css";
import "../../../components/ui/NewTaskButton.css";
import "../components/ChatComposer.css";
import "../components/ReasoningControl.css";
import "../components/StyleControl.css";
import "../components/PermissionControl.css";
import "../components/ChatMessageList.css";

import avatarDark from "../../../assets/avatars/avatar-dark.png";
import avatarLight from "../../../assets/avatars/avatar-light.png";

type ConversationMode = "chat" | "work" | "code" | "learn" | "daily";

const CONVERSATION_MODES: readonly ConversationMode[] = ["chat", "work", "code", "learn", "daily"];

function isConversationMode(value: string): value is ConversationMode {
  return CONVERSATION_MODES.includes(value as ConversationMode);
}

const DEMO_RESPONSES: Readonly<Record<string, string>> = {
  "1": "收到啦♪ 这是一条普通会话消息。今天也一起把界面慢慢打磨得更舒服吧。",
  "2": [
    "## Markdown 渲染测试",
    "",
    "这是一段包含 **粗体**、*斜体* 和 `行内代码` 的内容。",
    "",
    "- 第一项：消息列表使用 Bubble",
    "- 第二项：正文使用 XMarkdown",
    "- 第三项：样式仍由昔涟主题控制",
    "",
    "> 这是一段引用，用来观察间距、颜色和左侧边线。",
    "",
    "| 功能 | 状态 |",
    "| --- | --- |",
    "| Markdown | 正常 |",
    "| 表格 | 正常 |",
  ].join("\n"),
  "3": String.raw`数学公式测试开始♪

行内公式：$E = mc^2$

块级公式：

$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}
$$

再来一个二次方程：

$$
x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
$$`,
  "4": [
    "下面是一段 TypeScript 代码，用来测试语法高亮和复制功能：",
    "",
    "```ts",
    "type CyreneMode = \"work\" | \"chat\" | \"code\" | \"learn\" | \"daily\";",
    "",
    "function greeting(mode: CyreneMode): string {",
    "  return mode === \"chat\"",
    "    ? \"昔涟期待和你一起聊天♪\"",
    "    : `当前模式：${mode}`;",
    "}",
    "",
    "console.log(greeting(\"chat\"));",
    "```",
  ].join("\n"),
};

const DEMO_STICKERS: Readonly<Record<string, string>> = {
  "5": "playful",
};

interface ChatStoreApi {
  create: (input: { identityId: null; mode: ConversationMode }) => Promise<{ id: string }>;
  pickWorkspaceFolder: () => Promise<{ ok: boolean; path?: string; displayName?: string; error?: string }>;
  setWorkspace: (sessionId: string, workspaceRoot: string) => Promise<{ ok: boolean; error?: string }>;
}

export function ChatPage() {
  const [collapsed, setCollapsed] = useState(false);
  const [mode, setMode] = useState<ConversationMode>("chat");
  const [drafts, setDrafts] = useState<Partial<Record<ConversationMode, string>>>({});
  const [messagesByMode, setMessagesByMode] = useState<Partial<Record<ConversationMode, ChatMessageItem[]>>>({});
  const [workspaceNames, setWorkspaceNames] = useState<Partial<Record<ConversationMode, string>>>({});
  const [attachmentsByMode, setAttachmentsByMode] = useState<Partial<Record<ConversationMode, ComposerAttachment[]>>>({});
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const sessionIds = useRef<Partial<Record<ConversationMode, string>>>({});
  const activeModeRef = useRef(mode);
  const dragDepthRef = useRef(0);
  const localPreviewUrlsRef = useRef(new Set<string>());
  const demoTimers = useRef(new Set<number>());

  const taskLabel = ["work", "daily", "code"].includes(mode) ? "新建任务" : "新建对话";
  const draft = drafts[mode] ?? "";
  const messages = messagesByMode[mode] ?? [];
  const hasMessages = messages.length > 0;
  const attachments = attachmentsByMode[mode] ?? [];

  activeModeRef.current = mode;

  useEffect(() => () => {
    for (const timer of demoTimers.current) {
      window.clearTimeout(timer);
      window.clearInterval(timer);
    }
    demoTimers.current.clear();
    for (const url of localPreviewUrlsRef.current) URL.revokeObjectURL(url);
    localPreviewUrlsRef.current.clear();
  }, []);

  useEffect(() => window.chat?.onScreenshotInsert?.((data) => {
    const targetMode = activeModeRef.current;
    const attachment: ComposerAttachment = {
      kind: "image",
      name: `截图_${Date.now()}.png`,
      filePath: data.filePath,
      mime: data.mime,
      previewUrl: data.previewUrl,
      hasAnnotations: data.hasAnnotations,
    };
    setAttachmentsByMode((current) => ({
      ...current,
      [targetMode]: [...(current[targetMode] ?? []), attachment],
    }));
  }), []);

  function updateMessage(targetMode: ConversationMode, id: string, patch: Partial<ChatMessageItem>) {
    setMessagesByMode((current) => ({
      ...current,
      [targetMode]: (current[targetMode] ?? []).map((item) => (
        item.id === id ? { ...item, ...patch } : item
      )),
    }));
  }

  function streamDemoResponse(targetMode: ConversationMode, id: string, response: string) {
    const loadingTimer = window.setTimeout(() => {
      demoTimers.current.delete(loadingTimer);
      updateMessage(targetMode, id, { loading: false, streaming: true });

      const characters = Array.from(response);
      const chunkSize = Math.max(1, Math.min(4, Math.ceil(characters.length / 120)));
      let cursor = 0;
      const streamTimer = window.setInterval(() => {
        cursor = Math.min(characters.length, cursor + chunkSize);
        const finished = cursor >= characters.length;
        updateMessage(targetMode, id, {
          content: characters.slice(0, cursor).join(""),
          streaming: !finished,
        });
        if (finished) {
          window.clearInterval(streamTimer);
          demoTimers.current.delete(streamTimer);
        }
      }, 30);
      demoTimers.current.add(streamTimer);
    }, 450);
    demoTimers.current.add(loadingTimer);
  }

  async function ensureSession(targetMode: ConversationMode): Promise<string> {
    const existing = sessionIds.current[targetMode];
    if (existing) return existing;
    const chatStore = (window as typeof window & { chatStore?: ChatStoreApi }).chatStore;
    if (!chatStore) throw new Error("聊天会话服务尚未就绪");
    const session = await chatStore.create({ identityId: null, mode: targetMode });
    sessionIds.current[targetMode] = session.id;
    return session.id;
  }

  async function chooseWorkspace() {
    const targetMode = mode;
    if (targetMode === "chat" || targetMode === "learn") return;
    const chatStore = (window as typeof window & { chatStore?: ChatStoreApi }).chatStore;
    if (!chatStore) return;
    const picked = await chatStore.pickWorkspaceFolder();
    if (!picked.ok || !picked.path) return;
    const sessionId = await ensureSession(targetMode);
    const result = await chatStore.setWorkspace(sessionId, picked.path);
    if (!result.ok) {
      window.alert(`设置工作区失败：${result.error ?? "未知错误"}`);
      return;
    }
    setWorkspaceNames((current) => ({ ...current, [targetMode]: picked.displayName ?? "工作文件夹" }));
  }

  async function chooseFiles(files: File[]) {
    const targetMode = mode;
    if (!window.chat || files.length === 0) return;
    setAttachmentBusy(true);
    const previewsByName = new Map<string, string[]>();
    for (const file of files) {
      if (!file.type.startsWith("image/") && !/\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name)) continue;
      const previewUrl = URL.createObjectURL(file);
      localPreviewUrlsRef.current.add(previewUrl);
      previewsByName.set(file.name, [...(previewsByName.get(file.name) ?? []), previewUrl]);
    }
    try {
      const results = await window.chat.ingestDroppedFiles(files);
      if (results.length > 0) {
        const hydratedResults = results.map((attachment) => {
          if (attachment.kind !== "image") return attachment;
          const previews = previewsByName.get(attachment.name);
          const localPreview = previews?.shift();
          return localPreview ? { ...attachment, previewUrl: localPreview } : attachment;
        });
        setAttachmentsByMode((current) => ({
          ...current,
          [targetMode]: [...(current[targetMode] ?? []), ...hydratedResults],
        }));
      }
    } catch (error) {
      window.alert(`文件摄入失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setAttachmentBusy(false);
    }
  }

  function updateMessageAttachments(
    targetMode: ConversationMode,
    messageId: string,
    updater: (attachments: ComposerAttachment[]) => ComposerAttachment[],
  ) {
    setMessagesByMode((current) => ({
      ...current,
      [targetMode]: (current[targetMode] ?? []).map((item) => (
        item.id === messageId
          ? { ...item, attachments: updater(item.attachments ?? []) }
          : item
      )),
    }));
  }

  async function prepareImageAttachments(
    targetMode: ConversationMode,
    messageId: string,
    attachments: ComposerAttachment[],
  ) {
    const images = attachments.filter((attachment) => attachment.kind === "image" && attachment.filePath);
    if (images.length === 0 || !window.chat) return;

    let strategy: { mode: "direct" | "caption" } = { mode: "caption" };
    try {
      strategy = await window.chat.getImageSendStrategy();
    } catch (error) {
      console.warn("[Cyrene React] 获取图片发送策略失败，回退视觉描述:", error);
    }

    if (strategy.mode === "direct") {
      const paths = new Set(images.map((image) => image.filePath));
      updateMessageAttachments(targetMode, messageId, (current) => current.map((attachment) => (
        paths.has(attachment.filePath)
          ? { ...attachment, imageSendMode: "direct", status: "done" }
          : attachment
      )));
      return;
    }

    for (const image of images) {
      updateMessageAttachments(targetMode, messageId, (current) => current.map((attachment) => (
        attachment.filePath === image.filePath
          ? { ...attachment, imageSendMode: "caption", status: "processing" }
          : attachment
      )));
      let result: { ok: boolean; caption?: string; error?: string };
      try {
        result = await window.chat.captionImage(image.filePath!, image.hasAnnotations === true);
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      updateMessageAttachments(targetMode, messageId, (current) => current.map((attachment) => (
        attachment.filePath === image.filePath
          ? result.ok && result.caption
            ? { ...attachment, imageSendMode: "caption", status: "done", caption: result.caption, reason: undefined }
            : { ...attachment, imageSendMode: "caption", status: "error", reason: result.error ?? "图片分析失败" }
          : attachment
      )));
    }
  }

  function removeAttachment(index: number) {
    const targetMode = mode;
    setAttachmentsByMode((current) => ({
      ...current,
      [targetMode]: (current[targetMode] ?? []).filter((_, itemIndex) => itemIndex !== index),
    }));
  }

  function containsFiles(dataTransfer: DataTransfer): boolean {
    return Array.from(dataTransfer.types).includes("Files");
  }

  function handleDragEnter(event: DragEvent<HTMLElement>) {
    if (!containsFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingFiles(true);
  }

  function handleDragOver(event: DragEvent<HTMLElement>) {
    if (!containsFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: DragEvent<HTMLElement>) {
    if (!containsFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingFiles(false);
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    if (!containsFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) void chooseFiles(files);
  }

  function sendMessage(content: string) {
    const message = content.trim();
    if (!message) return;
    const stickerMatch = message.match(/\[sticker:([^\]]+)\]/);
    const userSticker = stickerMatch?.[1];
    const visibleMessage = message.replace(/\[sticker:[^\]]+\]/g, "").trim();
    const demoResponse = DEMO_RESPONSES[message];
    const demoSticker = DEMO_STICKERS[message];
    const assistantId = demoResponse || demoSticker ? crypto.randomUUID() : undefined;
    const userMessageId = crypto.randomUUID();
    const attachmentsForMessage = attachments.map((attachment) => ({ ...attachment }));
    setMessagesByMode((current) => ({
      ...current,
      [mode]: [
        ...(current[mode] ?? []),
        {
          id: userMessageId,
          role: "user",
          content: visibleMessage,
          sticker: userSticker,
          attachments: attachmentsForMessage.length > 0 ? attachmentsForMessage : undefined,
        },
        ...(assistantId ? [{
          id: assistantId!,
          role: "assistant" as const,
          content: "",
          loading: Boolean(demoResponse),
          streaming: false,
          sticker: demoSticker,
        }] : []),
      ],
    }));
    setDrafts((current) => ({ ...current, [mode]: "" }));
    setAttachmentsByMode((current) => ({ ...current, [mode]: [] }));
    if (attachmentsForMessage.length > 0) {
      void prepareImageAttachments(mode, userMessageId, attachmentsForMessage);
    }
    if (demoResponse && assistantId) streamDemoResponse(mode, assistantId, demoResponse);
  }

  return (
    <div className={`cy-page ${collapsed ? "is-collapsed" : ""}`}>
      <div className="cy-page-toggle">
        <SidebarToggle collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} />
      </div>
      <div className="cy-page-mode">
        <ModeSwitch value={mode} onChange={(nextMode) => {
          if (isConversationMode(nextMode)) setMode(nextMode);
        }} />
      </div>
      <div className="cy-page-status">
        <CharacterStatusPill avatarPath={avatarLight} />
      </div>
      <div className="cy-page-windows">
        <WindowControls />
      </div>
      <div className="cy-page-settings">
        <SettingsButton />
      </div>
      <div className="cy-page-user">
        <UserAvatar />
      </div>
      <div className="cy-page-newtask">
        <NewTaskButton label={taskLabel} />
      </div>
      <main
        className={`cy-workspace ${hasMessages ? "has-messages" : "is-empty"} ${isDraggingFiles ? "is-dragging-files" : ""}`}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDraggingFiles && (
          <div className="cy-file-drop-overlay" aria-hidden="true">
            <span>松开即可添加到当前对话</span>
          </div>
        )}
        {hasMessages && <ChatMessageList messages={messages} />}
        <div className="cy-workspace-composer">
          <ChatComposer
            value={draft}
            mode={mode}
            docked={hasMessages}
            workspaceName={workspaceNames[mode]}
            attachments={attachments}
            attachmentBusy={attachmentBusy}
            onChange={(value) => setDrafts((current) => ({ ...current, [mode]: value }))}
            onSubmit={sendMessage}
            onChooseWorkspace={() => void chooseWorkspace()}
            onChooseFiles={(files) => void chooseFiles(files)}
            onRemoveAttachment={removeAttachment}
            onScreenshot={() => void window.chat?.startScreenshot()}
            onChooseSticker={(id) => {
              const separator = draft && !draft.endsWith(" ") ? " " : "";
              setDrafts((current) => ({ ...current, [mode]: `${draft}${separator}[sticker:${id}]` }));
            }}
          />
        </div>
      </main>
    </div>
  );
}
