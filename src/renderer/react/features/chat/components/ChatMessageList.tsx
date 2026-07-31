import { Bubble, CodeHighlighter, type BubbleItemType } from "@ant-design/x";
import { XMarkdown, type ComponentProps } from "@ant-design/x-markdown";
import Latex from "@ant-design/x-markdown/plugins/Latex";
import { useEffect, useState, type ReactNode } from "react";
import { resolveAsset } from "../../../../../shared/renderer-base";
import { useUserAvatar } from "../../../hooks/useUserAvatar";

export interface ChatMessageItem {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  streaming?: boolean;
  loading?: boolean;
  sticker?: string | null;
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

function MarkdownContent({ content, streaming = false }: { content: string; streaming?: boolean }) {
  return (
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

function CyreneMessageAvatar() {
  return <img className="cy-message-avatar__image" src={cyreneAvatarUrl} alt="昔涟" draggable={false} />;
}

function UserMessageAvatar({ src }: { src: string | null }) {
  if (src) return <img className="cy-message-avatar__image" src={src} alt="用户" draggable={false} />;
  return <span className="cy-message-avatar__user" aria-label="用户" />;
}

function createRoles(userAvatarUrl: string | null) {
  return {
  user: {
    placement: "end" as const,
    variant: "filled" as const,
    rootClassName: "cy-message cy-message--user",
    avatar: <UserMessageAvatar src={userAvatarUrl} />,
    contentRender: (content: string, info: { extraInfo?: { stickerUrl?: string; attachments?: ChatMessageAttachment[] } }) => (
      <UserContent
        content={content}
        stickerUrl={info.extraInfo?.stickerUrl}
        attachments={info.extraInfo?.attachments}
      />
    ),
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
  },
  system: {
    placement: "start" as const,
    variant: "borderless" as const,
    rootClassName: "cy-message cy-message--system",
  },
  };
}

export function ChatMessageList({ messages }: ChatMessageListProps) {
  const userAvatarUrl = useUserAvatar();
  const [enabledStickers, setEnabledStickers] = useState<EnabledSticker[]>([]);
  const roles = createRoles(userAvatarUrl);

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

  const items: BubbleItemType[] = messages.map((message) => ({
    key: message.id,
    role: message.role,
    content: message.content,
    loading: message.loading,
    streaming: message.streaming,
    extraInfo: {
      streaming: message.streaming,
      stickerUrl: message.sticker ? resolveStickerUrl(message.sticker, enabledStickers) : undefined,
      attachments: message.attachments,
    },
  }));

  return (
    <div className="cy-message-list" aria-live="polite">
      <Bubble.List items={items} role={roles} autoScroll />
    </div>
  );
}
