import type { UiTheme } from "../../shared/ui-theme";
import type { UiIcon } from "../../shared/ui-icon";

export interface AppearanceSettingsInput {
  uiTheme: UiTheme;
  uiIcon: UiIcon;
  petAlwaysOnTop: boolean;
  petVisible: boolean;
  petZoom: number;
  chatLineHeight: number;
  chatParaSpacing: number;
}

export function buildAppearanceSettingsPatch(input: AppearanceSettingsInput): AppearanceSettingsInput {
  return { ...input };
}
