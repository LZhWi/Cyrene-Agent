import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { foldReasoning, normalizeReasoningPreference } from "../../shared/reasoning";
import type {
  WorkModelSelection,
  WorkModelSettings,
  WorkProviderProfile,
  WorkVisionModelConfig,
} from "../../shared/work-types";

function settingsPath(): string {
  return path.join(app.getPath("userData"), "cyrene-work", "settings.json");
}

function normalizeProfile(input: Partial<WorkProviderProfile> | null | undefined): WorkProviderProfile {
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

function normalizeVision(input: Partial<WorkVisionModelConfig> | null | undefined): WorkVisionModelConfig | undefined {
  if (!input || typeof input !== "object") return undefined;
  return {
    syncWithMain: input.syncWithMain === true,
    baseUrl: typeof input.baseUrl === "string" ? input.baseUrl.trim() : "",
    apiKey: typeof input.apiKey === "string" ? input.apiKey.trim() : "",
    model: typeof input.model === "string" ? input.model.trim() : "",
  };
}

export function loadWorkModelSettings(): WorkModelSettings | null {
  const filePath = settingsPath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<WorkModelSettings>;
    if (value.schemaVersion !== 2 || typeof value.provider !== "string" || !value.provider.trim()) return null;
    const perProvider: Record<string, WorkProviderProfile> = {};
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
    return { schemaVersion: 2, provider, perProvider, ...profile, vision: normalizeVision(value.vision) };
  } catch {
    return null;
  }
}

export function loadLegacyWorkModelSelection(): WorkModelSelection | null {
  const filePath = settingsPath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<WorkModelSelection> & { schemaVersion?: unknown };
    return value.schemaVersion !== 2 && typeof value.provider === "string" && typeof value.model === "string"
      ? { provider: value.provider.trim(), model: value.model.trim() }
      : null;
  } catch {
    return null;
  }
}

export function saveWorkModelSettings(input: Partial<WorkModelSettings>): WorkModelSettings {
  const existing = loadWorkModelSettings();
  const provider = typeof input.provider === "string" && input.provider.trim()
    ? input.provider.trim()
    : existing?.provider ?? "";
  if (!provider) throw new Error("Work provider is required");
  const perProvider: Record<string, WorkProviderProfile> = { ...(existing?.perProvider ?? {}) };
  if (input.perProvider && typeof input.perProvider === "object") {
    for (const [key, value] of Object.entries(input.perProvider)) {
      if (key.trim()) perProvider[key.trim()] = normalizeProfile(value);
    }
  }
  const previous = perProvider[provider] ?? normalizeProfile(null);
  const incomingReasoning = Object.prototype.hasOwnProperty.call(input, "reasoning")
    ? input.reasoning
    : undefined;
  const profile = normalizeProfile({
    baseUrl: typeof input.baseUrl === "string" ? input.baseUrl : previous.baseUrl,
    model: typeof input.model === "string" ? input.model : previous.model,
    apiKey: typeof input.apiKey === "string" ? input.apiKey : previous.apiKey,
    displayName: typeof input.displayName === "string" ? input.displayName : previous.displayName,
    explicitTransport: input.explicitTransport ?? previous.explicitTransport,
    reasoning: foldReasoning(incomingReasoning, previous.reasoning, Object.prototype.hasOwnProperty.call(input, "reasoning")),
  });
  perProvider[provider] = profile;
  const vision = Object.prototype.hasOwnProperty.call(input, "vision")
    ? normalizeVision(input.vision)
    : existing?.vision;
  const normalized: WorkModelSettings = { schemaVersion: 2, provider, perProvider, ...profile, vision };
  const filePath = settingsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(normalized, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
  return normalized;
}
