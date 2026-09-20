import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import type { Entry } from "./entries";
import { isRecallable } from "./entries";

const SETTINGS_KEY = "dmae-enabled";
const STATE_KEY = "dmae-state";
export const DMAE_PARAMS = { threshold: 30, cap: 55, activeTopK: 4, maxResidentSilence: 3, maxInject: 10, repeatWindow: 6, repeatRho: 0.5, wakeBonus: 5, decayAlpha: 1, decayBeta: 0.2, epsilon: 1e-6 } as const;
const REWARD = [36, 8, 8, 1] as const;

export interface DmaeActivation { activation: number; userSilence: number; modelSilence: number; lastInjectedRound: number; round: number }
interface DmaeState { version: 1; round: number; states: Record<string, DmaeActivation> }

function validActivation(value: unknown): value is DmaeActivation {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return [item.activation, item.userSilence, item.modelSilence, item.lastInjectedRound, item.round].every(Number.isFinite)
    && (item.activation as number) >= 0 && (item.activation as number) <= 100
    && (item.userSilence as number) >= 0 && (item.modelSilence as number) >= 0;
}
function load(storage: PluginStorage): DmaeState {
  const saved = storage.get<unknown>(STATE_KEY);
  const value = saved === undefined ? (storage.get<any>("memory-state")?.legacyRuntime?.dmae) : saved;
  if (value === undefined) return { version: 1, round: 0, states: {} };
  if (!value || typeof value !== "object") throw new Error("DMAE 状态损坏");
  const state = value as Partial<DmaeState>;
  if (state.version !== 1 || !Number.isSafeInteger(state.round) || state.round! < 0 || !state.states || typeof state.states !== "object" || Array.isArray(state.states) || Object.keys(state.states).length > 20_000 || Object.entries(state.states).some(([id, item]) => !id || !validActivation(item))) throw new Error("DMAE 状态损坏");
  return structuredClone(state as DmaeState);
}

export function simulateDmaeTurn(previous: DmaeState, recalledIds: string[], entries: Entry[]): DmaeState {
  const round = previous.round + 1, known = new Set(entries.map((entry) => entry.id));
  const rank = new Map<string, number>(); recalledIds.forEach((id, index) => { if (known.has(id) && !rank.has(id)) rank.set(id, index); });
  const states: Record<string, DmaeActivation> = {};
  for (const [id, prior] of Object.entries(previous.states)) {
    if (!known.has(id)) continue;
    const hitRank = rank.get(id), hit = hitRank !== undefined;
    let reward = hit ? REWARD[Math.min(hitRank, REWARD.length - 1)] : 0;
    if (hit && prior.lastInjectedRound >= 0 && round - prior.lastInjectedRound < DMAE_PARAMS.repeatWindow) reward *= DMAE_PARAMS.repeatRho;
    const userSilence = hit ? 0 : prior.userSilence + 1, modelSilence = hit ? 0 : prior.modelSilence + 1;
    const decay = DMAE_PARAMS.decayAlpha * userSilence ** 2 + DMAE_PARAMS.decayBeta * modelSilence ** 2;
    let activation = Math.max(0, Math.min(DMAE_PARAMS.cap, prior.activation + reward - decay));
    if (hit && prior.activation < DMAE_PARAMS.threshold) activation = Math.max(activation, DMAE_PARAMS.threshold + DMAE_PARAMS.wakeBonus);
    states[id] = { activation, userSilence, modelSilence, lastInjectedRound: prior.lastInjectedRound, round };
  }
  for (const [id, hitRank] of rank) if (!states[id]) states[id] = { activation: Math.max(DMAE_PARAMS.threshold + DMAE_PARAMS.wakeBonus, REWARD[Math.min(hitRank, REWARD.length - 1)]), userSilence: 0, modelSilence: 0, lastInjectedRound: -1, round };
  return { version: 1, round, states };
}

function select(baseIds: string[], entries: Entry[], state: DmaeState): string[] {
  const now = Date.now(), byId = new Map(entries.map((entry) => [entry.id, entry])), selected: string[] = [], seen = new Set<string>();
  const add = (id: string) => { const entry = byId.get(id); if (!seen.has(id) && entry && isRecallable(entry, now)) { seen.add(id); selected.push(id); } };
  baseIds.forEach(add);
  entries.filter((entry) => entry.pinned).forEach((entry) => add(entry.id));
  Object.entries(state.states).filter(([id, item]) => !seen.has(id) && item.activation >= DMAE_PARAMS.threshold - DMAE_PARAMS.epsilon && item.userSilence <= DMAE_PARAMS.maxResidentSilence)
    .sort((a, b) => b[1].activation - a[1].activation).slice(0, DMAE_PARAMS.activeTopK).forEach(([id]) => add(id));
  return selected.slice(0, DMAE_PARAMS.maxInject);
}

export function createDmae(storage: PluginStorage) {
  let enabled = storage.get<boolean>(SETTINGS_KEY) ?? false;
  if (typeof enabled !== "boolean") throw new Error("DMAE 设置损坏");
  let state = load(storage);
  const describe = () => ({ enabled, round: state.round, tracked: Object.keys(state.states).length, active: Object.values(state.states).filter((item) => item.activation >= DMAE_PARAMS.threshold - DMAE_PARAMS.epsilon && item.userSilence <= DMAE_PARAMS.maxResidentSilence).length });
  return {
    view: describe,
    reload() { state = load(storage); return describe(); },
    set(value: unknown) { if (typeof value !== "boolean") throw new Error("DMAE 设置无效"); storage.set(SETTINGS_KEY, value); enabled = value; return describe(); },
    apply(baseIds: string[], entries: Entry[]) {
      if (!enabled) return baseIds;
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      const recalled = baseIds.filter((id) => !byId.get(id)?.pinned);
      const next = simulateDmaeTurn(state, recalled, entries), selected = select(baseIds, entries, next);
      for (const id of selected) if (next.states[id]) next.states[id].lastInjectedRound = next.round;
      storage.set(STATE_KEY, next); state = next;
      return selected;
    },
    /** 检索预算确定最终注入条目后才提交，预算外候选不获得奖励或 lastInjectedRound。 */
    commit(includedIds: string[], entries: Entry[]) {
      if (!enabled) return;
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      const recalled = includedIds.filter((id) => byId.has(id) && !byId.get(id)?.pinned);
      const next = simulateDmaeTurn(state, recalled, entries);
      for (const id of includedIds) if (next.states[id]) next.states[id].lastInjectedRound = next.round;
      storage.set(STATE_KEY, next); state = next;
    },
    preview(baseIds: string[], entries: Entry[]) {
      if (!enabled) return { selectedIds: baseIds, round: state.round, tracked: Object.keys(state.states).length };
      const next = simulateDmaeTurn(state, baseIds.filter((id) => !entries.find((entry) => entry.id === id)?.pinned), entries);
      return { selectedIds: select(baseIds, entries, next), round: next.round, tracked: Object.keys(next.states).length };
    },
  };
}
