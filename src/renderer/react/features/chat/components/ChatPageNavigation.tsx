import React, { useEffect, useState } from "react";
import { Input, Modal } from "antd";
import { CalendarClock, Search } from "lucide-react";
import type { ChatSessionMeta, ConversationMode } from "../../../../../shared/chat-types";
import type { SidebarOrganizationDraft, SidebarOrganizationSnapshot } from "../../../../../shared/sidebar-organization";
import { useTranslation } from "../../../i18n";
import { ModeSwitch } from "../../../components/ui/ModeSwitch";
import { ModelModeButton } from "../../../components/ui/ModelModeButton";
import { MomentsModeButton } from "../../../components/ui/MomentsModeButton";
import { NewTaskButton } from "../../../components/ui/NewTaskButton";
import { PluginModeButton } from "../../../components/ui/PluginModeButton";
import { SettingsButton } from "../../../components/ui/SettingsButton";
import { SidebarToggle } from "../../../components/ui/SidebarToggle";
import { SkillModeButton } from "../../../components/ui/SkillModeButton";
import { ToolModeButton } from "../../../components/ui/ToolModeButton";
import { UserAvatar } from "../../../components/ui/UserAvatar";
import { WindowControls } from "../../../components/ui/WindowControls";
import { AppUpdateEntry } from "./AppUpdateEntry";
import { ConversationSidebar } from "./ConversationSidebar";
import { WorkspaceConversationSidebar } from "./WorkspaceConversationSidebar";
import { sessionSearchResults, sessionTime } from "./workspace-ui";

export type ChatPagePanel = "tool" | "skill" | "model" | "plugin" | "moments" | "scheduledTasks";

export interface ChatPageNavigationProps {
  windowKind?: "chat" | "workspace";
  collapsed: boolean;
  activePanel: ChatPagePanel | null;
  mode: ConversationMode;
  companionLifeStatus?: { text: string; resting: boolean } | null;
  titlebarControls?: React.ReactNode;
  sessions: ChatSessionMeta[];
  sidebarSessions?: ChatSessionMeta[];
  sidebarOrganization?: SidebarOrganizationSnapshot | null;
  onSaveSidebarOrganization?: (draft: SidebarOrganizationDraft) => Promise<boolean>;
  activeSessionId?: string;
  onToggleCollapsed: () => void;
  onModeChange: (mode: string) => void;
  onNewTask: () => void;
  onTogglePanel: (panel: ChatPagePanel) => void;
  onSelectSession: (sessionId: string) => void;
  onOpenProject: (workspaceRoot: string) => void;
  onRenameSession: (sessionId: string, newTitle: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onTogglePinSession: (sessionId: string, pinned: boolean) => void;
  onMinimize: () => void;
  onMaximize: () => void;
  onCloseWindow: () => void;
  onOpenSettings: () => void;
  onOpenTasks?: () => void;
  onSearchSessions?: () => Promise<ChatSessionMeta[]>;
  onSelectSearchSession?: (session: ChatSessionMeta) => void;
}

export function ChatPageNavigation({
  windowKind,
  collapsed,
  activePanel,
  mode,
  companionLifeStatus,
  titlebarControls,
  sessions,
  sidebarSessions,
  sidebarOrganization,
  onSaveSidebarOrganization,
  activeSessionId,
  onToggleCollapsed,
  onModeChange,
  onNewTask,
  onTogglePanel,
  onSelectSession,
  onOpenProject,
  onRenameSession,
  onDeleteSession,
  onTogglePinSession,
  onMinimize,
  onMaximize,
  onCloseWindow,
  onOpenSettings,
  onOpenTasks,
  onSearchSessions,
  onSelectSearchSession,
}: ChatPageNavigationProps) {
  const hasOpenPanel = activePanel !== null;
  const { t } = useTranslation();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchSessions, setSearchSessions] = useState<ChatSessionMeta[]>([]);
  const [searchError, setSearchError] = useState("");
  const searchResults = sessionSearchResults(searchSessions, searchQuery);

  function openSearch() {
    setSearchQuery("");
    setSearchSessions(sidebarSessions ?? sessions);
    setSearchError("");
    setSearchOpen(true);
    void onSearchSessions?.().then(setSearchSessions).catch((error) => setSearchError(String(error)));
  }

