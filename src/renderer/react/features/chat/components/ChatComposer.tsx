import { Sender } from "@ant-design/x";
import { ReasoningControl } from "./ReasoningControl";
import { StyleControl } from "./StyleControl";
import chatWelcomeUrl from "../../../assets/welcome/chat.png?url";
import codeWelcomeUrl from "../../../assets/welcome/code.png?url";
import dailyWelcomeUrl from "../../../assets/welcome/daily.png?url";
import learnWelcomeUrl from "../../../assets/welcome/learn.png?url";
import workWelcomeUrl from "../../../assets/welcome/work.png?url";

interface ChatComposerProps {
  value: string;
  mode: string;
  docked: boolean;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
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

function FolderIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5h6l1.6 2H20a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 20 19.5H4A1.5 1.5 0 0 1 2.5 18v-9A1.5 1.5 0 0 1 3.5 7.5Z" /></svg>;
}

function ShieldIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 19 6v5.2c0 4.4-2.9 7.7-7 9.3-4.1-1.6-7-4.9-7-9.3V6l7-2.5Z" /><path d="m9 12 2 2 4-4" /></svg>;
}

function ChevronIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>;
}

function ObsidianVaultIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8.2 4.5 3.8-2 3.8 2 3 6.4-3.2 8.1H8.4l-3.2-8.1 3-6.4Z" /><path d="m8.7 10.2 2.1 5.5M15.3 10.2l-2.1 5.5M8.7 10.2 12 8l3.3 2.2" /></svg>;
}

export function ChatComposer({ value, mode, docked, onChange, onSubmit }: ChatComposerProps) {
  const supportsWorkFiles = ["work", "code", "daily"].includes(mode);
  const supportsObsidianLibrary = mode === "learn";
  const supportsPermission = supportsWorkFiles || supportsObsidianLibrary;
  const supportsStyle = mode !== "code";
  const welcomeImageUrl = WELCOME_IMAGE_BY_MODE[mode] ?? chatWelcomeUrl;

  return (
    <div className={`cy-composer-stack ${docked ? "is-docked" : "is-centered"}`}>
      {!docked && <img className="cy-composer-welcome" src={welcomeImageUrl} alt="" />}
      <div className="cy-composer-shell">
        <Sender
        rootClassName="cy-composer"
        value={value}
        placeholder="有什么问题/任务，来找昔涟"
        autoSize={{ minRows: 3, maxRows: 7 }}
        onChange={onChange}
        onSubmit={onSubmit}
        prefix={
          <button type="button" className="cy-composer__icon-button" aria-label="添加上下文">
            <PlusIcon />
          </button>
        }
        />
        <div className="cy-composer__footer">
        {supportsWorkFiles && (
          <button type="button" className="cy-composer__footer-button" aria-label="选择工作文件夹">
            <FolderIcon />
            <span>{docked ? "工作文件夹" : "进入项目工作"}</span>
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
          <button type="button" className="cy-composer__footer-button">
            <ShieldIcon />
            <span>请求权限</span>
            <ChevronIcon />
          </button>
        )}
        {supportsStyle && <StyleControl />}
          <ReasoningControl />
        </div>
      </div>
    </div>
  );
}
