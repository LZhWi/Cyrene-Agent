import { createHash } from "node:crypto";
import type { PluginContext } from "@playa0v0/cyrene-plugin-sdk";
import { createPeer } from "../../shared/protocol";
import { createMinecraftMemoryReader } from "./minecraft-preview";
import { createHostHistorySource } from "./host-history-source";
import type { createMemory } from "./memory";
import type { createVectorIndex } from "./vector-index";
export function registerMinecraftMemoryPeer(ctx: PluginContext, memory: ReturnType<typeof createMemory>, vectors: ReturnType<typeof createVectorIndex>, chatPeer: ReturnType<typeof createPeer>, pending: () => boolean) {
  let sourceEpoch = 0, privateRevision: number | undefined;
  const offHost = ctx.events.on("host:conversation:changed", () => {
    sourceEpoch++;
  });
  const offPrivate = ctx.events.on<{version: number; revision: number}>("plugin:companion-chat:minecraft-sources-changed", (event) => {
    sourceEpoch++;
    privateRevision = event?.version === 1 && Number.isSafeInteger(event.revision) && event.revision >= 0 ? event.revision : void 0;
  });
  const reader = createMinecraftMemoryReader({
    view: memory.view,
    hostSnapshot: createHostHistorySource(ctx.deps.conversations, false).snapshot,
    sourceEpoch: () => sourceEpoch,
    hasPendingInvalidations: pending,
    validPrivateTurns: async (turns, signal) => {
      if (!turns.length) return [];
      const result = await chatPeer.request<{revision: number; validTurnIds: string[]}>("validate-minecraft-sources", {
        consent: true,
        turns: turns.map((t) => ({
          sessionId: t.sessionId,
          turnId: t.id,
          fingerprint: createHash("sha256").update(JSON.stringify([t.user, t.assistant, t.userAt, t.assistantAt])).digest("hex")
        }))
      }, signal, 4e3);
      signal.throwIfAborted();
      if (!result || !Number.isSafeInteger(result.revision) || result.revision < 0 || !Array.isArray(result.validTurnIds) || result.validTurnIds.length > turns.length || result.validTurnIds.some((id) => typeof id !== "string" || !turns.some((t) => t.id === id)) || privateRevision !== void 0 && privateRevision !== result.revision) throw new Error("私人对话来源已变更");
      privateRevision = result.revision;
      return result.validTurnIds;
    },
    rankExisting: async (query, entries, signal) => {
      const service = ctx.deps.memoryRetrieval;
      if (!service) return [];
      const valid = entries.filter((e) => vectors.generatedHash(e.id) === createHash("sha256").update(e.content, "utf8").digest("hex"));
      const byId = new Map(valid.map((e) => [e.id, e.content]));
      const candidates = vectors.records([...byId.keys()]).map((record) => ({ ...record, text: byId.get(record.id)! }));
      if (!candidates.length) return [];
      const result = await service.rank({ query, candidates, topK: 16, mode: "hybrid", rawScore: true, rerank: false, signal });
      signal.throwIfAborted();
      return (result.ranked ? result.ranked.filter((row) => row.score > 0).map((row) => row.id) : result.rankedIds).filter((id) => byId.has(id)).slice(0, 16);
    },
    search: (query, ids, budget) => memory.searchWithBudget(query, [], [], [], ids, budget, false, "automatic-related")
  });
  const peer = createPeer(ctx, "minecraft-body", reader);
  const stop2 = async () => {
    offHost();
    offPrivate();
    await peer.stop();
  };
  ctx.onDispose(stop2);
  return { stop: stop2 };
}
