import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { describe, expect, it, vi } from "vitest";
import { MemoryScheduler, type MemorySchedulerDeps } from "./memory-scheduler";
import type { L1Profile, L2Memory, MemoryCandidate, MemoryJudgeTurn } from "./memory-types";
import type { MemoryEntry } from "../rag/vectorstore";
import { selectImmediateDuplicateL2 } from "./memory-manager";
import { resolveRetrievalPlan } from "./memory-facets";

const enabled = process.env.CYRENE_REAL_MEMORY_PIPELINE_EVAL === "1";
const userDataDir = process.env.CYRENE_REAL_USER_DATA_DIR ?? "";

function loadRecentRealTurns(limit: number): MemoryJudgeTurn[] {
  const indexPath = path.join(userDataDir, "cyrene-chats", "index.json");
  const sessions = JSON.parse(fs.readFileSync(indexPath, "utf8")) as Array<{ id?: string }>;
  const turns: Array<MemoryJudgeTurn & { at: number }> = [];
  for (const session of sessions) {
    if (!session.id) continue;
    const sessionPath = path.join(userDataDir, "cyrene-chats", "sessions", `${session.id}.json`);
    if (!fs.existsSync(sessionPath)) continue;
    const data = JSON.parse(fs.readFileSync(sessionPath, "utf8")) as {
      messages?: Array<{ role?: string; content?: unknown; at?: unknown }>;
    };
    let pending: { text: string; at: number } | null = null;
    for (const message of data.messages ?? []) {
      if (typeof message.content !== "string" || !message.content.trim()) continue;
      const at = typeof message.at === "number" ? message.at : 0;
      if (message.role === "user") {
        pending = { text: message.content, at };
      } else if ((message.role === "model" || message.role === "assistant") && pending) {
        turns.push({ userInput: pending.text, assistantReply: message.content, at: pending.at });
        pending = null;
      }
    }
  }
  return turns.sort((a, b) => a.at - b.at).slice(-limit).map(({ userInput, assistantReply }, index) => ({
    userInput,
    assistantReply,
    conversationId: "default",
    userMessageId: `real-user-${index}`,
    assistantMessageId: `real-assistant-${index}`,
    userAt: index * 1000,
    assistantAt: index * 1000 + 500,
    validateAgainstConversation: false,
  }));
}

function digestTurns(turns: MemoryJudgeTurn[]): string {
  return createHash("sha256").update(JSON.stringify(turns)).digest("hex");
}

function loadRealL2Snapshot(): { memories: L2Memory[]; entries: MemoryEntry[] } {
  const memory = JSON.parse(fs.readFileSync(path.join(userDataDir, "memory.json"), "utf8")) as { l2?: L2Memory[] };
  const entries = JSON.parse(fs.readFileSync(path.join(userDataDir, "rag-data", "memory-store.json"), "utf8")) as MemoryEntry[];
  return {
    memories: memory.l2 ?? [],
    entries: entries.filter((entry) => entry.source === "user_memory"),
  };
}

async function simulateRetryableFailure(realTurns: MemoryJudgeTurn[], failure: Error): Promise<{
  saved: MemoryJudgeTurn[];
  writeMemory: MemorySchedulerDeps["writeMemory"];
}> {
  let roundCount = 5;
  let lastSaved: MemoryJudgeTurn[] = [];
  const l1 = (): L1Profile => ({
    recentGoals: "",
    recentPreferences: "",
    currentProject: "",
    generatedAt: 0,
    roundCount,
  });
  const deps: MemorySchedulerDeps = {
    ingestEntity: vi.fn(),
    enqueueTask: async (_label, task) => task(),
    judgeMemory: vi.fn(async () => { throw failure; }),
    writeMemory: vi.fn(async () => undefined),
    getL1: vi.fn(async () => l1()),
    replaceL1Field: vi.fn(async (_field, value) => { roundCount = value; }),
    runReflectionAndCompression: vi.fn(async () => undefined),
    runResolverQueueOnce: vi.fn(async () => undefined),
    getLastDecayAt: vi.fn(async () => Date.now()),
    runDecay: vi.fn(async () => undefined),
    loadPendingTurns: vi.fn(async () => realTurns.slice(0, 5)),
    savePendingTurns: vi.fn(async (turns: MemoryJudgeTurn[]) => { lastSaved = turns.map((turn) => ({ ...turn })); }),
    loadConversationMessages: vi.fn(async () => null),
  };
  const scheduler = new MemoryScheduler(deps);
  scheduler.scheduleMemoryWrite(realTurns[5].userInput, realTurns[5].assistantReply, {
    conversationId: realTurns[5].conversationId,
    userMessageId: realTurns[5].userMessageId,
    assistantMessageId: realTurns[5].assistantMessageId,
    userAt: realTurns[5].userAt,
    assistantAt: realTurns[5].assistantAt,
    validateAgainstConversation: false,
  });
  await vi.waitFor(() => expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 6));
  return { saved: lastSaved, writeMemory: deps.writeMemory };
}

