import { useState } from "react";
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

import avatarDark from "../../../assets/avatars/avatar-dark.png";
import avatarLight from "../../../assets/avatars/avatar-light.png";

export function ChatPage() {
  const [collapsed, setCollapsed] = useState(false);
  const [mode, setMode] = useState("chat");

  const taskLabel = ["work", "daily", "code"].includes(mode) ? "新建任务" : "新建对话";

  return (
    <div className={`cy-page ${collapsed ? "is-collapsed" : ""}`}>
      <div className="cy-page-toggle">
        <SidebarToggle collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} />
      </div>
      <div className="cy-page-mode">
        <ModeSwitch value={mode} onChange={setMode} />
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
      <div className="cy-workspace" />
    </div>
  );
}
