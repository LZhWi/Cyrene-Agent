import { useState } from "react";
import { ChevronDown, ChevronUp, Pencil, X } from "lucide-react";
import { useTranslation } from "../../../i18n";

export function PendingQueueDock({ items, onRemove, onEdit }: {
  items: Array<{ id: string; content: string; attachmentNames?: string[] }>;
  onRemove?: (id: string) => void;
  onEdit?: (id: string, content: string) => boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);
  if (!items.length) return null;
  return <div className="cy-pending-queue">
    <button type="button" className="cy-pending-queue__heading" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}{t("composer.queueLabel")} · {items.length}
    </button>
    {expanded && items.map((item) => <div className="cy-pending-queue__item" key={item.id}>
      {editing?.id === item.id ? <div className="cy-pending-queue__editor">
        <textarea autoFocus aria-label={t("workspaceUi.editQueuedMessage")} value={editing.content} onChange={(event) => setEditing({ id: item.id, content: event.target.value })} />
        <button type="button" disabled={!editing.content.trim() && !item.attachmentNames?.length} onClick={() => {
          if (onEdit?.(item.id, editing.content)) setEditing(null);
        }}>{t("common.confirm")}</button>
        <button type="button" onClick={() => setEditing(null)}>{t("common.cancel")}</button>
      </div> : <>
        <span className="cy-pending-queue__text">{item.content || t("composer.attachmentsLabel")}
          {!!item.attachmentNames?.length && <small>{item.attachmentNames.join(" · ")}</small>}
        </span>
        {onEdit && <button type="button" aria-label={t("workspaceUi.editQueuedMessage")} onClick={() => setEditing({ id: item.id, content: item.content })}><Pencil size={13} /></button>}
      </>}
      <button type="button" aria-label={t("composer.removeQueuedMessage")} onClick={() => onRemove?.(item.id)}><X size={14} /></button>
    </div>)}
  </div>;
}
