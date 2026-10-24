import { nativeTheme } from "electron";
import { resolveUiTheme, type UiTheme, type UiThemeChoice } from "../shared/ui-theme";

export function getEffectiveUiTheme(choice: UiThemeChoice): UiTheme {
  return resolveUiTheme(choice, nativeTheme.shouldUseDarkColors);
}

export function watchSystemUiTheme(
  getChoice: () => UiThemeChoice,
  broadcast: (theme: UiTheme) => void,
): () => void {
  const onUpdated = () => {
    const choice = getChoice();
    if (choice === "system") broadcast(getEffectiveUiTheme(choice));
  };
  nativeTheme.on("updated", onUpdated);
  return () => nativeTheme.off("updated", onUpdated);
}
