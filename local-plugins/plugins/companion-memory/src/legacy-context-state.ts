import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
export const LEGACY_CONTEXT_KEY = "legacy-context-import";
export function legacyContextState<T>(storage: PluginStorage, key: string): T | undefined {
  const envelope = storage.get<{ version: number; sourceHash: string; states: Record<string, T> }>(LEGACY_CONTEXT_KEY);
  if (envelope !== undefined && (envelope.version !== 1 || !/^[a-f0-9]{64}$/.test(envelope.sourceHash) || !envelope.states || typeof envelope.states !== "object")) throw new Error("旧上下文导入快照损坏");
  return envelope?.states[key];
}
