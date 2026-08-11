interface ToolModeButtonProps {
  active?: boolean;
  onClick?: () => void;
}

export function ToolModeButton({ active = false, onClick }: ToolModeButtonProps) {
  return (
    <button
      className={`cy-side-action ${active ? "is-active" : ""}`}
      onClick={onClick}
      type="button"
      title="工具"
      aria-pressed={active}
    >
      <span className="cy-side-action-icon">
        <svg width="16" height="16" viewBox="0 0 48 48" fill="none">
          <path
            d="M31.5 9.5a9.5 9.5 0 0 0-9.32 11.34L9.05 33.97a4.6 4.6 0 0 0 0 6.5l.48.48a4.6 4.6 0 0 0 6.5 0l13.13-13.13A9.5 9.5 0 1 0 31.5 9.5Z"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="cy-side-action-label">工具</span>
    </button>
  );
}
