/** 旧运行状态只在内存中映射；调用方确认全部字段有效后，才可决定是否提交到插件私有库。 */
export interface LegacyRuntimePlan {
  lifecycle: { version: 1; revision: 0; recalls: Record<string, { lastHitAt: number; hitCount: number; weight: number }>; lastDecayAt?: number };
  dmae: { version: 1; round: number; states: Record<string, { activation: number; userSilence: number; modelSilence: number; lastInjectedRound: number; round: number }> };
  summary: { lifecycleRecords: number; dmaeStates: number; unmappedL2: number; orphanedDmaeStates: number; valid: boolean };
}

export function createLegacyRuntimePlan(raw: any): LegacyRuntimePlan {
  if (!raw || !Array.isArray(raw.l2)) throw new Error("旧运行状态缺少 L2 数组");
  const recalls: LegacyRuntimePlan["lifecycle"]["recalls"] = Object.create(null);
  const ids = new Set<string>();
  let unmappedL2 = 0;
  for (const item of raw.l2) {
    if (typeof item?.id !== "string" || !item.id || ids.has(item.id)) throw new Error("旧运行状态含无效或重复 L2 ID");
    ids.add(item.id);
    if (!Number.isFinite(item.lastAccessedAt) || item.lastAccessedAt < 0
      || !Number.isSafeInteger(item.accessCount) || item.accessCount < 0
      || !Number.isSafeInteger(item.weight) || item.weight < 0 || item.weight > 100) {
      unmappedL2++;
      continue;
    }
    recalls[item.id] = { lastHitAt: item.lastAccessedAt, hitCount: item.accessCount, weight: item.weight };
  }
  const lastDecayAt = raw.lastDecayAt;
  if (lastDecayAt !== undefined && (!Number.isFinite(lastDecayAt) || lastDecayAt < 0)) throw new Error("旧衰减时间无效");
  const round = raw.l2DmaeRound ?? 0;
  if (!Number.isSafeInteger(round) || round < 0) throw new Error("旧 DMAE 轮次无效");
  const sourceStates = raw.l2DmaeStates ?? {};
  if (!sourceStates || typeof sourceStates !== "object" || Array.isArray(sourceStates) || Object.keys(sourceStates).length > 20_000) throw new Error("旧 DMAE 状态表无效");
  const states: LegacyRuntimePlan["dmae"]["states"] = Object.create(null);
  let orphanedDmaeStates = 0;
  for (const [id, item] of Object.entries(sourceStates) as Array<[string, any]>) {
    if (!ids.has(id)) { orphanedDmaeStates++; continue; }
    if (!item || !Number.isFinite(item.activation) || item.activation < 0 || item.activation > 100
      || !Number.isSafeInteger(item.userSilence) || item.userSilence < 0
      || !Number.isSafeInteger(item.modelSilence) || item.modelSilence < 0
      || !Number.isSafeInteger(item.lastInjectedRound) || item.lastInjectedRound < -1
      || !Number.isSafeInteger(item.round) || item.round < 0 || item.round > round) {
      throw new Error("旧 DMAE 状态字段无效");
    }
    states[id] = { activation: item.activation, userSilence: item.userSilence,
      modelSilence: item.modelSilence, lastInjectedRound: item.lastInjectedRound, round: item.round };
  }
  return {
    lifecycle: { version: 1, revision: 0, recalls, ...(lastDecayAt === undefined ? {} : { lastDecayAt }) },
    dmae: { version: 1, round, states },
    summary: { lifecycleRecords: Object.keys(recalls).length, dmaeStates: Object.keys(states).length,
      unmappedL2, orphanedDmaeStates, valid: unmappedL2 === 0 && orphanedDmaeStates === 0 },
  };
}
