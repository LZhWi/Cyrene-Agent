import type { UiTheme } from "../../shared/ui-theme";

export interface AppearanceSettingsInput {
  uiTheme: UiTheme;
  petAlwaysOnTop: boolean;
  petVisible: boolean;
  petZoom: number;
}

export function buildAppearanceSettingsPatch(input: AppearanceSettingsInput): AppearanceSettingsInput {
  return { ...input };
}
