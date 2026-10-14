import { createRoot } from "react-dom/client";
import { SkillModePanel } from "../react/features/chat/components/SkillModePanel";
import { PluginModePanel } from "../react/features/chat/components/PluginModePanel";
import { ChatGptOAuthCard } from "../react/features/chat/components/ChatGptOAuthCard";
import { ChatModuleRoutes } from "../react/features/chat/components/ChatModuleRoutes";

let skillsMounted = false;
let pluginsMounted = false;
let oauthMounted = false;
let routesMounted = false;

export function mountReactSettingsPanel(section: string): void {
  if (section === "cyrene" && !routesMounted) {
    const root = document.getElementById("chat-module-routes-root");
    if (root) {
      createRoot(root).render(<ChatModuleRoutes />);
      routesMounted = true;
    }
  }
  if (section === "api" && !oauthMounted) {
    const root = document.getElementById("oauth-profile-root");
    if (root) {
      createRoot(root).render(<ChatGptOAuthCard onSaved={async () => { window.dispatchEvent(new Event("oauth-profile-saved")); }} />);
      oauthMounted = true;
    }
  }
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
