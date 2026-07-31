interface NewTaskButtonProps {
  label?: string;
  onClick?: () => void;
}

export function NewTaskButton({ label = "新建任务", onClick }: NewTaskButtonProps) {
  return (
    <button className="cy-new-task" onClick={onClick} type="button">
      <div className="cy-new-task-icon">
        <svg width="20" height="20" viewBox="0 0 48 48" fill="none">
          <path d="M24.0605 10L24.0239 38" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M10 24L38 24" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <span className="cy-new-task-label">{label}</span>
    </button>
  );
}
