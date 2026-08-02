import { useState } from "react";
import type { ReactNode } from "react";
import type { AskUserInteraction, AskUserQuestion, PermissionInteraction } from "./run-presentation";
import "./RunExperience.css";

function PanelShell({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="cy-interaction-panel" aria-label={title}>
      {children}
    </section>
  );
}

export function AskUserPanel({
  interaction,
  disabled = false,
  onAnswer,
  onIgnore,
}: {
  interaction: AskUserInteraction;
  disabled?: boolean;
  onAnswer?: (answer: unknown) => void;
  onIgnore?: () => void;
}) {
  const questions: AskUserQuestion[] = interaction.questions ?? [{
    field: "choice",
    question: interaction.question,
    options: interaction.options,
    allowCustomInput: interaction.allowCustomInput,
  }];
  const [page, setPage] = useState(0);
  const [selectedByField, setSelectedByField] = useState<Record<string, string[]>>({});
  const [customByField, setCustomByField] = useState<Record<string, string>>({});
  const current = questions[Math.min(page, questions.length - 1)];
  const selected = selectedByField[current.field] ?? [];
  const customAnswer = customByField[current.field] ?? "";
  const selectedValues = selected.filter((value) => value !== "__custom__");
  const canContinue = selectedValues.length > 0 || Boolean(customAnswer.trim());
  const isLastQuestion = page === questions.length - 1;
  const submit = () => {
    if (!isLastQuestion) {
      setPage((currentPage) => Math.min(currentPage + 1, questions.length - 1));
      return;
    }
    if (interaction.responseKind === "clarification") {
      onAnswer?.({
        requestId: interaction.id,
        answers: questions.flatMap((question) => {
          const selectedValues = (selectedByField[question.field] ?? []).filter((value) => value !== "__custom__");
          const customText = customByField[question.field]?.trim();
          if (customText) return [{ field: question.field, customText }];
          return selectedValues.length ? [{ field: question.field, selectedValues }] : [];
        }),
      });
      return;
    }
    onAnswer?.(customAnswer.trim() || selectedValues[0]);
  };

  return (
    <PanelShell title="昔涟正在询问">
      <div className="cy-interaction-panel__heading">
        <span className="cy-interaction-panel__status">昔涟正在询问</span>
        {questions.length > 1 && <span className="cy-interaction-panel__page">{page + 1} / {questions.length}</span>}
      </div>
      <p className="cy-interaction-panel__question">{current.question}</p>
      <div className="cy-interaction-panel__options" role={current.multiple ? "group" : "radiogroup"} aria-label={current.question}>
        {current.options.map((option, index) => (
          <button
            type="button"
            key={option.id}
            className={selected.includes(option.id) ? "is-selected" : ""}
            role={current.multiple ? "checkbox" : "radio"}
            aria-checked={selected.includes(option.id)}
            disabled={disabled}
            onClick={() => {
              setCustomByField((values) => ({ ...values, [current.field]: "" }));
              setSelectedByField((values) => ({
                ...values,
                [current.field]: current.multiple
                  ? (selected.includes(option.id) ? selected.filter((value) => value !== option.id) : [...selected, option.id])
                  : [option.id],
              }));
            }}
          >
            <span className="cy-interaction-panel__option-index">{index + 1}.</span>
            <span>
              <strong>{option.label}</strong>
              {option.description && <small>{option.description}</small>}
            </span>
          </button>
        ))}
      </div>
      {current.allowCustomInput !== false && (
        <label className="cy-interaction-panel__custom-answer">
          <span>其他回答</span>
          <input
            value={customAnswer}
            disabled={disabled}
            placeholder={current.freeTextPlaceholder ?? "输入你的回答…"}
            onChange={(event) => {
              setCustomByField((values) => ({ ...values, [current.field]: event.target.value }));
              if (event.target.value.trim()) setSelectedByField((values) => ({ ...values, [current.field]: [] }));
            }}
          />
        </label>
      )}
      <div className="cy-interaction-panel__actions">
        {interaction.responseKind !== "clarification" && <button type="button" disabled={disabled} onClick={onIgnore}>忽略</button>}
        <button type="button" className="is-primary" disabled={disabled || !canContinue} onClick={submit}>{isLastQuestion ? "提交" : "下一项"}</button>
      </div>
    </PanelShell>
  );
}

export function PermissionPanel({
  interaction,
  disabled = false,
  onDecision,
}: {
  interaction: PermissionInteraction;
  disabled?: boolean;
  onDecision?: (allowed: boolean) => void;
}) {
  return (
    <PanelShell title="昔涟正在获取审批">
      <div className="cy-interaction-panel__heading">
        <span className="cy-interaction-panel__status">昔涟正在获取审批</span>
        <code>{interaction.toolName}</code>
      </div>
      <p className="cy-interaction-panel__question">{interaction.summary}</p>
      <dl className="cy-interaction-panel__metadata">
        {interaction.workspaceName && <><dt>工作区</dt><dd>{interaction.workspaceName}</dd></>}
        {interaction.targetPath && <><dt>目标</dt><dd title={interaction.targetPath}>{interaction.targetPath}</dd></>}
      </dl>
      <div className="cy-interaction-panel__actions">
        <button type="button" disabled={disabled} onClick={() => onDecision?.(false)}>拒绝</button>
        <button type="button" className="is-primary" disabled={disabled} onClick={() => onDecision?.(true)}>允许</button>
      </div>
    </PanelShell>
  );
}
