import { expect, it } from "vitest";
import { createLegacyRuntimePlan } from "../plugins/companion-memory/src/legacy-runtime";

const source = () => ({
  l2: [
    { id: "m1", lastAccessedAt: 123, accessCount: 0, weight: 17 },
    { id: "m2", lastAccessedAt: 456, accessCount: 672, weight: 100 },
  ],
  lastDecayAt: 100,
  l2DmaeRound: 505,
  l2DmaeStates: { m1: { activation: 52.8, userSilence: 2, modelSilence: 2, lastInjectedRound: 500, round: 505 } },
});

it("旧生命周期和 DMAE 数值只在内存中逐项保留，零次访问也不改写", () => {
  const raw = source(), original = structuredClone(raw), plan = createLegacyRuntimePlan(raw);
  expect(plan.summary).toEqual({ lifecycleRecords: 2, dmaeStates: 1, unmappedL2: 0, orphanedDmaeStates: 0, valid: true });
  expect(plan.lifecycle.recalls.m1).toEqual({ lastHitAt: 123, hitCount: 0, weight: 17 });
  expect(plan.lifecycle.recalls.m2).toEqual({ lastHitAt: 456, hitCount: 672, weight: 100 });
  expect(plan.dmae.round).toBe(505);
  expect(plan.dmae.states.m1).toEqual(original.l2DmaeStates.m1);
  expect(raw).toEqual(original);
});

it("缺失生命周期字段或孤立 DMAE 只报告缺口，不虚构初值", () => {
  const raw = source() as any;
  delete raw.l2[0].weight;
  raw.l2DmaeStates.orphan = { ...raw.l2DmaeStates.m1 };
  const plan = createLegacyRuntimePlan(raw);
  expect(plan.summary).toEqual({ lifecycleRecords: 1, dmaeStates: 1, unmappedL2: 1, orphanedDmaeStates: 1, valid: false });
  expect(plan.lifecycle.recalls).not.toHaveProperty("m1");
  expect(plan.dmae.states).not.toHaveProperty("orphan");
});

it("DMAE 数值越界时拒绝生成可用计划", () => {
  const raw = source();
  raw.l2DmaeStates.m1.activation = 101;
  expect(() => createLegacyRuntimePlan(raw)).toThrow("旧 DMAE 状态字段无效");
});