describe.skipIf(!enabled)("real-data isolated memory pipeline regressions", () => {
  it("keeps real pending turns byte-for-byte when MemoryJudge configuration is unavailable", async () => {
    const realTurns = loadRecentRealTurns(6);
    expect(realTurns).toHaveLength(6);
    const expectedDigest = digestTurns(realTurns);
    const result = await simulateRetryableFailure(realTurns, new Error("MemoryJudge missing api key"));

    expect(result.saved).toHaveLength(6);
    expect(digestTurns(result.saved)).toBe(expectedDigest);
    expect(result.writeMemory).not.toHaveBeenCalled();
  });

  it("keeps real pending turns byte-for-byte when MemoryJudge returns malformed JSON", async () => {
    const realTurns = loadRecentRealTurns(6);
    expect(realTurns).toHaveLength(6);
    const expectedDigest = digestTurns(realTurns);
    const result = await simulateRetryableFailure(realTurns, new Error("MemoryJudge JSON 解析失败"));

    expect(result.saved).toHaveLength(6);
    expect(digestTurns(result.saved)).toBe(expectedDigest);
    expect(result.writeMemory).not.toHaveBeenCalled();
  });

  it("deduplicates an exact replay without merging any distinct real L2 memories", () => {
    const snapshot = loadRealL2Snapshot();
    const entriesByL2Id = new Map(snapshot.entries.flatMap((entry) => {
      const l2Id = entry.metadata?.l2Id;
      return typeof l2Id === "string" ? [[l2Id, entry] as const] : [];
    }));
    const recallable = snapshot.memories.filter((memory) => (
      (memory.status === "active" || memory.status === "aging")
      && memory.syncStatus === "synced"
      && entriesByL2Id.get(memory.id)?.id === memory.ragId
    ));
    expect(recallable.length).toBeGreaterThan(10);

    for (const memory of recallable) {
      const ownEntry = entriesByL2Id.get(memory.id)!;
      const candidate: MemoryCandidate = {
        layer: "L2",
        content: memory.content,
        triggerText: memory.triggerText,
        confidence: 1,
        facets: memory.facets,
      };
      const otherMemories = recallable.filter((item) => item.id !== memory.id);
      const otherEntries = snapshot.entries.filter((entry) => entry.id !== ownEntry.id);
      expect(selectImmediateDuplicateL2(candidate, ownEntry.embedding, otherMemories, otherEntries)).toBeNull();
    }

    const exemplar = recallable[0];
    const exemplarEntry = entriesByL2Id.get(exemplar.id)!;
    const replay: MemoryCandidate = {
      layer: "L2",
      content: exemplar.content,
      triggerText: exemplar.triggerText,
      confidence: 1,
      facets: exemplar.facets,
    };
    expect(selectImmediateDuplicateL2(replay, exemplarEntry.embedding, recallable, snapshot.entries)?.id).toBe(exemplar.id);
  });

  it("bounds low-confidence expansion plans for real recent user messages", () => {
    const realTurns = loadRecentRealTurns(6);
    expect(realTurns).toHaveLength(6);
    for (const turn of realTurns) {
      expect(resolveRetrievalPlan(turn.userInput, {
        needsExpansion: true,
        retrievalKinds: ["experience"],
        scope: "exhaustive_list",
        confidence: 0.49,
      })).toMatchObject({ maxResults: 5, queryKinds: [] });
      expect(resolveRetrievalPlan(turn.userInput, {
        needsExpansion: true,
        retrievalKinds: ["experience"],
        scope: "exhaustive_list",
        confidence: 0.6,
      })).toMatchObject({ scope: "normal", maxResults: 10 });
    }
  });
});
