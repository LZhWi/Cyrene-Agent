import { Bubble, CodeHighlighter, Think, ThoughtChain, type BubbleItemType } from "@ant-design/x";
import { XMarkdown, type ComponentProps } from "@ant-design/x-markdown";
import Latex from "@ant-design/x-markdown/plugins/Latex";
import { Component, useCallback, useEffect, useMemo, useState, type ErrorInfo, type KeyboardEvent, type ReactNode } from "react";
import { resolveAsset } from "../../../../../shared/renderer-base";
import type { ConversationMode, ToolExecutionRecord } from "../../../../../shared/chat-types";
import thinkingMoodUrl from "../../../assets/status-moods/思考中.png?url";
import completedThinkingMoodUrl from "../../../assets/status-moods/提醒.png?url";
import offlineMoodUrl from "../../../assets/status-moods/离线.png?url";
import { useUserAvatar } from "../../../hooks/useUserAvatar";
import {
  assistantRenderStages,
  resolveReasoningExpanded,
  updateReasoningExpanded,
} from "./message-visibility";
import { CopyButton } from "./CopyButton";
import { TtsButton } from "./TtsButton";
import { stopTtsPlayback } from "./tts-playback";
import { LastTurnActionButton } from "./LastTurnActionButton";
import { resolveRevisableLastTurn, type RevisableLastTurn } from "./last-turn-actions";
import { extractMessageStickerId, stripMessageStickerMarkers } from "./message-sticker";

export interface ChatMessageItem {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  reasoning?: string;
  reasoningStreaming?: boolean;
  responseStarted?: boolean;
  streaming?: boolean;
  loading?: boolean;
  /** 请求已发出但尚未收到 Think、工具或正文等首个可视事件。 */
  waitingForFirstEvent?: boolean;
  ttsCacheKey?: string;
  ttsCacheVersion?: string;
  sticker?: string | null;
  toolExecutions?: ToolExecutionRecord[];
  attachments?: ChatMessageAttachment[];
}

export interface ChatMessageAttachment {
  name: string;
  kind: string;
  filePath?: string;
  mime?: string;
  previewUrl?: string;
  caption?: string;
  status?: string;
  reason?: string;
  imageSendMode?: "direct" | "caption";
}

interface ChatMessageListProps {
  messages: ChatMessageItem[];
  conversationId?: string;
  mode: ConversationMode;
  preferredAddress: string;
  stickerSize?: "small" | "standard" | "large";
  onTtsCacheKey?: (messageId: string, cacheKey: string, converterVersion: string) => void;
  revisionBusy?: boolean;
  onEditLastUserMessage?: (messageId: string, content: string) => Promise<boolean>;
  onRegenerateLastResponse?: (userMessageId: string, assistantMessageId: string) => Promise<boolean>;
}

const markdownConfig = { extensions: Latex() };
const cyreneAvatarUrl = resolveAsset("avatars/cyrene-avatar.png");

function MarkdownCode({ children, lang, block }: ComponentProps<{ children?: ReactNode }>) {
  if (!block) return <code>{children}</code>;
  return (
    <CodeHighlighter lang={(lang ?? "text").split(/\s+/)[0]}>
      {String(children ?? "").replace(/\n$/, "")}
    </CodeHighlighter>
  );
}

