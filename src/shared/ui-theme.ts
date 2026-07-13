export type UiTheme = "classic" | "pearl-white";

export function normalizeUiTheme(value: unknown): UiTheme {
  return value === "pearl-white" ? "pearl-white" : "classic";
}
