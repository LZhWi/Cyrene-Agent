import { Button, Empty } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import type { ChatSessionViewModel } from "../model/chat.types";

interface ChatSidebarProps {
  open: boolean;
  sessions: ChatSessionViewModel[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
}

export function ChatSidebar({
  open,
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
}: ChatSidebarProps) {
  if (!open) return null;

  return (
    <aside
      style={{
        width: 240,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: "14px 12px",
        background: "rgba(255, 255, 255, 0.04)",
        borderRight: "1px solid var(--rb-border-soft)",
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      <Button
        type="dashed"
        icon={<PlusOutlined />}
        onClick={onNewSession}
        block
      >
        新对话
      </Button>

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        {sessions.length === 0 ? (
          <Empty
            description="还没有对话"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            style={{ marginTop: 40 }}
          />
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              onClick={() => onSelectSession(session.id)}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 3,
                padding: "9px 11px",
                borderRadius: 10,
                cursor: "pointer",
                background:
                  session.id === activeSessionId
                    ? "var(--rb-border-soft)"
                    : "transparent",
                border:
                  session.id === activeSessionId
                    ? "1px solid var(--rb-border-strong)"
                    : "1px solid transparent",
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  color: "var(--rb-text-default)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {session.title}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--rb-text-faint)",
                }}
              >
                {session.mode}
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
