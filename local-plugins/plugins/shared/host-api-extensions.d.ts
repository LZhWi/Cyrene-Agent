import type { PluginPromptMode } from "@playa0v0/cyrene-plugin-sdk";

declare module "@playa0v0/cyrene-plugin-sdk" {
  interface PluginAssistantDeliveryResult {
    conversationId: string;
    messageId: string;
    at: string;
  }

  interface PluginAssistantDeliveryService {
    postProactiveMessage(text: string, options?: { allowIgnoreFeedback?: boolean }): Promise<PluginAssistantDeliveryResult>;
  }

  interface PluginAssistantMessageFeedbackEvent {
    eventId: string;
    timestamp: string;
    pluginId: string;
    conversationId: string;
    messageId: string;
    action: "ignore";
  }

  interface PluginDeps {
    assistantDelivery?: PluginAssistantDeliveryService;
    screenObservation?: {
      observe(input?: { focus?: string; signal?: AbortSignal }): Promise<string>;
    };
  }

  interface PluginStablePromptProviderInput {
    source: "conversation";
    mode: PluginPromptMode;
    conversationId: string;
    channel?: string;
    target: "soul" | "tool" | "tone" | "soul-tail";
    readonly signal: AbortSignal;
  }

  interface PluginStablePromptProvider {
    id: string;
    modes?: PluginPromptMode[];
    target?: "soul" | "tool" | "tone" | "soul-tail";
    provide(input: PluginStablePromptProviderInput): string | Promise<string>;
  }

  interface PluginContext {
    registerStablePromptProvider?(provider: PluginStablePromptProvider): void;
    unregisterStablePromptProvider?(providerId: string): void;
  }
}
