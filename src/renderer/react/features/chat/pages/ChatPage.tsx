import { useState } from "react";
import { SidebarToggle } from "../../../components/ui/SidebarToggle";
import "../../../components/ui/SidebarToggle.css";

export function ChatPage() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className={`cy-page ${collapsed ? "is-collapsed" : ""}`}>
      <div className="cy-page-toggle">
        <SidebarToggle collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} />
      </div>
      <div className="cy-workspace" />
    </div>
  );
}
