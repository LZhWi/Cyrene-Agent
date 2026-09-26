import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginLlmMessage, PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createLifeContext } from "../plugins/companion-chat/src/life-context";
import type { LifePlanningInput } from "../plugins/companion-chat/src/life-planning";

const time = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
const inputOf = (messages: PluginLlmMessage[]) => JSON.parse(messages.at(-1)!.content) as LifePlanningInput;
const reply = (input: LifePlanningInput, activity = "读书") => JSON.stringify({ kind: input.kind, date: input.date,
  revision: input.revision, windows: input.windows.map((window) => ({ id: window.id, activities: [activity] })) });

function store(initial?: unknown) {
  let state: any = structuredClone(initial), fail = false;
  const set = vi.fn((key: string, value: unknown) => {
    expect(key).toBe("life-state");
    if (fail) { fail = false; throw new Error("模拟原子提交失败"); }
    state = structuredClone(value);
  });
  const storage: PluginStorage = { get: <T>(key: string) => (key === "life-state" ? structuredClone(state) : undefined) as T | undefined,
    set, rootDir: () => "unused-memory-only" };
  return { storage, set, state: () => structuredClone(state), failNext: () => { fail = true; } };
}

function deferred() {
  let resolve!: (text: string) => void;
  const promise = new Promise<string>((done) => { resolve = done; });
  const generate = vi.fn((_messages: PluginLlmMessage[], _signal: AbortSignal) => promise);
  return { resolve, generate };
}

afterEach(() => { vi.useRealTimers(); });

