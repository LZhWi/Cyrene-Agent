import { loadGeneralSettings } from "../settings/settings-facade";
import { loadModelSettings } from "../settings/model-settings";
import type { GeneralSettings } from "../settings/general-settings";
import { registerEmailTools } from "./email-tools";
import { registerDocumentTools } from "./document-tools";
// fs-tools / built-in-tools 仍依赖模块加载副作用，先集中在此，后续可继续显式化
import "./fs-tools";
import { registerLifeTools, setTranslateConfig } from "./life-tools";
import { registerRecallHistoryTool } from "./history-tools";
import { registerSearchCodeTool } from "./search-code-tools";
import { toolRegistry } from "./tool-registry";
import { registerTravelTools } from "./travel-tools";
import type { GitService } from "../code-git/git-service";
import { registerCodeGitTools } from "./git-tools";
import "./built-in-tools";

export function syncBuiltInToolToggles(settings: GeneralSettings): void {
  toolRegistry.setEnabled("weather", settings.weatherEnabled);
  toolRegistry.setEnabled("plan_trip", settings.travelEnabled);
}

export function registerAllTools(deps: { codeGitService: GitService }): void {
  registerCodeGitTools(deps.codeGitService, toolRegistry);
  registerSearchCodeTool();
  registerRecallHistoryTool();
  registerDocumentTools();

  setTranslateConfig(() => {
    const s = loadModelSettings();
    return s.apiKey
      ? { provider: s.provider, baseUrl: s.baseUrl, model: s.model, apiKey: s.apiKey }
      : null;
  });
  registerLifeTools();

  registerTravelTools();
  registerEmailTools();

  syncBuiltInToolToggles(loadGeneralSettings());
}
