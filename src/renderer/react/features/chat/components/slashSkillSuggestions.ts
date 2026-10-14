import type { SkillSuggestionItem } from "../../../../../shared/skill-suggestions";

export function getActiveSlashSkillToken(value: string, start: number, end: number) {
  if (start !== end || !value.startsWith("/")) return null;
  const space = value.search(/\s/);
  const tokenEnd = space < 0 ? value.length : space;
  const query = value.slice(1, tokenEnd);
  if (!/^[a-z0-9-]*$/i.test(query) || start < 1 || start > tokenEnd) return null;
  return { end: tokenEnd, query };
}

export function filterSlashSkillSuggestions(skills: SkillSuggestionItem[], query: string) {
  const q = query.toLowerCase();
  return skills.filter((skill) => `${skill.id}\n${skill.name}\n${skill.description}`.toLowerCase().includes(q))
    .sort((a, b) => Number(b.id.toLowerCase().startsWith(q)) - Number(a.id.toLowerCase().startsWith(q)));
}

export function replaceSlashSkill(value: string, end: number, id: string) {
  const suffix = value.slice(end);
  return `/${id}${/^\s/.test(suffix) ? "" : " "}${suffix}`;
}