class MarkdownRenderBoundary extends Component<{
  content: string;
  children: ReactNode;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ReactChat] Markdown/KaTeX 渲染失败，已降级为原始文本", error, info);
  }

  componentDidUpdate(previousProps: Readonly<{ content: string }>): void {
    if (previousProps.content !== this.props.content && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  render(): ReactNode {
    if (this.state.failed) {
      return <pre className="cy-message-markdown-fallback">{this.props.content}</pre>;
    }
    return this.props.children;
  }
}

function MarkdownContent({ content, streaming = false }: { content: string; streaming?: boolean }) {
  return (
    <MarkdownRenderBoundary content={content}>
      <XMarkdown
        content={content}
        config={markdownConfig}
        components={{ code: MarkdownCode }}
        openLinksInNewTab
        escapeRawHtml
        rootClassName="cy-message-markdown"
        streaming={{
          hasNextChunk: streaming,
          enableAnimation: streaming,
          tail: streaming ? { content: "●" } : false,
        }}
      />
    </MarkdownRenderBoundary>
  );
}

interface EnabledSticker {
  id: string;
  src: string;
}

function resolveStickerUrl(id: string, stickers: EnabledSticker[]): string | undefined {
  const raw = stickers.find((sticker) => sticker.id === id)?.src;
  if (!raw) return undefined;
  return raw.startsWith("/stickers/") ? resolveAsset(raw) : raw;
}

function AssistantContent({
  content,
  streaming,
  stickerUrl,
}: {
  content: string;
  streaming: boolean;
  stickerUrl?: string;
}) {
  return (
    <div className="cy-message__assistant-body">
      {content && <MarkdownContent content={content} streaming={streaming} />}
      {stickerUrl && <img className="cy-message__sticker" src={stickerUrl} alt="昔涟表情" draggable={false} />}
    </div>
  );
}

function DotSpinner() {
  return (
    <span className="cy-dot-spinner" aria-label="加载中" role="status">
      {Array.from({ length: 8 }, (_, index) => <span className="cy-dot-spinner__dot" key={index} />)}
    </span>
  );
}

function ModelWaitContent() {
  return (
    <section className="cy-model-wait" aria-label="等待模型响应">
      <span className="cy-model-wait__art" aria-hidden="true">
        <img src={offlineMoodUrl} alt="" draggable={false} />
        <DotSpinner />
      </span>
      <span>昔涟正在等模型回应…</span>
    </section>
  );
}

function ReasoningContent({
  content,
  loading,
  expanded,
  onExpand,
}: {
  content: string;
  loading: boolean;
  expanded: boolean;
  onExpand: (expanded: boolean) => void;
}) {
  const statusArt = loading ? thinkingMoodUrl : completedThinkingMoodUrl;
  return (
    <Think
      rootClassName="cy-message-reasoning"
      title={loading ? "正在思考…" : "思考完成"}
      icon={
        <span className={`cy-reasoning-status-art${loading ? " is-thinking" : " is-complete"}`} aria-hidden="true">
          <img src={statusArt} alt="" draggable={false} />
          {loading && <DotSpinner />}
        </span>
      }
      blink={loading}
      expanded={expanded}
      onExpand={onExpand}
      destroyOnHidden
    >
      {content && <MarkdownContent content={content} streaming={loading} />}
    </Think>
  );
}

function ToolExecutionContent({ tools }: { tools: ToolExecutionRecord[] }) {
  return (
    <section className="cy-tool-executions" aria-label="工具执行过程">
      <ThoughtChain
        rootClassName="cy-tool-executions__chain"
        line="dashed"
        items={tools.map((tool) => ({
          key: tool.id,
          title: tool.name,
          description: tool.status === "running" ? "正在执行…" : tool.status === "error" ? "执行失败" : "执行完成",
          status: tool.status === "running" ? "loading" : tool.status === "error" ? "error" : "success",
          blink: tool.status === "running",
          collapsible: Boolean(tool.result),
          content: tool.result ? <pre className="cy-tool-executions__result">{tool.result}</pre> : undefined,
        }))}
      />
    </section>
  );
}

function attachmentStatus(attachment: ChatMessageAttachment): string | undefined {
  if (attachment.status === "processing") return "视觉分析中…";
  if (attachment.status === "error") return attachment.reason ?? "图片分析失败";
  if (attachment.imageSendMode === "direct") return "已交给主模型查看";
  if (attachment.imageSendMode === "caption" && attachment.status === "done") return "视觉分析完成";
  return undefined;
}

function UserAttachments({ attachments }: { attachments: ChatMessageAttachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="cy-message__attachments">
      {attachments.map((attachment, index) => {
        const status = attachmentStatus(attachment);
        if (attachment.kind === "image" && (attachment.previewUrl || attachment.filePath)) {
          return (
            <figure className="cy-message__image-attachment" key={`${attachment.filePath ?? attachment.name}-${index}`}>
              <AttachmentImage attachment={attachment} />
              {status && <figcaption className={attachment.status === "error" ? "is-error" : ""}>{status}</figcaption>}
            </figure>
          );
        }
        return <span className="cy-message__file-attachment" key={`${attachment.filePath ?? attachment.name}-${index}`}>{attachment.name}</span>;
      })}
    </div>
  );
}

function AttachmentImage({ attachment }: { attachment: ChatMessageAttachment }) {
  const [src, setSrc] = useState(attachment.previewUrl);

  useEffect(() => {
    setSrc(attachment.previewUrl);
    if ((!attachment.previewUrl || attachment.previewUrl.startsWith("file:")) && attachment.filePath) {
      let active = true;
      void window.chat?.getImagePreview?.(attachment.filePath).then((result) => {
        if (active && result.ok && result.dataUrl) setSrc(result.dataUrl);
      });
      return () => {
        active = false;
      };
    }
  }, [attachment.filePath, attachment.previewUrl]);

  return <img src={src} alt={attachment.name} draggable={false} />;
}

function UserContent({
  content,
  stickerUrl,
  attachments = [],
}: {
  content: string;
  stickerUrl?: string;
  attachments?: ChatMessageAttachment[];
}) {
  return (
    <div className="cy-message__user-body">
      <UserAttachments attachments={attachments} />
      {content && <MarkdownContent content={content} />}
      {stickerUrl && <img className="cy-message__sticker" src={stickerUrl} alt="用户表情" draggable={false} />}
    </div>
  );
}

function LastUserMessageEditor({
  value,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      onSubmit();
    }
  };
  return (
    <div className="cy-last-message-editor">
      <textarea
        autoFocus
        value={value}
        disabled={busy}
        aria-label="编辑最后一条消息"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="cy-last-message-editor__actions">
        <button type="button" disabled={busy} onClick={onCancel}>取消</button>
        <button type="button" className="is-primary" disabled={busy || !value.trim()} onClick={onSubmit}>
          保存并重新生成
        </button>
      </div>
    </div>
  );
}

