import { describe, expect, it, vi } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createLifeContext } from "../plugins/companion-chat/src/life-context";
import { LIFE_REST_ACTIVITY, LIFE_STEP_MS, type LifeDynamics } from "../plugins/companion-chat/src/life-dynamics";

const at = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();

function fixture(initial?: unknown) {
  let value = structuredClone(initial), fail = false;
  const set = vi.fn((key: string, next: unknown) => {
    expect(key).toBe("life-state");
    if (fail) { fail = false; throw new Error("模拟提交失败"); }
    value = structuredClone(next);
  });
  const storage: PluginStorage = { get: <T>(key: string) => (key === "life-state" ? structuredClone(value) : undefined) as T | undefined,
    set, rootDir: () => "unused-memory-only" };
  return { storage, set, disk: () => structuredClone(value) as any, failNext: () => { fail = true; } };
}

function lowEnergyFixture() {
  const seed = fixture();
  createLifeContext(seed.storage, () => at(1, 11, 45)).build();
  const state = seed.disk();
  state.cursorAt = state.recordAfterAt = at(1, 11, 45);
  state.pendingSegments = [];
  state.self = { ...state.self, updatedAt: state.cursorAt, activitySince: state.cursorAt,
    energy: 0, focus: 0, restNeed: 100, activity: null, resting: true, recovering: true, habits: {} };
  return fixture(state);
}

function resources(self: LifeDynamics) {
  const { energy, focus, restNeed, habits } = self;
  return { energy, focus, restNeed, habits };
}

