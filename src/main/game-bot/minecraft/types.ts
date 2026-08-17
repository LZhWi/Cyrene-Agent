export interface MinecraftBotSettings {
  host: string;
  port: number;
  username: string;
  auth: "microsoft" | "offline";
  owner: string;
  version: string;
  reconnect: boolean;
  autonomy: MinecraftAutonomySettings;
  soul: MinecraftSoulLlmSettings;
  llm: MinecraftLlmSettings;
}

export interface MinecraftAutonomySettings {
  mode: "passive" | "companion" | "survival";
  visionEnabled: boolean;
}

export interface MinecraftSoulLlmSettings {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoning: "auto" | "off" | "low" | "medium" | "high";
}

export interface MinecraftLlmSettings {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxSteps: number;
  reasoning: "auto" | "off" | "low" | "medium" | "high";
}

export interface MinecraftSessionEvent {
  id: string;
  startedAt: number;
  endedAt: number;
  serverLabel: string;
  players: string[];
  summary: string;
}

export const DEFAULT_MINECRAFT_SETTINGS: MinecraftBotSettings = {
  host: "localhost",
  port: 25565,
  username: "",
  auth: "microsoft",
  owner: "",
  version: "",
  reconnect: true,
  autonomy: { mode: "passive", visionEnabled: true },
  soul: { enabled: false, baseUrl: "", apiKey: "", model: "", reasoning: "off" },
  llm: {
    enabled: false,
    baseUrl: "",
    apiKey: "",
    model: "",
    maxSteps: 6,
    reasoning: "auto",
  },
};

export function normalizeMinecraftSettings(value: unknown): MinecraftBotSettings {
  const input = (value && typeof value === "object" ? value : {}) as Partial<MinecraftBotSettings>;
  const soul = (input.soul && typeof input.soul === "object" ? input.soul : {}) as Partial<MinecraftSoulLlmSettings>;
  const llm = (input.llm && typeof input.llm === "object" ? input.llm : {}) as Partial<MinecraftLlmSettings>;
  const autonomy = (input.autonomy && typeof input.autonomy === "object" ? input.autonomy : {}) as Partial<MinecraftAutonomySettings>;
  const port = Number(input.port);
  const maxSteps = Number(llm.maxSteps);
  return {
    host: typeof input.host === "string" && input.host.trim() ? input.host.trim() : "localhost",
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 25565,
    username: typeof input.username === "string" ? input.username.trim() : "",
    auth: input.auth === "offline" ? "offline" : "microsoft",
    owner: typeof input.owner === "string" ? input.owner.trim() : "",
    version: typeof input.version === "string" ? input.version.trim() : "",
    reconnect: input.reconnect !== false,
    autonomy: {
      mode: ["passive", "companion", "survival"].includes(String(autonomy.mode))
        ? autonomy.mode as MinecraftAutonomySettings["mode"] : "passive",
      visionEnabled: autonomy.visionEnabled !== false,
    },
    soul: {
      enabled: soul.enabled === true,
      baseUrl: typeof soul.baseUrl === "string" ? soul.baseUrl.trim() : "",
      apiKey: typeof soul.apiKey === "string" ? soul.apiKey.trim() : "",
      model: typeof soul.model === "string" ? soul.model.trim() : "",
      reasoning: ["off", "low", "medium", "high"].includes(String(soul.reasoning))
        ? soul.reasoning as MinecraftSoulLlmSettings["reasoning"] : "off",
    },
    llm: {
      enabled: llm.enabled === true,
      baseUrl: typeof llm.baseUrl === "string" ? llm.baseUrl.trim() : "",
      apiKey: typeof llm.apiKey === "string" ? llm.apiKey.trim() : "",
      model: typeof llm.model === "string" ? llm.model.trim() : "",
      maxSteps: Number.isInteger(maxSteps) ? Math.max(1, Math.min(maxSteps, 8)) : 6,
      reasoning: ["off", "low", "medium", "high"].includes(String(llm.reasoning))
        ? llm.reasoning as MinecraftLlmSettings["reasoning"] : "auto",
    },
  };
}
