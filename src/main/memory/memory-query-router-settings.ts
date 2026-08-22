import * as fs from "fs";
import * as path from "path";
import { getUserDataDir } from "../runtime/runtime-paths";
import type { MemoryQueryRouterSettings } from "./memory-query-router";

export const DEFAULT_MEMORY_QUERY_ROUTER_SETTINGS: MemoryQueryRouterSettings = {
  enabled: false,
  provider: "自定义",
  baseUrl: "",
  apiKey: "",
  model: "",
  explicitTransport: "auto",
  reasoning: "off",
};

function settingsPath(): string {
  return path.join(getUserDataDir(), "memory-query-router-settings.json");
}

export function normalizeMemoryQueryRouterSettings(value: Partial<MemoryQueryRouterSettings> | null | undefined): MemoryQueryRouterSettings {
  const transport = value?.explicitTransport;
  const reasoning = value?.reasoning;
  const rawProvider = typeof value?.provider === "string" ? value.provider.trim() : "";
  const provider = /^(?:glm|智谱|bigmodel)$/iu.test(rawProvider) ? "GLM（智谱）" : rawProvider || "自定义";
  return {
    enabled: value?.enabled === true,
    provider,
    baseUrl: typeof value?.baseUrl === "string" ? value.baseUrl.trim().replace(/\/+$/, "") : "",
    apiKey: typeof value?.apiKey === "string" ? value.apiKey.trim() : "",
    model: typeof value?.model === "string" ? value.model.trim() : "",
    explicitTransport: transport === "openai" || transport === "anthropic" ? transport : "auto",
    reasoning: reasoning === "low" || reasoning === "auto" ? reasoning : "off",
  };
}

export function loadMemoryQueryRouterSettings(): MemoryQueryRouterSettings {
  try {
    const file = settingsPath();
    if (!fs.existsSync(file)) return { ...DEFAULT_MEMORY_QUERY_ROUTER_SETTINGS };
    return normalizeMemoryQueryRouterSettings(JSON.parse(fs.readFileSync(file, "utf8")) as Partial<MemoryQueryRouterSettings>);
  } catch {
    return { ...DEFAULT_MEMORY_QUERY_ROUTER_SETTINGS };
  }
}

export function saveMemoryQueryRouterSettings(patch: Partial<MemoryQueryRouterSettings>): MemoryQueryRouterSettings {
  const saved = normalizeMemoryQueryRouterSettings({ ...loadMemoryQueryRouterSettings(), ...patch });
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(saved, null, 2), "utf8");
  return saved;
}
