import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import type { LifeShareSource } from "./life-sharing";
import { sceneCooldownMs, type ProactiveCandidate } from "./proactive-planner";

export const PROACTIVE_DELIVERY_INTENT_KEY = "isolated-proactive-delivery-intent";
export interface ProactiveDeliveryIntent {
  version: 1;
  runId: string;
  generationEpoch: number;
  preparedAt: number;
  text: string;
  candidate: ProactiveCandidate | null;
  lifeShare?: LifeShareSource;
  ignoredMessageIds?: string[];
}
export interface ProactiveDeliverySource {
  runId: string;
  pluginId: string;
  conversationId: string;
  messageId: string;
  assistantEntryId: string;
  status: "delivered";
  deliveredAt: number;
}
export type ProactiveDeliveryLifecycle =
  | { runId: string; state: "delivered"; source: ProactiveDeliverySource; delivery: { conversationId: string; messageId: string; at: string; deliveredText: string } }
  | { runId: string; state: "invalidated" | "abandoned"; proofId: string }
  | { runId: string; state: "inflight" | "unknown" };
interface DurableStorage extends PluginStorage {
  isolationAggregate?: boolean;
  isolationTransaction?: { run<T>(fn: () => T, guard?: unknown): T };
  isolationSources?: {
    beginProactiveRun(runId: string): Promise<void>;
    readProactiveLifecycle(runId: string): Promise<ProactiveDeliveryLifecycle>;
    sealProactiveRun(runId: string): Promise<ProactiveDeliveryLifecycle>;
  };
}

export function createDurableProactiveDelivery(storage: PluginStorage) {
  const isolated = storage as DurableStorage;
  if (!isolated.isolationAggregate && !isolated.isolationTransaction) return undefined;
  const transaction = isolated.isolationTransaction;
  const sources = isolated.isolationSources;
  if (!transaction || !sources?.beginProactiveRun || !sources.readProactiveLifecycle || !sources.sealProactiveRun) {
    throw new Error("PROACTIVE_DELIVERY_RECOVERY_CAPABILITY_MISSING");
  }
  function read(): ProactiveDeliveryIntent | null {
    const value = storage.get<ProactiveDeliveryIntent | null>(PROACTIVE_DELIVERY_INTENT_KEY);
    if (value == null) return null;
    if (value.version !== 1 || typeof value.runId !== "string" || !value.runId
      || !Number.isSafeInteger(value.generationEpoch) || value.generationEpoch < 0
      || !Number.isFinite(value.preparedAt) || value.preparedAt < 0
      || typeof value.text !== "string" || !value.text.trim() || value.text.length > 500
      || (value.candidate !== null && (!value.candidate || !Number.isFinite(value.candidate.score)
        || !Number.isFinite(sceneCooldownMs(value.candidate.scene))))
      || (value.lifeShare !== undefined && (!value.lifeShare || typeof value.lifeShare.eventId !== "string"
        || !value.lifeShare.eventId || !Number.isSafeInteger(value.lifeShare.eventRevision)
        || typeof value.lifeShare.text !== "string" || !Number.isFinite(value.lifeShare.startAt)
        || !Number.isFinite(value.lifeShare.endAt) || !Number.isFinite(value.lifeShare.expiresAt)))
      || (value.ignoredMessageIds !== undefined && (!Array.isArray(value.ignoredMessageIds)
        || value.ignoredMessageIds.some((id) => typeof id !== "string" || !id)))) {
      throw new Error("PROACTIVE_DELIVERY_INTENT_INVALID");
    }
    return structuredClone(value);
  }
  return {
    read,
    begin: (runId: string) => sources.beginProactiveRun(runId),
    status: (runId: string) => sources.readProactiveLifecycle(runId),
    seal: (runId: string) => sources.sealProactiveRun(runId),
    prepare(intent: ProactiveDeliveryIntent, reserve: () => boolean) {
      return transaction.run(() => {
        if (read()) throw new Error("PROACTIVE_DELIVERY_ALREADY_PENDING");
        if (!reserve()) return false;
        storage.set(PROACTIVE_DELIVERY_INTENT_KEY, intent);
        return true;
      }, { proactiveSourceAbsent: intent.runId });
    },
    finish(intent: ProactiveDeliveryIntent, lifecycle: ProactiveDeliveryLifecycle, apply: () => void) {
      if (lifecycle.runId !== intent.runId || !["delivered", "abandoned", "invalidated"].includes(lifecycle.state)) {
        throw new Error("PROACTIVE_DELIVERY_NOT_TERMINAL");
      }
      transaction.run(() => {
        if (JSON.stringify(read()) !== JSON.stringify(intent)) throw new Error("PROACTIVE_DELIVERY_INTENT_CHANGED");
        apply();
        storage.set(PROACTIVE_DELIVERY_INTENT_KEY, null);
      }, lifecycle.state === "delivered" ? { proactiveSource: lifecycle.source } : { proactiveTerminal: lifecycle });
    },
    rememberIgnore(messageId: string) {
      if (typeof messageId !== "string" || !messageId.trim()) return false;
      const intent = read();
      if (!intent) return false;
      if (!intent.ignoredMessageIds?.includes(messageId)) {
        transaction.run(() => storage.set(PROACTIVE_DELIVERY_INTENT_KEY, {
          ...intent, ignoredMessageIds: [...(intent.ignoredMessageIds ?? []), messageId],
        }));
      }
      return true;
    },
  };
}
