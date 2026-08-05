import type { ReasoningPreference } from "./reasoning";

export interface CallProviderProfile {
  baseUrl: string;
  model: string;
  apiKey: string;
  displayName?: string;
  explicitTransport?: "openai" | "anthropic" | "auto";
  reasoning?: ReasoningPreference;
}

export interface CallModelSettings extends CallProviderProfile {
  schemaVersion: 1;
  provider: string;
  perProvider: Record<string, CallProviderProfile>;
}
