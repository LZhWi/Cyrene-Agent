import type { PluginPromptMode } from "@playa0v0/cyrene-plugin-sdk";

declare module "@playa0v0/cyrene-plugin-sdk" {
  interface PluginCompanionContextService {
    memoryContext?(input: { conversationId: string; inputMessageId: string; kinds: Array<"call" | "minecraft">; signal?: AbortSignal }): Promise<string>;
  }
  interface PluginConversationSummary {
    purpose?: "proactive-chat";
  }

  interface PluginLlmService {
    generateTextIfRouted?(messages: import("@playa0v0/cyrene-plugin-sdk").PluginLlmMessage[], options?: import("@playa0v0/cyrene-plugin-sdk").PluginLlmGenerateOptions): Promise<string | null>;
  }

  interface PluginDeps {
    proactiveDocuments?: { search(query: string, signal?: AbortSignal): Promise<string> };
  }

  interface PluginLlmGenerateOptions {
    routingModule?: "soul" | "proactive" | "tools" | "vision" | "memory" | "reflection" | "compression" | "resolver" | "retrieval" | "social" | "cita" | "moments" | "voice" | "translation" | "plugin" | "scheduled";
    reasoning?: "inherit" | "on" | "off";
  }

  interface PluginAssistantDeliveryResult {
    conversationId: string;
    messageId: string;
    at: string;
    deliveredText?: string;
  }

  interface PluginAssistantDeliveryService {
    postProactiveMessage(text: string, options?: { allowIgnoreFeedback?: boolean }): Promise<PluginAssistantDeliveryResult>;
    canPostProactiveMessage?(): Promise<boolean>;
  }

  interface PluginAssistantMessageFeedbackEvent {
    eventId: string;
    timestamp: string;
    pluginId: string;
    conversationId: string;
    messageId: string;
    action: "ignore";
  }

  interface PluginScreenObservationService {
    observeSnapshot(input?: { previousSummary?: string; signal?: AbortSignal }): Promise<{
      text: string;
      noChange: boolean;
    }>;
  }

  interface PluginLlmService {
    generateTextIfRouted?(messages: import("@playa0v0/cyrene-plugin-sdk").PluginLlmMessage[], options?: import("@playa0v0/cyrene-plugin-sdk").PluginLlmGenerateOptions): Promise<string | null>;
  }

  interface PluginDeps {
    assistantDelivery?: PluginAssistantDeliveryService;
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
