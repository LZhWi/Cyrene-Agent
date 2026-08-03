import "./ClineModeSwitch.css";

export type ClineMode = "plan" | "act";

export function ClineModeSwitch({
  value,
  disabled = false,
  onChange,
}: {
  value: ClineMode;
  disabled?: boolean;
  onChange: (mode: ClineMode) => void;
}) {
  return (
    <div className="cy-cline-mode-switch" role="group" aria-label="Cline 执行模式">
      {(["plan", "act"] as const).map((mode) => (
        <button
          type="button"
          key={mode}
          className={value === mode ? "is-active" : ""}
          aria-pressed={value === mode}
          disabled={disabled}
          title={mode === "plan" ? "先规划，不修改文件" : "允许执行并修改工作区"}
          onClick={() => onChange(mode)}
        >
          {mode === "plan" ? "Plan" : "Act"}
        </button>
      ))}
    </div>
  );
}
