import { Sender } from "@ant-design/x";
import { Popover } from "antd";
import { useEffect, useRef, useState } from "react";
import { resolveAsset } from "../../../../../shared/renderer-base";
import { ReasoningControl } from "./ReasoningControl";
import { StyleControl } from "./StyleControl";
import { PermissionControl } from "./PermissionControl";
import chatWelcomeUrl from "../../../assets/welcome/chat.png?url";
import codeWelcomeUrl from "../../../assets/welcome/code.png?url";
import dailyWelcomeUrl from "../../../assets/welcome/daily.png?url";
import learnWelcomeUrl from "../../../assets/welcome/learn.png?url";
import workWelcomeUrl from "../../../assets/welcome/work.png?url";

interface ChatComposerProps {
  value: string;
  mode: string;
  docked: boolean;
  workspaceName?: string;
  attachments: ComposerAttachment[];
  attachmentBusy?: boolean;
  modelBusy?: boolean;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onChooseWorkspace: () => void;
  onChooseFiles: (files: File[]) => void;
  onRemoveAttachment: (index: number) => void;
  onScreenshot: () => void;
  onChooseSticker: (id: string) => void;
}

export interface ComposerAttachment {
  name: string;
  kind: string;
  filePath?: string;
  mime?: string;
  previewUrl?: string;
  hasAnnotations?: boolean;
  caption?: string;
  status?: string;
  reason?: string;
  imageSendMode?: "direct" | "caption";
}

const WELCOME_IMAGE_BY_MODE: Record<string, string> = {
  chat: chatWelcomeUrl,
  code: codeWelcomeUrl,
  daily: dailyWelcomeUrl,
  learn: learnWelcomeUrl,
  work: workWelcomeUrl,
};

function PlusIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
}

function ScreenshotIcon() {
  return (
    <svg className="cy-composer__screenshot-icon" width="24" height="24" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M16 6H8C6.89543 6 6 6.89543 6 8V16" />
      <path d="M16 42H8C6.89543 42 6 41.1046 6 40V32" />
      <path d="M32 42H40C41.1046 42 42 41.1046 42 40V32" />
      <path d="M32 6H40C41.1046 6 42 6.89543 42 8V16" />
      <rect x="14" y="14" width="20" height="20" rx="2" />
    </svg>
  );
}

interface EnabledSticker {
  id: string;
  src: string;
  description?: string;
}

function stickerUrl(src: string): string {
  return src.startsWith("/stickers/") ? resolveAsset(src) : src;
}

function StickerPicker({ onChoose }: { onChoose: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [stickers, setStickers] = useState<EnabledSticker[]>([]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void window.chat?.getEnabledStickers?.().then((items) => {
      if (active) setStickers(items);
    }).catch(() => {
      if (active) setStickers([]);
    });
    return () => {
      active = false;
    };
  }, [open]);

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="topLeft"
      rootClassName="cy-sticker-popover"
      content={(
        <div className="cy-sticker-picker" aria-label="表情包列表">
          {stickers.length === 0 && <span className="cy-sticker-picker__empty">没有可用的表情包</span>}
          {stickers.map((sticker) => (
            <button
              type="button"
              key={sticker.id}
              title={sticker.description ?? sticker.id}
              onClick={() => {
                onChoose(sticker.id);
                setOpen(false);
              }}
            >
              <img src={stickerUrl(sticker.src)} alt={sticker.description ?? sticker.id} draggable={false} />
            </button>
          ))}
        </div>
      )}
    >
      <button type="button" className="cy-composer__icon-button cy-composer__sticker-button" aria-label="表情包" title="表情包">
        <img src={resolveAsset("icons/sticker-picker.png")} alt="" aria-hidden="true" draggable={false} />
      </button>
    </Popover>
  );
}

function FolderIcon() {
  return (
    <svg className="cy-composer__terminal-folder-icon" width="24" height="24" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M5 8C5 6.89543 5.89543 6 7 6H19L24 12H41C42.1046 12 43 12.8954 43 14V40C43 41.1046 42.1046 42 41 42H7C5.89543 42 5 41.1046 5 40V8Z" />
      <path d="M14 22L19 27L14 32" />
      <path d="M26 32H34" />
    </svg>
  );
}

function CodeFolderIcon() {
  return (
    <svg className="cy-composer__code-folder-icon" width="24" height="24" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M43 23V14C43 12.8954 42.1046 12 41 12H24L19 6H7C5.89543 6 5 6.89543 5 8V40C5 41.1046 5.89543 42 7 42H22" />
      <path d="M38 29L43 34L38 39" />
      <path d="M30 29L25 34L30 39" />
    </svg>
  );
}

function ChevronIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>;
}

function ObsidianVaultIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8.2 4.5 3.8-2 3.8 2 3 6.4-3.2 8.1H8.4l-3.2-8.1 3-6.4Z" /><path d="m8.7 10.2 2.1 5.5M15.3 10.2l-2.1 5.5M8.7 10.2 12 8l3.3 2.2" /></svg>;
}

export function ChatComposer({
  value,
  mode,
  docked,
  workspaceName,
  attachments,
  attachmentBusy = false,
  modelBusy = false,
  onChange,
  onSubmit,
  onChooseWorkspace,
  onChooseFiles,
  onRemoveAttachment,
  onScreenshot,
  onChooseSticker,
}: ChatComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const supportsWorkFiles = ["work", "code", "daily"].includes(mode);
  const supportsObsidianLibrary = mode === "learn";
  const supportsPermission = supportsWorkFiles || supportsObsidianLibrary;
  const supportsStyle = mode !== "code";
  const welcomeImageUrl = WELCOME_IMAGE_BY_MODE[mode] ?? chatWelcomeUrl;
  const requiresWorkspace = supportsWorkFiles;
  const placeholder = mode === "chat"
    ? "昔涟期待和你一起聊天♪"
    : requiresWorkspace && !workspaceName
      ? "有什么问题 / 任务，来找昔涟♪（ps：请先选中一个项目路径哦♪）"
      : "有什么问题 / 任务，来找昔涟♪";

  return (
    <div className={`cy-composer-stack ${docked ? "is-docked" : "is-centered"}`}>
      {!docked && <img className="cy-composer-welcome" src={welcomeImageUrl} alt="" />}
      <div className="cy-composer-shell">
        <input
          ref={fileInputRef}
          className="cy-composer__file-input"
          type="file"
          accept=".txt,.md,.json,.csv,.log,.png,.jpg,.jpeg,.webp,.gif,.bmp"
          multiple
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            if (files.length > 0) onChooseFiles(files);
            event.currentTarget.value = "";
          }}
        />
        <Sender
        rootClassName="cy-composer"
        value={value}
        placeholder={placeholder}
        disabled={(requiresWorkspace && !workspaceName) || modelBusy}
        autoSize={{ minRows: 3, maxRows: 7 }}
        onChange={onChange}
        onSubmit={onSubmit}
        header={attachments.length > 0 ? (
          <div className="cy-composer__attachments" aria-label="待发送附件">
            {attachments.map((attachment, index) => (
              <div className={`cy-composer__attachment ${attachment.kind === "image" && attachment.previewUrl ? "is-image" : ""}`} key={`${attachment.filePath ?? attachment.name}-${index}`}>
                {attachment.kind === "image" && attachment.previewUrl ? (
                  <img src={attachment.previewUrl} alt="" draggable={false} />
                ) : (
                  <span title={attachment.name}>{attachment.name}</span>
                )}
                <button type="button" aria-label={`移除 ${attachment.name}`} onClick={() => onRemoveAttachment(index)}>×</button>
              </div>
            ))}
          </div>
        ) : undefined}
        prefix={
          <div className="cy-composer__prefix-actions">
            <button
              type="button"
              className="cy-composer__icon-button"
              aria-label="上传文件"
              title="上传文件"
              disabled={attachmentBusy}
              onClick={() => fileInputRef.current?.click()}
            >
              <PlusIcon />
            </button>
            <button
              type="button"
              className="cy-composer__icon-button"
              aria-label="截图"
              title="截图 (Alt+Shift+S)"
              onClick={onScreenshot}
            >
              <ScreenshotIcon />
            </button>
            <StickerPicker onChoose={onChooseSticker} />
          </div>
        }
        />
        <div className="cy-composer__footer">
        {supportsWorkFiles && (
          <button type="button" className="cy-composer__footer-button" aria-label="选择工作文件夹" onClick={onChooseWorkspace}>
            {mode === "code" ? <CodeFolderIcon /> : <FolderIcon />}
            <span>{workspaceName ?? (docked ? "工作文件夹" : "进入项目工作")}</span>
            <ChevronIcon />
          </button>
        )}
        {supportsObsidianLibrary && (
          <button type="button" className="cy-composer__footer-button cy-composer__footer-button--placeholder" disabled>
            <ObsidianVaultIcon />
            <span>Obsidian 项目库</span>
            <small>SOON</small>
          </button>
        )}
        {supportsPermission && <span className="cy-composer__footer-separator" />}
        {supportsPermission && (
          <PermissionControl />
        )}
        {supportsStyle && <StyleControl />}
          <ReasoningControl />
        </div>
      </div>
    </div>
  );
}
