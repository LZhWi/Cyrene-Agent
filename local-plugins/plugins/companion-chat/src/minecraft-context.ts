interface PersonaInput { persona(): string; tone(): string; worldbook(query: string): string }
export function createMinecraftPersonaReader(input: PersonaInput) {
  return async (method: string, data: unknown, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (method !== "peek-minecraft-persona") throw new Error("不支持的 Minecraft 只读请求");
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Minecraft 上下文请求无效");
    const value = data as Record<string, unknown>;
    if (value.consent !== true || typeof value.query !== "string" || !value.query.trim() || value.query.length > 1e3 || Object.keys(value).some((k) => !["query", "consent"].includes(k))) throw new Error("需要明确的 Minecraft 公开上下文授权");
    const result = {
      version: 1,
      source: "companion-chat",
      exitPersona: input.persona().slice(0, 2e4),
      exitExpressionRules: input.tone().slice(0, 8e3),
      worldbook: input.worldbook(value.query).slice(0, 1e4)
    };
    signal.throwIfAborted();
    return result;
  };
}