function CyreneMessageAvatar() {
  return <img className="cy-message-avatar__image" src={cyreneAvatarUrl} alt="昔涟" draggable={false} />;
}

function UserMessageAvatar({ src }: { src: string | null }) {
  if (src) return <img className="cy-message-avatar__image" src={src} alt="用户" draggable={false} />;
  return <span className="cy-message-avatar__user" aria-label="用户" />;
}

function createRoles(
  userAvatarUrl: string | null,
  conversationId: string | undefined,
  mode: ConversationMode,
  preferredAddress: string,
  lastTurn: RevisableLastTurn | null,
  editingMessageId: string | null,
  editDraft: string,
  revisionBusy: boolean,
  onBeginEdit: (messageId: string, content: string) => void,
  onEditDraftChange: (value: string) => void,
  onCancelEdit: () => void,
  onSubmitEdit: () => void,
  onRegenerate: () => void,
  reasoningExpanded: Readonly<Record<string, boolean>>,
  onReasoningExpand: (id: string, expanded: boolean) => void,
  onTtsCacheKey?: (messageId: string, cacheKey: string, converterVersion: string) => void,
) {
  return {
  user: {
    placement: "end" as const,
    variant: "filled" as const,
    rootClassName: "cy-message cy-message--user",
    avatar: <UserMessageAvatar src={userAvatarUrl} />,
    contentRender: (content: string, info: { extraInfo?: { messageId?: string; stickerUrl?: string; attachments?: ChatMessageAttachment[] } }) => (
      info.extraInfo?.messageId === editingMessageId
        ? <LastUserMessageEditor
            value={editDraft}
            busy={revisionBusy}
            onChange={onEditDraftChange}
            onCancel={onCancelEdit}
            onSubmit={onSubmitEdit}
          />
        : <UserContent
            content={content}
            stickerUrl={info.extraInfo?.stickerUrl}
            attachments={info.extraInfo?.attachments}
          />
    ),
    footer: (content: string, info: { extraInfo?: { messageId?: string } }) => {
      const cleanText = content.replace(/\[sticker:[^\]]+\]/g, "").trim();
      const messageId = info.extraInfo?.messageId;
      if (!cleanText || messageId === editingMessageId) return null;
      return (
        <div className="cy-message-actions">
          {messageId === lastTurn?.userMessageId && (
            <LastTurnActionButton
              kind="edit"
              disabled={revisionBusy}
              onClick={() => onBeginEdit(messageId, cleanText)}
            />
          )}
          <CopyButton text={cleanText} />
        </div>
      );
    },
  },
  assistant: {
    placement: "start" as const,
    variant: "filled" as const,
    rootClassName: "cy-message cy-message--assistant",
    avatar: <CyreneMessageAvatar />,
    contentRender: (content: string, info: { extraInfo?: { streaming?: boolean; stickerUrl?: string } }) => (
      <AssistantContent
        content={content}
        streaming={Boolean(info.extraInfo?.streaming)}
        stickerUrl={info.extraInfo?.stickerUrl}
      />
    ),
    footer: (content: string, info: { extraInfo?: { messageId?: string; streaming?: boolean; ttsCacheKey?: string } }) => {
      const cleanText = content.trim();
      const messageId = info.extraInfo?.messageId;
      const canRegenerate = messageId === lastTurn?.assistantMessageId;
      if (info.extraInfo?.streaming || (!cleanText && !canRegenerate)) return null;
      return (
        <div className="cy-message-actions">
          {cleanText && messageId && conversationId && (
            <TtsButton
              conversationId={conversationId}
              messageId={messageId}
              text={cleanText}
              speechMode={mode === "learn" ? "learn" : "default"}
              preferredAddress={preferredAddress}
              onCacheKey={(cacheKey, converterVersion) => onTtsCacheKey?.(messageId, cacheKey, converterVersion)}
            />
          )}
          {cleanText && <CopyButton text={cleanText} />}
          {canRegenerate && (
            <LastTurnActionButton kind="regenerate" disabled={revisionBusy} onClick={onRegenerate} />
          )}
        </div>
      );
    },
  },
  reasoning: {
    placement: "start" as const,
    variant: "borderless" as const,
    rootClassName: "cy-message cy-message--reasoning",
    contentRender: (_content: string, info: { extraInfo?: { reasoningId?: string; reasoning?: string; reasoningStreaming?: boolean } }) => (
      <ReasoningContent
        content={info.extraInfo?.reasoning ?? ""}
        loading={Boolean(info.extraInfo?.reasoningStreaming)}
        expanded={info.extraInfo?.reasoningId
          ? resolveReasoningExpanded(reasoningExpanded, info.extraInfo.reasoningId)
          : false}
        onExpand={(expanded) => {
          if (info.extraInfo?.reasoningId) onReasoningExpand(info.extraInfo.reasoningId, expanded);
        }}
      />
    ),
  },
  tool: {
    placement: "start" as const,
    variant: "borderless" as const,
    avatar: null,
    rootClassName: "cy-message cy-message--tool",
    contentRender: (_content: string, info: { extraInfo?: { tools?: ToolExecutionRecord[] } }) => (
      info.extraInfo?.tools?.length ? <ToolExecutionContent tools={info.extraInfo.tools} /> : null
    ),
  },
  waiting: {
    placement: "start" as const,
    variant: "borderless" as const,
    avatar: null,
    rootClassName: "cy-message cy-message--waiting",
    contentRender: () => <ModelWaitContent />,
  },
  system: {
    placement: "start" as const,
    variant: "borderless" as const,
    rootClassName: "cy-message cy-message--system",
  },
  };
}

