import type { PluginChatPreferences } from "../../plugins/api";
import type { GeneralSettings } from "../settings/general-settings";

/** Same whitelist for startup snapshots and live preference events; never expose credentials. */
export function chatPreferencesSnapshot(preferences: GeneralSettings): PluginChatPreferences {
  return {
    chatBackend: preferences.chatBackend,
    proactiveChatMode: preferences.proactiveChatMode,
    companionProactivePace: preferences.companionProactivePace,
    proactiveDeliveryTarget: preferences.proactiveDeliveryTarget,
    chatSocialContextEnabled: preferences.chatSocialContextEnabled,
    companionFeedbackLearningEnabled: preferences.companionFeedbackLearningEnabled,
    companionScreenMonitorEnabled: preferences.companionScreenMonitorEnabled,
    companionLifeEnabled: preferences.companionLifeEnabled,
    companionImportantDatesText: preferences.companionImportantDatesText,
  };
}
