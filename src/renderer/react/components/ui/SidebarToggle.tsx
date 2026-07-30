import { useState } from "react";

interface SidebarToggleProps {
  collapsed?: boolean;
  onToggle?: () => void;
}

export function SidebarToggle({ collapsed: controlledCollapsed, onToggle }: SidebarToggleProps) {
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const collapsed = controlledCollapsed ?? internalCollapsed;

  const handleClick = () => {
    setInternalCollapsed((v) => !v);
    onToggle?.();
  };

  return (
    <button className="cy-sidebar-toggle" onClick={handleClick} aria-label="切换侧栏">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className={collapsed ? "is-collapsed" : ""}>
        <rect x="2" y="3" width="16" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
        <line x1="7" y1="3" x2="7" y2="17" stroke="currentColor" strokeWidth="1.5" className="cy-sidebar-toggle-line" />
      </svg>
    </button>
  );
}
