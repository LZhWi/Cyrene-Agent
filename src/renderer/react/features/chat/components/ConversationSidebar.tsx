import { Conversations, type ConversationItemType } from "@ant-design/x";
import { Popover } from "antd";
import { useEffect, useMemo, useState } from "react";
import type { ChatSessionMeta, ConversationMode } from "../../../../../shared/chat-types";

interface ConversationSidebarProps {
  mode: ConversationMode;
  sessions: ChatSessionMeta[];
  activeSessionId?: string;
  onSelect: (sessionId: string) => void;
  onOpenProject: (workspaceRoot: string) => void;
}

interface ProjectSummary {
  name: string;
  workspaceRoot?: string;
  conversationCount: number;
  updatedAt: number;
}

function ProjectIcon({ mode }: { mode: ConversationMode }) {
  if (mode === "code") {
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M43 23V14C43 12.8954 42.1046 12 41 12H24L19 6H7C5.89543 6 5 6.89543 5 8V40C5 41.1046 5.89543 42 7 42H22" />
        <path d="M38 29L43 34L38 39" />
        <path d="M30 29L25 34L30 39" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path d="M5 8C5 6.89543 5.89543 6 7 6H19L24 12H41C42.1046 12 43 12.8954 43 14V40C43 41.1046 42.1046 42 41 42H7C5.89543 42 5 41.1046 5 40V8Z" />
      <path d="M14 22L19 27L14 32" />
      <path d="M26 32H34" />
    </svg>
  );
}

function ConversationIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 5.5h14v10H9l-4 3v-13Z" />
    </svg>
  );
}

function formatModifiedTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(timestamp);
}

function ProjectInfoCard({
  mode,
  project,
  onOpen,
}: {
  mode: ConversationMode;
  project: ProjectSummary;
  onOpen: () => void;
}) {
  return (
    <section className="cy-project-card" aria-label={`${project.name} 项目信息`}>
      <div className="cy-project-card__name">
        <ProjectIcon mode={mode} />
        <span>{project.name}</span>
      </div>
      <dl className="cy-project-card__details">
        <div><dt>项目名</dt><dd>{project.name}</dd></div>
        <div><dt>对话串数</dt><dd>{project.conversationCount}</dd></div>
        <div><dt>项目路径</dt><dd title={project.workspaceRoot}>{project.workspaceRoot ?? "暂无项目路径"}</dd></div>
        <div><dt>上次修改时间</dt><dd>{formatModifiedTime(project.updatedAt)}</dd></div>
      </dl>
      <button
        className="cy-project-card__open"
        type="button"
        disabled={!project.workspaceRoot}
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
      >
        <ProjectIcon mode={mode} />
        <span>跳转对应文件夹</span>
      </button>
    </section>
  );
}

export function ConversationSidebar({
  mode,
  sessions,
  activeSessionId,
  onSelect,
  onOpenProject,
}: ConversationSidebarProps) {
  const supportsProjects = mode === "work" || mode === "code" || mode === "daily";
  const projects = useMemo(() => {
    const result = new Map<string, ProjectSummary>();
    for (const session of sessions) {
      const key = session.workspaceRoot ?? `unbound:${session.id}`;
      const current = result.get(key);
      if (current) {
        current.conversationCount += 1;
        current.updatedAt = Math.max(current.updatedAt, session.updatedAt);
      } else {
        result.set(key, {
          name: session.workspaceDisplayName ?? "未绑定项目",
          workspaceRoot: session.workspaceRoot,
          conversationCount: 1,
          updatedAt: session.updatedAt,
        });
      }
    }
    return result;
  }, [sessions]);
  const projectKeys = useMemo(() => [...projects.keys()], [projects]);
  const [expandedKeys, setExpandedKeys] = useState<string[]>(projectKeys);

  useEffect(() => {
    setExpandedKeys((current) => [...new Set([...current, ...projectKeys])]);
  }, [projectKeys]);

  const items: ConversationItemType[] = sessions.map((session) => ({
    key: session.id,
    label: session.title || "新对话",
    icon: <ConversationIcon />,
    ...(supportsProjects ? { group: session.workspaceRoot ?? `unbound:${session.id}` } : {}),
  }));

  return (
    <nav className="cy-conversation-sidebar" aria-label={supportsProjects ? "项目与对话" : "对话列表"}>
      <div className="cy-conversation-sidebar__title">{supportsProjects ? "项目" : "对话"}</div>
      {items.length === 0 ? (
        <div className="cy-conversation-sidebar__empty">
          {supportsProjects ? "还没有项目任务" : "还没有对话"}
        </div>
      ) : (
        <Conversations
          rootClassName="cy-conversation-list"
          items={items}
          activeKey={activeSessionId}
          onActiveChange={(key) => onSelect(String(key))}
          groupable={supportsProjects ? {
            collapsible: true,
            expandedKeys,
            onExpand: setExpandedKeys,
            label: (group) => {
              const project = projects.get(group);
              if (!project) return null;
              return (
                <Popover
                  placement="rightTop"
                  mouseEnterDelay={0.25}
                  mouseLeaveDelay={0.12}
                  overlayClassName="cy-project-popover"
                  content={(
                    <ProjectInfoCard
                      mode={mode}
                      project={project}
                      onOpen={() => project.workspaceRoot && onOpenProject(project.workspaceRoot)}
                    />
                  )}
                >
                  <span className="cy-conversation-project">
                    <ProjectIcon mode={mode} />
                    <span>{project.name}</span>
                  </span>
                </Popover>
              );
            },
          } : false}
        />
      )}
    </nav>
  );
}
