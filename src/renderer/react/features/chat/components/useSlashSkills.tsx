import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { SkillSuggestionItem } from "../../../../../shared/skill-suggestions";
import { filterSlashSkillSuggestions, getActiveSlashSkillToken, replaceSlashSkill } from "./slashSkillSuggestions";
import { useTranslation } from "../../../i18n";

export function useSlashSkills(mode: string, value: string, onChange: (value: string) => void) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<[number, number]>([0, 0]);
  const [dismissed, setDismissed] = useState(false);
  const [index, setIndex] = useState(0);
  const [skills, setSkills] = useState<SkillSuggestionItem[]>([]);
  const [error, setError] = useState(false);
  const [composing, setComposing] = useState(false);
  const enabled = ["work", "code", "learn"].includes(mode);
  const token = enabled && !dismissed && !composing ? getActiveSlashSkillToken(value, ...cursor) : null;
  const open = Boolean(token);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setSkills([]);
    setError(false);
    const api = (window as unknown as { settings?: { getSkillSuggestions?: (mode: string) => Promise<SkillSuggestionItem[]> } }).settings;
    void (api?.getSkillSuggestions?.(mode) ?? Promise.resolve([])).then((items) => {
      if (active) setSkills(items);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [open, mode]);
  useEffect(() => { setIndex(0); setDismissed(false); }, [value, mode]);
  const items = token ? filterSlashSkillSuggestions(skills, token.query) : [];
  const selected = Math.min(index, Math.max(0, items.length - 1));
  useEffect(() => {
    host.current?.querySelector<HTMLElement>('.cy-slash-skills [aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [selected, open]);
  function trackCursor() {
    const input = host.current?.querySelector("textarea");
    if (input) setCursor([input.selectionStart, input.selectionEnd]);
  }
  function choose(skill: SkillSuggestionItem) {
    if (!token) return;
    onChange(replaceSlashSkill(value, token.end, skill.id));
    setDismissed(true);
    requestAnimationFrame(() => {
      const input = host.current?.querySelector("textarea");
      input?.focus();
      input?.setSelectionRange(skill.id.length + 2, skill.id.length + 2);
      trackCursor();
    });
  }
  function onKeyDownCapture(event: KeyboardEvent<HTMLDivElement>) {
    if (!open || composing || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); setDismissed(true);
    } else if (items.length && ["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (event.key === "ArrowDown") setIndex((selected + 1) % items.length);
      else if (event.key === "ArrowUp") setIndex((selected + items.length - 1) % items.length);
      else choose(items[selected]);
    }
  }
  return {
    host, trackCursor, onKeyDownCapture,
    onCompositionStart: () => setComposing(true),
    onCompositionEnd: () => { setComposing(false); trackCursor(); },
    menu: open ? <div className="cy-slash-skills" role="listbox" aria-label={t("composer.skillSuggestions")}>
      {items.length ? items.map((skill, i) => <button type="button" role="option" aria-selected={i === selected}
        key={skill.id} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(skill)}>
        <strong>/{skill.id}</strong><span>{skill.name}</span><small>{skill.description}</small>
      </button>) : <span role="status">{t(error ? "composer.skillSuggestionsError" : "composer.skillSuggestionsEmpty")}</span>}
    </div> : null,
  };
}