describe("生活规划调用与预算", () => {
  it("默认关闭自动规划，普通读取和启动不调用模型，手动可调用", async () => {
    vi.useFakeTimers(); vi.setSystemTime(time(1, 9));
    const f = store(), generate = vi.fn(async (messages: PluginLlmMessage[]) => reply(inputOf(messages)));
    const life = createLifeContext(f.storage, Date.now, { generate });
    life.start(); life.build(); life.status();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(generate).not.toHaveBeenCalled();
    expect(life.view().planning.enabled).toBe(false);
    expect((await life.plan("daily")).status).toBe("applied");
    expect(generate).toHaveBeenCalledOnce();
    life.stop();
  });

  it("请求之前持久占额，失败也耗额度且重启不重新调用", async () => {
    const f = store();
    const generate = vi.fn(async (messages: PluginLlmMessage[]) => {
      const input = inputOf(messages), saved = f.state();
      expect(saved.planning.attempts).toHaveLength(1);
      expect(saved.planning.attempts[0]).toMatchObject({ status: "reserved", sourceRevision: input.revision });
      expect(saved.revision).toBe(input.revision);
      throw new Error("模拟模型失败");
    });
    const life = createLifeContext(f.storage, () => time(1, 9), { generate });
    expect((await life.plan("daily")).status).toBe("failed");
    life.stop();
    const restored = createLifeContext(f.storage, () => time(1, 9), { generate });
    expect((await restored.plan("daily")).status).toBe("skipped");
    expect(generate).toHaveBeenCalledOnce();
    expect(restored.view().planning.attempts[0].status).toBe("failed");
  });

  it("预占原子写失败不调用模型，成功后每日一次、细化两次封顶", async () => {
    const f = store(), generate = vi.fn(async (messages: PluginLlmMessage[]) => reply(inputOf(messages)));
    const life = createLifeContext(f.storage, () => time(1, 9), { generate });
    life.build(); f.failNext();
    await expect(life.plan("daily")).rejects.toThrow("模拟原子提交失败");
    expect(generate).not.toHaveBeenCalled();
    expect((await life.plan("daily")).status).toBe("applied");
    expect((await life.plan("daily")).status).toBe("skipped");
    expect((await life.plan("refine")).status).toBe("applied");
    expect((await life.plan("refine")).status).toBe("applied");
    expect((await life.plan("refine")).status).toBe("skipped");
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it("并发请求只占一个额度，取消后迟到结果不覆盖旧计划", async () => {
    const f = store(), d = deferred();
    const life = createLifeContext(f.storage, () => time(1, 9), { generate: d.generate });
    const pending = life.plan("daily");
    expect(life.view().planning.busy).toBe(true);
    expect((await life.plan("refine")).status).toBe("skipped");
    life.cancelPlanning();
    expect(d.generate.mock.calls[0][1].aborted).toBe(true);
    d.resolve(reply(inputOf(d.generate.mock.calls[0][0])));
    expect((await pending).status).toBe("cancelled");
    expect(life.view().planning.attempts).toHaveLength(1);
    expect(life.view().planning.attempts[0].status).toBe("cancelled");
    expect(life.view().planning.plans).toEqual([]);
    expect(life.view().planning.busy).toBe(false);
  });

  it("非法输出消耗尝试额度且保留已接受的未来计划", async () => {
    const f = store();
    const generate = vi.fn(async (messages: PluginLlmMessage[]) => reply(inputOf(messages)));
    const life = createLifeContext(f.storage, () => time(1, 9), { generate });
    await life.plan("daily");
    const plans = life.view().planning.plans;
    generate.mockResolvedValueOnce('{"story":"我已经读取了用户文件"}');
    expect((await life.plan("refine")).status).toBe("invalid");
    expect(life.view().planning.plans).toEqual(plans);
    expect(life.view().planning.attempts).toHaveLength(2);
  });

  it("仅保留14天记录并保留预算日期高水位，回拨不恢复额度", async () => {
    const f = store(), generate = vi.fn(async (messages: PluginLlmMessage[]) => reply(inputOf(messages)));
    let clock = time(1, 9);
    const life = createLifeContext(f.storage, () => clock, { generate });
    for (let day = 1; day <= 16; day++) {
      clock = time(day, 9);
      expect((await life.plan("daily")).status).toBe("applied");
    }
    expect(life.view().planning.attempts).toHaveLength(14);
    expect(life.view().planning.plans).toHaveLength(14);
    expect(life.view().planning.budgetDate).toBe("2026-09-16");
    clock = time(1, 9);
    expect((await life.plan("daily")).status).toBe("skipped");
    expect(generate).toHaveBeenCalledTimes(16);
  });
});

describe("生活规划未来生效与生命周期", () => {
  it("未来窗口带两分钟缓冲，计划应用不改已有事件或当前活动", async () => {
    const f = store(), generate = vi.fn(async (messages: PluginLlmMessage[]) => reply(inputOf(messages)));
    let clock = time(1, 13, 14);
    const life = createLifeContext(f.storage, () => clock, { generate });
    life.build();
    const before = life.view();
    expect((await life.plan("daily")).status).toBe("applied");
    const input = inputOf(generate.mock.calls[0][0]);
    expect(input.windows[0].startAt).toBe(time(1, 13, 30));
    expect(input.windows.every((window) => window.endAt - window.startAt >= 60 * 60_000)).toBe(true);
    expect(life.view().self).toEqual(before.self);
    expect(life.view().continuity.events).toEqual(before.continuity.events);
    expect(life.build()).toContain("后续计划调整");
    clock = time(1, 14);
    life.build();
    expect(life.status()?.text).toBe("正在读书");
    clock = time(1, 18);
    life.build();
    expect(life.view().continuity.events.find((event) => event.id === "2026-09-01:下午")?.text).toContain("读书");
  });

  it.each(["passed", "rollback", "revision", "date"] as const)("生成中%s变化使结果过期", async (change) => {
    const f = store(), d = deferred();
    let clock = time(1, 9);
    const life = createLifeContext(f.storage, () => clock, { generate: d.generate });
    const pending = life.plan("daily");
    const input = inputOf(d.generate.mock.calls[0][0]);
    if (change === "passed") clock = input.windows[0].startAt;
    if (change === "rollback") clock = time(1, 8, 59);
    if (change === "revision") life.configure(true, "09-01 更新纪念日");
    if (change === "date") clock = time(2, 9);
    d.resolve(reply(input));
    expect((await pending).status).toBe("stale");
    expect(life.view().planning.plans).toEqual([]);
    expect(life.view().planning.attempts[0].status).toBe("stale");
  });

  it.each(["stop", "host-abort", "disable", "planning-toggle"] as const)("%s取消请求并拒绝迟到计划", async (action) => {
    const f = store(), d = deferred(), host = new AbortController();
    const life = createLifeContext(f.storage, () => time(1, 9), { generate: d.generate, stopSignal: host.signal });
    const pending = life.plan("daily"), input = inputOf(d.generate.mock.calls[0][0]);
    if (action === "stop") life.stop();
    if (action === "host-abort") host.abort();
    if (action === "disable") life.configure(false, "");
    if (action === "planning-toggle") life.configurePlanning(true);
    const writes = f.set.mock.calls.length;
    d.resolve(reply(input));
    expect((await pending).status).toBe("cancelled");
    expect(d.generate.mock.calls[0][1].aborted).toBe(true);
    expect(life.view().planning.plans).toEqual([]);
    if (action === "stop" || action === "host-abort") expect(f.set).toHaveBeenCalledTimes(writes);
  });

  it("细化至少留足30分钟，临近末尾没有窗口时不调用模型", async () => {
    const f = store(), generate = vi.fn(async (messages: PluginLlmMessage[]) => reply(inputOf(messages)));
    let clock = time(1, 11, 40);
    const life = createLifeContext(f.storage, () => clock, { generate });
    await life.plan("refine");
    let input = inputOf(generate.mock.calls[0][0]);
    expect(input.windows[0]).toMatchObject({ startAt: time(1, 12), endAt: time(1, 12, 30) });
    clock = time(1, 17, 40);
    await life.plan("refine");
    input = inputOf(generate.mock.calls[1][0]);
    expect(input.windows[0]).toMatchObject({ startAt: time(1, 18), endAt: time(1, 18, 30) });
    clock = time(2, 22, 40);
    expect((await life.plan("refine")).status).toBe("skipped");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(life.view().planning.attempts).toHaveLength(2);
  });

  it("周期提交失败会中止正在生成的规划，迟到结果零写入", async () => {
    vi.useFakeTimers(); vi.setSystemTime(time(1, 9));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const f = store(), d = deferred();
      const life = createLifeContext(f.storage, Date.now, { generate: d.generate });
      life.start();
      const pending = life.plan("daily"), input = inputOf(d.generate.mock.calls[0][0]);
      f.failNext();
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(d.generate.mock.calls[0][1].aborted).toBe(true);
      const writes = f.set.mock.calls.length;
      d.resolve(reply(input));
      expect((await pending).status).toBe("cancelled");
      expect(f.set).toHaveBeenCalledTimes(writes);
      expect(life.view().planning.plans).toEqual([]);
    } finally { warning.mockRestore(); }
  });
});

describe("生活规划自动触发", () => {
  it("下午才建每日计划时不立即细化同一下午，晚上只调用一次", async () => {
    vi.useFakeTimers(); vi.setSystemTime(time(1, 14));
    const f = store(), generate = vi.fn(async (messages: PluginLlmMessage[]) => reply(inputOf(messages)));
    const life = createLifeContext(f.storage, Date.now, { generate });
    life.configurePlanning(true);
    expect(generate).not.toHaveBeenCalled();
    life.start();
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(generate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5 * 60 * 60_000);
    expect(generate.mock.calls.map(([messages]) => inputOf(messages).kind)).toEqual(["daily", "refine"]);
    life.stop();
  });

  it("早间每日失败也不重试，下午和晚上分别最多细化一次", async () => {
    vi.useFakeTimers(); vi.setSystemTime(time(1, 8));
    const f = store(), generate = vi.fn(async (_messages: PluginLlmMessage[]) => { throw new Error("模拟服务不可用"); });
    const life = createLifeContext(f.storage, Date.now, { generate });
    life.configurePlanning(true); life.start();
    await vi.advanceTimersByTimeAsync(14 * 60 * 60_000);
    expect(generate.mock.calls.map(([messages]) => inputOf(messages).kind)).toEqual(["daily", "refine", "refine"]);
    expect(life.view().planning.attempts.every((attempt) => attempt.status === "failed")).toBe(true);
    life.stop();
  });
});

describe("持久化规划损坏拒写", () => {
  it("更换系统时区后仍按生成时的偏移解释既有计划", async () => {
    const originalTimezone = process.env.TZ;
    try {
      process.env.TZ = "Asia/Shanghai";
      let clock = time(1, 9);
      const f = store();
      const generate = vi.fn(async (messages: PluginLlmMessage[]) => reply(inputOf(messages)));
      const life = createLifeContext(f.storage, () => clock, { generate });
      expect((await life.plan("daily")).status).toBe("applied");
      const savedPlans = life.view().planning.plans;
      expect(life.view().planning.attempts[0].timezoneOffsetMinutes).toBe(-480);
      process.env.TZ = "America/New_York";
      const restored = createLifeContext(f.storage, () => clock, { generate });
      expect(restored.view().planning.plans).toEqual(savedPlans);
      clock = savedPlans[0].windows.find((window) => window.id === "evening")!.startAt + 15 * 60_000;
      expect(new Date(clock).getHours()).toBe(6);
      expect(restored.build()).not.toContain("后续计划调整");
      expect(restored.status()).toEqual({ text: "休息中", resting: true });
      expect(restored.view().planning.plans).toEqual(savedPlans);
      expect(generate).toHaveBeenCalledOnce();
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
  });

  it.each([
    ["越过休息时段", (state: any) => { state.planning.plans[0].windows[0].startAt = time(1, 23); state.planning.plans[0].windows[0].endAt = time(2, 7); }],
    ["改写过去窗口", (state: any) => { state.planning.plans[0].windows[0].startAt = time(1, 8); }],
    ["窗口顺序错误", (state: any) => { state.planning.plans[0].windows.reverse(); }],
    ["预算日期与请求时间不同", (state: any) => { state.planning.attempts[0].date = "2026-09-02"; state.planning.budgetDate = "2026-09-02"; }],
    ["重复的计划来源", (state: any) => { state.planning.plans.push(structuredClone(state.planning.plans[0])); }],
    ["不合理的时区偏移", (state: any) => { state.planning.attempts[0].timezoneOffsetMinutes = 1500; }],
  ])("%s时拒绝加载", async (_label, mutate) => {
    const seed = store(), generate = async (messages: PluginLlmMessage[]) => reply(inputOf(messages));
    const life = createLifeContext(seed.storage, () => time(1, 9), { generate });
    await life.plan("daily");
    const state = seed.state(); mutate(state);
    const f = store(state);
    expect(() => createLifeContext(f.storage, () => time(1, 10), { generate })).toThrow("规划状态损坏");
    expect(f.set).not.toHaveBeenCalled();
    expect(f.state()).toEqual(state);
  });
});
