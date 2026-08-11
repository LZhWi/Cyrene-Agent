interface SkillModeButtonProps {
  active?: boolean;
  onClick?: () => void;
}

export function SkillModeButton({ active = false, onClick }: SkillModeButtonProps) {
  return (
    <button
      className={`cy-side-action ${active ? "is-active" : ""}`}
      onClick={onClick}
      type="button"
      title="技能"
      aria-pressed={active}
    >
      <span className="cy-side-action-icon">
        <svg width="16" height="16" viewBox="0 0 48 48" fill="none">
          <path
            d="M18 8L24 16L30 8L38 14L30 20L38 28L30 34L24 26L18 34L10 28L18 20L10 14L18 8Z"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="cy-side-action-label">技能</span>
    </button>
  );
}