export function createMessageItems(messages: ChatMessageItem[], enabledStickers: EnabledSticker[]): BubbleItemType[] {
  return messages.flatMap((message) => {
    if (message.role !== "assistant") {
      const stickerId = extractMessageStickerId(message.content, message.sticker);
      return [{
        key: message.id,
        role: message.role,
        content: stripMessageStickerMarkers(message.content),
        extraInfo: {
          stickerUrl: stickerId ? resolveStickerUrl(stickerId, enabledStickers) : undefined,
          attachments: message.attachments,
          messageId: message.id,
        },
      }];
    }

    const assistantItems: BubbleItemType[] = [];
    const stages = assistantRenderStages(message);
    if (message.waitingForFirstEvent) {
      assistantItems.push({
        key: `${message.id}-waiting`,
        role: "waiting",
        content: "",
      });
    }
    if (stages.includes("reasoning")) {
      assistantItems.push({
        key: `${message.id}-reasoning`,
        role: "reasoning",
        content: "",
        extraInfo: {
          reasoningId: message.id,
          reasoning: message.reasoning,
          reasoningStreaming: message.reasoningStreaming,
        },
      });
    }
    if (message.toolExecutions?.length) {
      assistantItems.push({
        key: `${message.id}-tools`,
        role: "tool",
        content: "",
        extraInfo: { tools: message.toolExecutions },
      });
    }
    if (stages.includes("assistant")) {
      assistantItems.push({
        key: message.id,
        role: "assistant",
        content: message.content,
        streaming: message.streaming,
        extraInfo: {
          messageId: message.id,
          streaming: message.streaming,
          ttsCacheKey: message.ttsCacheKey,
          stickerUrl: message.sticker ? resolveStickerUrl(message.sticker, enabledStickers) : undefined,
        },
      });
    }
    return assistantItems;
  });
}

