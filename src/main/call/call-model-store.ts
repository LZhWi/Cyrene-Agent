import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { foldReasoning, normalizeReasoningPreference } from "../../shared/reasoning";
import type { CallModelSettings, CallProviderProfile } from "../../shared/call-types";

function settingsPath(): string {
  return path.join(app.getPath("userData"), "cyrene-call", "settings.json");
}

function normalizeProfile(input: Partial<CallProviderProfile> | null | undefined): CallProviderProfile {
  return {
    baseUrl: typeof input?.baseUrl === "string" ? input.baseUrl.trim() : "",
    model: typeof input?.model === "string" ? input.model.trim() : "",
    apiKey: typeof input?.apiKey === "string" ? input.apiKey.trim() : "",
    displayName: typeof input?.displayName === "string" && input.displayName.trim()
      ? input.displayName.trim()
      : undefined,
    explicitTransport: input?.explicitTransport === "openai"
      || input?.explicitTransport === "anthropic"
      || input?.explicitTransport === "auto"
      ? input.explicitTransport
      : undefined,
    reasoning: normalizeReasoningPreference(input?.reasoning),
  };
}

export function loadCallModelSettings(): CallModelSettings | null {
  const filePath = settingsPath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<CallModelSettings>;
    if (value.schemaVersion !== 1 || typeof value.provider !== "string" || !value.provider.trim()) return null;
    const perProvider: Record<string, CallProviderProfile> = {};
    if (value.perProvider && typeof value.perProvider === "object") {
      for (const [provider, profile] of Object.entries(value.perProvider)) {
        if (provider.trim() && profile && typeof profile === "object") {
          perProvider[provider.trim()] = normalizeProfile(profile);
        }
      }
    }
    const provider = value.provider.trim();
    const profile = perProvider[provider] ?? normalizeProfile(value);
    perProvider[provider] = profile;
    return { schemaVersion: 1, provider, perProvider, ...profile };
  } catch {
    return null;
  }
}

export function saveCallModelSettings(input: Partial<CallModelSettings>): CallModelSettings {
  const existing = loadCallModelSettings();
  const provider = typeof input.provider === "string" && input.provider.trim()
    ? input.provider.trim()
    : existing?.provider ?? "";
  if (!provider) throw new Error("Call provider is required");

  const perProvider: Record<string, CallProviderProfile> = { ...(existing?.perProvider ?? {}) };
  if (input.perProvider && typeof input.perProvider === "object") {
    for (const [key, value] of Object.entries(input.perProvider)) {
      if (key.trim()) perProvider[key.trim()] = normalizeProfile(value);
    }
  }

  const previous = perProvider[provider] ?? normalizeProfile(null);
  const hasReasoning = Object.prototype.hasOwnProperty.call(input, "reasoning");
  const profile = normalizeProfile({
    baseUrl: typeof input.baseUrl === "string" ? input.baseUrl : previous.baseUrl,
    model: typeof input.model === "string" ? input.model : previous.model,
    apiKey: typeof input.apiKey === "string" ? input.apiKey : previous.apiKey,
    displayName: typeof input.displayName === "string" ? input.displayName : previous.displayName,
    explicitTransport: input.explicitTransport ?? previous.explicitTransport,
    reasoning: foldReasoning(hasReasoning ? input.reasoning : undefined, previous.reasoning, hasReasoning),
  });
  perProvider[provider] = profile;

  const normalized: CallModelSettings = { schemaVersion: 1, provider, perProvider, ...profile };
  const filePath = settingsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(normalized, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
  return normalized;
}