describe("连续状态与生活账本接线", () => {
  it("两天一次推进与频繁读取及重启的状态、实际活动记录一致", () => {
    const whole = fixture(), pieces = fixture();
    let clock = at(1, 6);
    const one = createLifeContext(whole.storage, () => clock);
    let many = createLifeContext(pieces.storage, () => clock);
    one.build(); many.build();
    const end = at(3, 6);
    for (clock += 5 * 60_000; clock <= end; clock += 5 * 60_000) {
      many.build(); many.status();
      if (clock % (3 * 60 * 60_000) === 0) {
        many.stop();
        many = createLifeContext(pieces.storage, () => clock);
        many.build();
      }
    }
    clock = end;
    one.build();
    expect(many.view().self).toEqual(one.view().self);
    const facts = (life: ReturnType<typeof createLifeContext>) => life.view().continuity.events
      .map(({ id, text, startAt, endAt }) => ({ id, text, startAt, endAt }));
    expect(facts(many)).toEqual(facts(one));
  });

  it("疲劳改为休息后，状态、Prompt、账本均使用实际活动", () => {
    const f = lowEnergyFixture();
    let clock = at(1, 11, 45);
    const life = createLifeContext(f.storage, () => clock);
    const prompt = life.build();
    expect(life.status()).toEqual({ text: `正在${LIFE_REST_ACTIVITY}`, resting: true });
    expect(prompt).toContain(`你现在正在做：${LIFE_REST_ACTIVITY}`);
    expect(prompt).toContain("都不影响及时回应用户");
    clock = at(1, 12);
    life.build();
    expect(life.view().continuity.events).toEqual([expect.objectContaining({
      text: `上午（部分时段）：${LIFE_REST_ACTIVITY}`, startAt: at(1, 11, 45), endAt: at(1, 12), status: "materialized",
    })]);
    expect(life.view().self.habits).toEqual({ [LIFE_REST_ACTIVITY]: 15 });
  });

  it("状态和事件的原子提交失败后重试不重复计算消耗或习惯", () => {
    const f = lowEnergyFixture();
    let clock = at(1, 11, 45);
    const life = createLifeContext(f.storage, () => clock);
    life.build();
    const before = life.view(), diskBefore = f.disk();
    clock = at(1, 12);
    f.failNext();
    expect(() => life.build()).toThrow("模拟提交失败");
    expect(life.view()).toEqual(before);
    expect(f.disk()).toEqual(diskBefore);
    life.build();
    expect(life.view().continuity.events).toHaveLength(1);
    expect(life.view().self.habits).toEqual({ [LIFE_REST_ACTIVITY]: 15 });
  });

  it("停用多天不恢复或消耗数值，也不增加习惯", () => {
    const f = fixture();
    let clock = at(1, 7);
    const life = createLifeContext(f.storage, () => clock);
    life.build();
    clock = at(1, 11);
    life.configure(false, "");
    const before = resources(life.view().self);
    clock = at(8, 11);
    expect(life.status()).toBeNull();
    life.configure(true, "");
    expect(resources(life.view().self)).toEqual(before);
    expect(life.view().self.updatedAt).toBe(clock);
    expect(life.view().continuity.events).toHaveLength(0);
  });

  it("非分钟边界开启跳过不足一分钟的残段，结果不随读取频率变化", () => {
    const run = (frequent: boolean) => {
      const f = fixture();
      let clock = at(1, 7);
      const life = createLifeContext(f.storage, () => clock);
      life.build();
      clock = at(1, 10, 3); life.configure(false, "");
      clock = at(1, 11, 10) + 30_000; life.configure(true, "");
      const frozen = resources(life.view().self);
      if (frequent) {
        clock = at(1, 11, 11); life.build();
        expect(resources(life.view().self)).toEqual(frozen);
        for (const minute of [12, 14, 15, 19]) { clock = at(1, 11, minute); life.build(); }
      }
      clock = at(1, 11, 30); life.build();
      const minutes = Object.values(life.view().self.habits).reduce((sum, value) => sum + value, 0);
      const beforeMinutes = Object.values(frozen.habits).reduce((sum, value) => sum + value, 0);
      expect(minutes - beforeMinutes).toBe(19);
      expect(f.disk().pendingSegments[0].startAt).toBe(at(1, 11, 11));
      return life.view().self;
    };
    expect(run(true)).toEqual(run(false));
  });

  it("超过72小时即使量子时钟恰好72小时也只概括并重置，不补习惯", () => {
    const f = fixture();
    let clock = at(1, 7, 8);
    const first = createLifeContext(f.storage, () => clock);
    first.build(); first.stop();
    const habits = first.view().self.habits;
    clock += 72 * 60 * 60_000 + 60_000;
    const resumed = createLifeContext(f.storage, () => clock);
    resumed.build();
    expect(resumed.view().self).toMatchObject({ energy: 60, focus: 60, restNeed: 30, habits });
    expect(resumed.view().continuity.events).toEqual([expect.objectContaining({ source: "offline_inference", status: "inferred" })]);
    expect(f.disk().pendingSegments).toEqual([]);
  });

  it("旧阶段1快照从已处理游标建立连续状态，不改写旧事件", () => {
    const event = { id: "2026-09-01:上午", date: "2026-09-01", text: "旧版上午记录",
      startAt: at(1, 7), endAt: at(1, 12), source: "runtime_schedule", worldLayer: "simulated_world", status: "materialized", revision: 2 };
    const f = fixture({ version: 2, revision: 3, settings: { version: 1, enabled: true, importantDates: [] },
      cursorAt: at(1, 13), recordAfterAt: 0, events: [event] });
    let clock = at(1, 13);
    const life = createLifeContext(f.storage, () => clock);
    expect(f.set).not.toHaveBeenCalled();
    expect(life.view().self).toMatchObject({ updatedAt: clock, energy: 75, focus: 70, restNeed: 20, habits: {} });
    clock += LIFE_STEP_MS; life.build();
    expect(life.view().continuity.events).toEqual([event]);
    expect(f.disk().pendingSegments[0].startAt).toBe(at(1, 13));
  });

  it.each([
    ["连续状态缺失", (state: any) => { delete state.self; }],
    ["超出范围的精力", (state: any) => { state.self.energy = 101; }],
    ["活动片段晚于状态", (state: any) => { state.pendingSegments[0].endAt = state.self.updatedAt + LIFE_STEP_MS; }],
    ["活动片段重叠", (state: any) => { state.pendingSegments.push(structuredClone(state.pendingSegments[0])); }],
  ])("%s 拒写且不降级为空状态", (_label, mutate) => {
    const seed = fixture();
    createLifeContext(seed.storage, () => at(1, 8)).build();
    const state = seed.disk();
    mutate(state);
    const f = fixture(state);
    expect(() => createLifeContext(f.storage, () => at(1, 9))).toThrow("损坏");
    expect(f.set).not.toHaveBeenCalled();
  });
});
