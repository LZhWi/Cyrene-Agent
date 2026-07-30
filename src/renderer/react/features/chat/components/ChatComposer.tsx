import { Sender, Attachments } from "@ant-design/x";
import { Button, Tooltip } from "antd";
import { PaperClipOutlined } from "@ant-design/icons";
import { useState } from "react";

interface ChatComposerProps {
  placeholder: string;
  supportsAttachments: boolean;
  disabled: boolean;
  isGenerating: boolean;
  onSubmit: (content: string) => void;
  onStop: () => void;
}

export function ChatComposer({
  placeholder,
  supportsAttachments,
  disabled,
  isGenerating,
  onSubmit,
  onStop,
}: ChatComposerProps) {
  const [value, setValue] = useState("");

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: 12,
        padding: "18px 88px 26px",
        borderTop: "1px solid var(--rb-border-soft)",
        flexShrink: 0,
      }}
    >
      {supportsAttachments && (
        <Tooltip title="上传文件">
          <Button
            icon={<PaperClipOutlined />}
            style={{
              width: 40,
              height: 40,
              borderRadius: 12,
            }}
          />
        </Tooltip>
      )}

      <Sender
        value={value}
        onChange={setValue}
        onSubmit={(msg) => {
          onSubmit(msg);
          setValue("");
        }}
        onCancel={onStop}
        loading={isGenerating}
        disabled={disabled}
        placeholder={placeholder}
        style={{ flex: 1 }}
      />
    </div>
  );
}
