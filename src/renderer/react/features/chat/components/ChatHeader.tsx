import { Button, Segmented, Tooltip } from "antd";
import {
  MenuOutlined,
  MessageOutlined,
  CodeOutlined,
  ReadOutlined,
  CalendarOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import type { ChatMode } from "../modes/mode.types";

interface ChatHeaderProps {
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  onToggleSidebar: () => void;
}

const modeOptions = [
  { label: "Work", value: "work", icon: <ToolOutlined /> },
  { label: "Chat", value: "chat", icon: <MessageOutlined /> },
  { label: "Code", value: "code", icon: <CodeOutlined /> },
  { label: "Learn", value: "learn", icon: <ReadOutlined /> },
  { label: "Daily", value: "daily", icon: <CalendarOutlined /> },
];

export function ChatHeader({
  mode,
  onModeChange,
  onToggleSidebar,
}: ChatHeaderProps) {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        height: 58,
        padding: "0 18px 0 22px",
        borderBottom: "1px solid var(--rb-border-soft)",
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Tooltip title="会话列表">
          <Button
            type="text"
            icon={<MenuOutlined />}
            onClick={onToggleSidebar}
          />
        </Tooltip>
        <span style={{ fontWeight: 600, color: "var(--rb-text-strong)" }}>
          昔涟
        </span>
      </div>

      <Segmented
        options={modeOptions}
        value={mode}
        onChange={(val) => onModeChange(val as ChatMode)}
      />
    </header>
  );
}
