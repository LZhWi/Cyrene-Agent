import { createRoot } from "react-dom/client";
import { SkillModePanel } from "../react/features/chat/components/SkillModePanel";
import { PluginModePanel } from "../react/features/chat/components/PluginModePanel";

let skillsMounted = false;
let pluginsMounted = false;

export function mountReactSettingsPanel(section: string): void {
  if (section === "skills" && !skillsMounted) {
    const root = document.getElementById("skills-react-root");
    if (root) {
      createRoot(root).render(<SkillModePanel />);
      skillsMounted = true;
    }
  }
  if (section === "feature-plugins" && !pluginsMounted) {
    const root = document.getElementById("feature-plugins-react-root");
    if (root) {
      createRoot(root).render(<PluginModePanel />);
      pluginsMounted = true;
    }
  }
}
