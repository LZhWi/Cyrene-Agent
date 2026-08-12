interface ModelModeButtonProps {
  active?: boolean;
  onClick?: () => void;
}

export function ModelModeButton({ active = false, onClick }: ModelModeButtonProps) {
  return <button className={`cy-side-action ${active ? "is-active" : ""}`} onClick={onClick} type="button" title="模型" aria-pressed={active}>
    <span className="cy-side-action-icon">◈</span><span className="cy-side-action-label">模型</span>
  </button>;
}
