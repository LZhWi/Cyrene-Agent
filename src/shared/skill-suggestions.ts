export interface SkillSuggestionItem {
  id: string;
  name: string;
  description: string;
  source: "builtin" | "user";
}
