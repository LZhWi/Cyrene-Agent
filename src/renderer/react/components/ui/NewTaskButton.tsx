interface NewTaskButtonProps {
  label?: string;
  onClick?: () => void;
}

export function NewTaskButton({ label = "新建", onClick }: NewTaskButtonProps) {
  return (
    <button className="cy-side-action" onClick={onClick} type="button">
      <span className="cy-side-action-icon">
        <svg width="16" height="16" viewBox="0 0 48 48" fill="none">
          <circle cx="24" cy="24" r="19" stroke="currentColor" strokeWidth="4" />
          <path d="M24 16V32M16 24H32" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
        </svg>
      </span>
      <span className="cy-side-action-label">{label}</span>
    </button>
  );
}
