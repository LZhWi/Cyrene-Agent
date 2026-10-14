import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useTranslation } from "../../../i18n";
import { AskUserPanel, PermissionPanel, PopQuizPanel } from "./InteractionPanel";
import { resolveComposerSlot, type ComposerInteraction } from "./run-presentation";
import type { PopQuizSubmission } from "../../../../../shared/pop-quiz";
import "./RunExperience.css";

export function ComposerSlot({
  composer,
  interaction,
  interactionBusy = false,
  onAnswer,
  onIgnore,
  onPermissionDecision,
  onQuizSubmit,
  onQuizSkip,
  collapsible = false,
}: {
  composer: ReactNode;
  interaction?: ComposerInteraction;
  interactionBusy?: boolean;
  onAnswer?: (interactionId: string, answer: unknown) => void;
  onIgnore?: (interactionId: string) => void;
  onPermissionDecision?: (interactionId: string, allowed: boolean) => void;
  onQuizSubmit?: (submission: PopQuizSubmission) => Promise<{ ok: boolean; error?: string; graded?: unknown[] }>;
  onQuizSkip?: (quizId: string) => Promise<{ ok: boolean; error?: string }>;
  collapsible?: boolean;
}) {
  const slot = resolveComposerSlot(interaction);
  const { t } = useTranslation();
  const [collapsedId, setCollapsedId] = useState<string | null>(null);
  const collapsed = collapsible && interaction?.id === collapsedId;

  return (
    <div className={`cy-composer-slot is-${collapsed ? "composer" : slot}${collapsible && interaction ? " has-collapsible-interaction" : ""}`}>
      {collapsible && interaction && <button type="button" className="cy-composer-slot__toggle" aria-expanded={!collapsed}
        onClick={() => setCollapsedId(collapsed ? null : interaction.id)}>
        {collapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        {t(collapsed ? "workspaceUi.restoreInteraction" : "workspaceUi.collapseInteraction")}
      </button>}
      <div className="cy-composer-slot__composer" aria-hidden={interaction && !collapsed ? true : undefined} inert={interaction && !collapsed ? true : undefined}>
        {composer}
      </div>
      {interaction?.kind === "ask" && <div hidden={collapsed} className="cy-composer-slot__card">{(
        <div className="cy-composer-slot__interaction">
          <AskUserPanel
            interaction={interaction}
            disabled={interactionBusy}
            onAnswer={(answer) => onAnswer?.(interaction.id, answer)}
            onIgnore={() => onIgnore?.(interaction.id)}
          />
        </div>
      )}</div>}
      {interaction?.kind === "permission" && <div hidden={collapsed} className="cy-composer-slot__card">{(
        <div className="cy-composer-slot__interaction">
          <PermissionPanel
            interaction={interaction}
            disabled={interactionBusy}
            onDecision={(allowed) => onPermissionDecision?.(interaction.id, allowed)}
          />
        </div>
      )}</div>}
      {interaction?.kind === "quiz" && <div hidden={collapsed} className="cy-composer-slot__card">{(
        <div className="cy-composer-slot__interaction">
          <PopQuizPanel
            interaction={interaction}
            disabled={interactionBusy}
            onSubmit={onQuizSubmit}
            onSkip={onQuizSkip}
          />
        </div>
      )}</div>}
    </div>
  );
}
