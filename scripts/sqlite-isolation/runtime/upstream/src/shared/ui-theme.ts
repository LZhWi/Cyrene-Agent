export type UiTheme = "pearl-white" | "charcoal-pink";
export type UiThemeChoice = UiTheme | "system";

export function normalizeUiTheme(value: unknown): UiTheme {
  return value === "charcoal-pink" ? "charcoal-pink" : "pearl-white";
}

export function normalizeUiThemeChoice(value: unknown): UiThemeChoice {
  return value === "system" ? "system" : normalizeUiTheme(value);
}

export function resolveUiTheme(choice: UiThemeChoice, systemDark: boolean): UiTheme {
  return choice === "system" ? (systemDark ? "charcoal-pink" : "pearl-white") : choice;
}
