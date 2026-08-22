// 真实数据只读隔离验证：不调用 manager、不写 memory.json，只对内存副本演算。
// $env:CYRENE_REAL_DMAE_EVAL='1'; npm.cmd test -- --run src/main/memory/dmae-manager.real.sim.test.ts
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import type { L2DmaeState, L2Memory, MemoryStore } from "./memory-types";

const DATA_DIR = process.env.CYRENE_MEMORY_EVAL_DATA_DIR ?? "C:/Users/ASUS/AppData/Roaming/live2d-cyrene";
vi.mock("../runtime/runtime-paths", () => ({ getUserDataDir: () => DATA_DIR }));
vi.mock("./memory-store", () => ({ memoryStore: {} }));
vi.mock("./memory-trace", () => ({ appendMemoryTrace: vi.fn() }));
import { L2_DMAE_PARAMS, selectEntries, simulateTurn } from "./dmae-manager";

const LIVE = process.env.CYRENE_REAL_DMAE_EVAL === "1";

describe.skipIf(!LIVE)("DMAE real-data isolated simulation", () => {
  it("migrates legacy high scores and removes unrelated residents after bounded misses without writing data", () => {
    const memoryPath = path.join(DATA_DIR, "memory.json");
    const before = fs.readFileSync(memoryPath, "utf8");
    const store = JSON.parse(before) as MemoryStore;
    const allL2 = (store.l2 ?? []) as L2Memory[];
    let states = new Map<string, L2DmaeState>(Object.entries(store.l2DmaeStates ?? {}));
    expect(states.size, "真实 DMAE 状态为空，无法验证迁移").toBeGreaterThan(0);

    const knownIds = new Set(allL2.map((item) => item.id));
    states = simulateTurn(states, [], (store.l2DmaeRound ?? 0) + 1, knownIds);
    expect(Math.max(...[...states.values()].map((state) => state.activation)))
      .toBeLessThanOrEqual(L2_DMAE_PARAMS.residencyScoreCap);

    for (let offset = 2; offset <= L2_DMAE_PARAMS.maxResidentSilence + 1; offset += 1) {
      states = simulateTurn(states, [], (store.l2DmaeRound ?? 0) + offset, knownIds);
    }
    const selectedIds = selectEntries([], allL2, states)
      .map((entry) => entry.metadata?.l2Id)
      .filter((id): id is string => typeof id === "string");
    const pinnedIds = new Set(allL2.filter((item) => item.isPinned).map((item) => item.id));
    expect(selectedIds.every((id) => pinnedIds.has(id))).toBe(true);
    expect(fs.readFileSync(memoryPath, "utf8")).toBe(before);
  });
});