  useEffect(() => {
    if (windowKind !== "workspace") return;
    function onSearchShortcut(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase() !== "k") return;
      event.preventDefault();
      openSearch();
    }
    window.addEventListener("keydown", onSearchShortcut);
    return () => window.removeEventListener("keydown", onSearchShortcut);
  }, [windowKind, onSearchSessions]);

  return (
    <>
      <div className="cy-page-drag-region" aria-hidden="true" />
      {mode === "chat" && (
        <div className="cy-chat-topfade" aria-hidden="true">
          <div className="cy-chat-topfade__blur" />
        </div>
      )}
      <div className="cy-page-toggle">
        <SidebarToggle collapsed={collapsed} onToggle={onToggleCollapsed} />
      </div>
      {!hasOpenPanel && mode === "chat" && companionLifeStatus && (
        <div className="cy-page-title-meta">
          <span className="cy-companion-life-status" aria-live="polite">
            <span aria-hidden="true">{companionLifeStatus.resting ? "🌙" : "🌸"}</span>
            <span className="cy-companion-life-status__text">昔涟 · {companionLifeStatus.text}</span>
          </span>
        </div>
      )}
      <div className="cy-page-top-center">
        {!hasOpenPanel && <ModeSwitch value={mode} onChange={onModeChange} variant={mode === "chat" ? "cyrene-chat" : "upstream"} availableModes={windowKind === "chat" ? ["chat"] : windowKind === "workspace" ? ["work", "code", "learn"] : undefined} />}
      </div>
      <div className="cy-page-windows">
        <WindowControls onMinimize={onMinimize} onMaximize={onMaximize} onClose={onCloseWindow} />
      </div>
      {titlebarControls && <div className="cy-page-title-controls">{titlebarControls}</div>}
      <div className="cy-page-sidebar">
        <div className="cy-page-newtask">
          <NewTaskButton onClick={onNewTask} />
          {windowKind === "workspace" && (
            <>
              <button className="cy-side-action cy-workspace-side-action" type="button" onClick={openSearch}>
                <span className="cy-side-action-icon"><Search size={18} /></span><span className="cy-side-action-label">{t("sidebar.searchAction")}</span><kbd>Ctrl+K</kbd>
              </button>
              <button className="cy-side-action cy-workspace-side-action" type="button" onClick={onOpenTasks}>
                <span className="cy-side-action-icon"><CalendarClock size={18} /></span><span className="cy-side-action-label">{t("sidebar.scheduledTasks")}</span>
              </button>
            </>
          )}
          {windowKind !== "workspace" && <>
            <ToolModeButton active={activePanel === "tool"} onClick={() => onTogglePanel("tool")} />
            <SkillModeButton active={activePanel === "skill"} onClick={() => onTogglePanel("skill")} />
            <ModelModeButton active={activePanel === "model"} onClick={() => onTogglePanel("model")} />
            <PluginModeButton active={activePanel === "plugin"} onClick={() => onTogglePanel("plugin")} />
          </>}
          <MomentsModeButton active={activePanel === "moments"} onClick={() => onTogglePanel("moments")} />
        </div>
        <div className="cy-page-conversations">
          {windowKind === "workspace" && (mode === "work" || mode === "code") && sidebarOrganization && onSaveSidebarOrganization ? <WorkspaceConversationSidebar
            mode={mode}
            sessions={sidebarSessions ?? sessions}
            organization={sidebarOrganization}
            activeSessionId={activeSessionId}
            onSaveOrganization={onSaveSidebarOrganization}
            onSelect={onSelectSession}
            onOpenProject={onOpenProject}
            onRename={onRenameSession}
            onDelete={onDeleteSession}
            onTogglePin={onTogglePinSession}
          /> : <ConversationSidebar
            mode={mode}
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelect={onSelectSession}
            onOpenProject={onOpenProject}
            onRename={onRenameSession}
            onDelete={onDeleteSession}
            onTogglePin={onTogglePinSession}
          />}
        </div>
        <AppUpdateEntry />
        <div className="cy-page-sidebar-bottom">
          <UserAvatar />
          <SettingsButton onClick={onOpenSettings} />
        </div>
      </div>
      {windowKind === "workspace" && <Modal open={searchOpen} footer={null} title={t("sidebar.searchAction")} onCancel={() => setSearchOpen(false)} width={520} destroyOnHidden>
        <Input autoFocus allowClear prefix={<Search size={16} />} placeholder={t("sidebar.searchSessions")} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
        <div className="cy-workspace-search-results">
          {searchError && <p role="alert">{searchError}</p>}
          {!searchQuery.trim() && <p>{t("workspaceUi.recentSessions")}</p>}
          {searchResults.length === 0 ? <p>{t("sidebar.noSearchResults")}</p> : searchResults.map((session) => (
            <button key={session.id} type="button" className="cy-workspace-search-result" aria-current={session.id === activeSessionId ? "page" : undefined} onClick={() => { setSearchOpen(false); onSelectSearchSession?.(session); }}>
              <span>{session.title || t("sidebar.defaultSessionTitle")}</span>
              <small>{session.workspaceDisplayName || session.mode} · {sessionTime(session.updatedAt)}</small>
            </button>
          ))}
        </div>
      </Modal>}
    </>
  );
}