export function ChatMessageList({
  messages,
  conversationId,
  mode,
  preferredAddress,
  stickerSize = "standard",
  onTtsCacheKey,
  revisionBusy = false,
  onEditLastUserMessage,
  onRegenerateLastResponse,
}: ChatMessageListProps) {
  const userAvatarUrl = useUserAvatar();
  const [enabledStickers, setEnabledStickers] = useState<EnabledSticker[]>([]);
  const [reasoningExpanded, setReasoningExpanded] = useState<Record<string, boolean>>({});
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const lastTurn = resolveRevisableLastTurn(messages, mode);
  const onReasoningExpand = useCallback((id: string, expanded: boolean) => {
    setReasoningExpanded((current) => updateReasoningExpanded(current, id, expanded));
  }, []);
  const beginEdit = useCallback((messageId: string, content: string) => {
    setEditingMessageId(messageId);
    setEditDraft(content);
  }, []);
  const cancelEdit = useCallback(() => {
    if (revisionBusy) return;
    setEditingMessageId(null);
    setEditDraft("");
  }, [revisionBusy]);
  const submitEdit = useCallback(() => {
    if (!editingMessageId || !editDraft.trim() || !onEditLastUserMessage || revisionBusy) return;
    void onEditLastUserMessage(editingMessageId, editDraft.trim()).then((accepted) => {
      if (!accepted) return;
      setEditingMessageId(null);
      setEditDraft("");
    });
  }, [editDraft, editingMessageId, onEditLastUserMessage, revisionBusy]);
  const regenerate = useCallback(() => {
    if (!lastTurn || !onRegenerateLastResponse || revisionBusy) return;
    void onRegenerateLastResponse(lastTurn.userMessageId, lastTurn.assistantMessageId);
  }, [lastTurn, onRegenerateLastResponse, revisionBusy]);
  const roles = useMemo(
    () => createRoles(
      userAvatarUrl,
      conversationId,
      mode,
      preferredAddress,
      lastTurn,
      editingMessageId,
      editDraft,
      revisionBusy,
      beginEdit,
      setEditDraft,
      cancelEdit,
      submitEdit,
      regenerate,
      reasoningExpanded,
      onReasoningExpand,
      onTtsCacheKey,
    ),
    [beginEdit, cancelEdit, conversationId, editDraft, editingMessageId, lastTurn, mode, onReasoningExpand, onTtsCacheKey, preferredAddress, reasoningExpanded, regenerate, revisionBusy, submitEdit, userAvatarUrl],
  );

  useEffect(() => {
    if (editingMessageId && editingMessageId !== lastTurn?.userMessageId) {
      setEditingMessageId(null);
      setEditDraft("");
    }
  }, [editingMessageId, lastTurn?.userMessageId]);

  useEffect(() => stopTtsPlayback, [conversationId]);

  useEffect(() => {
    let active = true;
    void window.chat?.getEnabledStickers?.().then((stickers) => {
      if (active) setEnabledStickers(stickers);
    }).catch(() => {
      if (active) setEnabledStickers([]);
    });
    return () => {
      active = false;
    };
  }, []);

  const items = createMessageItems(messages, enabledStickers);

  return (
    <div className={`cy-message-list cy-message-list--stickers-${stickerSize}`} aria-live="polite">
      <Bubble.List items={items} role={roles} autoScroll />
    </div>
  );
}
