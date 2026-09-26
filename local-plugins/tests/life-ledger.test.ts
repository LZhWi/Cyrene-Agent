import { describe, expect, it, vi } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createLifeContext } from "../plugins/companion-chat/src/life-context";

const time = (day: number, hour: number, minute = 0) => new Date(2026, 6, day, hour, minute).getTime();

function memoryStorage(initial: Array<[string, unknown]> = []) {
  const data = new Map(initial.map(([key, value]) => [key, structuredClone(value)]));
  let failNext = false;
  const set = vi.fn((key: string, value: unknown) => {
    if (failNext) { failNext = false; throw new Error("模拟原子写失败"); }
    data.set(key, structuredClone(value));
  });
  const storage: PluginStorage = {
    get: <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
    set,
    rootDir: () => "unused-memory-only",
  };
  return { data, storage, set, fail: () => { failNext = true; } };
}

const oldSettings = { version: 1, enabled: true, importantDates: [{ date: "07-27", label: "相识纪念日" }] };
const oldEvent = { id: "2026-07-27:上午", date: "2026-07-27", text: "上午：读书",
  startAt: time(27, 7), endAt: time(27, 12), worldLayer: "simulated_world", status: "materialized" };
const oldContinuity = { version: 1, cursorAt: time(27, 13), events: [oldEvent] };

describe("生活账本 v2：原子迁移与写入", () => {
  it("只读迁移旧数据，首次提交只写一个新文档并保留原来源缺失", () => {
    const f = memoryStorage([["life-context-settings", oldSettings], ["life-continuity", oldContinuity]]);
    const life = createLifeContext(f.storage, () => time(27, 13));
    expect(f.set).not.toHaveBeenCalled();
    expect(life.view().continuity.events[0]).toEqual({ ...oldEvent, source: "legacy_schedule", revision: 0 });
    life.build();
    expect(f.set.mock.calls.map(([key]) => key)).toEqual(["life-state"]);
    expect(f.data.get("life-context-settings")).toEqual(oldSettings);
    expect(f.data.get("life-continuity")).toEqual(oldContinuity);
    expect(life.view().continuity.revision).toBe(1);
    expect(createLifeContext(f.storage, () => time(27, 13)).view()).toEqual(life.view());
  });

  it("迁移恢复旧版回拨的高水位，不修改旧记录或旧文件", () => {
    const legacy = { ...oldContinuity, cursorAt: time(27, 10) };
    const f = memoryStorage([["life-continuity", legacy]]);
    const life = createLifeContext(f.storage, () => time(27, 10));
    life.build();
    expect(life.view().continuity.cursorAt).toBe(time(27, 12));
    expect(life.view().continuity.events[0]).toMatchObject(oldEvent);
    expect(f.data.get("life-continuity")).toEqual(legacy);
  });

  it("迁移写入失败保留全部旧数据，重试不会重复事件", () => {
    const f = memoryStorage([["life-continuity", oldContinuity]]);
    const life = createLifeContext(f.storage, () => time(27, 13));
    const before = life.view();
    f.fail();
    expect(() => life.build()).toThrow("模拟原子写失败");
    expect(life.view()).toEqual(before);
    expect(f.data.has("life-state")).toBe(false);
    expect(f.data.get("life-continuity")).toEqual(oldContinuity);
    life.build();
    expect(life.view().continuity.events).toHaveLength(1);
  });

  it("设置、游标与下界一次提交，写失败时内存与磁盘都不前进", () => {
    const f = memoryStorage();
    let at = time(27, 6);
    const life = createLifeContext(f.storage, () => at);
    life.build();
    const beforeView = life.view(), beforeDisk = structuredClone(f.data.get("life-state"));
    at = time(27, 10);
    f.fail();
    expect(() => life.configure(false, "07-27 改名纪念日")).toThrow("模拟原子写失败");
    expect(life.view()).toEqual(beforeView);
    expect(f.data.get("life-state")).toEqual(beforeDisk);
    life.configure(false, "07-27 改名纪念日");
    expect(f.data.get("life-state")).toMatchObject({ cursorAt: at, recordAfterAt: at,
      settings: { enabled: false, importantDates: [{ date: "07-27", label: "改名纪念日" }] } });
    expect(new Set(f.set.mock.calls.map(([key]) => key))).toEqual(new Set(["life-state"]));
  });

  it("检测另一实例的提交，拒绝旧实例覆盖最新状态", () => {
    const f = memoryStorage();
    let at = time(27, 6);
    const old = createLifeContext(f.storage, () => at);
    old.build();
    const current = createLifeContext(f.storage, () => at);
    current.configure(false, "07-27 新设置");
    const committed = structuredClone(f.data.get("life-state"));
    at = time(27, 13);
    expect(() => old.build()).toThrow("其他实例更新");
    expect(f.data.get("life-state")).toEqual(committed);
  });

  it("两实例均从空状态加载时，只有第一次提交成功", () => {
    const f = memoryStorage();
    const first = createLifeContext(f.storage, () => time(27, 6));
    const second = createLifeContext(f.storage, () => time(27, 6));
    first.build();
    expect(() => second.build()).toThrow("其他实例更新");
    expect(f.set).toHaveBeenCalledOnce();
  });
});

describe("生活账本 v2：时钟与来源", () => {
  it("运行期间完成的时段可确认，启动补算与跨启动时段保留推定来源", () => {
    const f = memoryStorage();
    let at = time(27, 6);
    const first = createLifeContext(f.storage, () => at);
    first.build();
    for (at += 15 * 60_000; at <= time(27, 13); at += 15 * 60_000) first.build();
    at = time(27, 13);
    expect(first.view().continuity.events[0]).toMatchObject({ status: "materialized", source: "runtime_schedule" });
    first.stop();
    at = time(27, 19);
    const second = createLifeContext(f.storage, () => at);
    second.build();
    expect(second.view().continuity.events[1]).toMatchObject({ id: "2026-07-27:下午", status: "inferred", source: "offline_inference" });
    for (at += 15 * 60_000; at <= time(27, 23); at += 15 * 60_000) second.build();
    at = time(27, 23);
    expect(second.view().continuity.events[2]).toMatchObject({ id: "2026-07-27:晚上", status: "inferred" });
    for (at += 15 * 60_000; at <= time(28, 13); at += 15 * 60_000) second.build();
    at = time(28, 13);
    expect(second.view().continuity.events[3]).toMatchObject({ id: "2026-07-28:上午", status: "materialized", source: "runtime_schedule" });
    const snapshot = second.view();
    second.build(); second.status();
    expect(second.view()).toEqual(snapshot);
    expect(second.build("昨天做了什么")).toContain("离线推演，不能当作确定经历");
  });

  it("回拨与恢复不重复处理时间，也不重新保存游标", () => {
    const f = memoryStorage();
    let at = time(27, 13);
    const life = createLifeContext(f.storage, () => at);
    life.build();
    const before = life.view();
    at = time(27, 8);
    life.build();
    expect(life.view()).toEqual(before);
    at = time(27, 13);
    life.status();
    expect(life.view()).toEqual(before);
    expect(f.set).toHaveBeenCalledOnce();
  });

  it("跨禁用时段只记录再次开启后的片段，跨天禁用不补算", () => {
    const f = memoryStorage();
    let at = time(27, 6);
    const life = createLifeContext(f.storage, () => at);
    life.build();
    at = time(27, 9); life.configure(false, "");
    at = time(29, 11); life.configure(true, "");
    const planned = life.build().split("\n").find((line) => line.startsWith("上午："))!.slice(3).split("、");
    expect(planned).toHaveLength(2);
    for (at += 15 * 60_000; at <= time(29, 13); at += 15 * 60_000) life.build();
    at = time(29, 13);
    expect(life.view().continuity.events).toEqual([expect.objectContaining({
      id: "2026-07-29:上午", startAt: time(29, 11), endAt: time(29, 12), status: "materialized",
      text: `上午（部分时段）：${planned[1]}`,
    })]);
  });

  it("构造后迟迟未启动的区间归为推演，不冒充运行记录", () => {
    const f = memoryStorage();
    let at = time(27, 6);
    const life = createLifeContext(f.storage, () => at);
    at = time(27, 13); life.build();
    expect(life.view().continuity.events[0]).toMatchObject({ status: "inferred", source: "offline_inference" });
  });

  it("禁用时在同一次提交中结算刚结束的活动，不丢失最后检查点之后的完成记录", () => {
    const f = memoryStorage();
    let at = time(27, 7);
    const life = createLifeContext(f.storage, () => at);
    life.build();
    for (at += 15 * 60_000; at <= time(27, 11, 45); at += 15 * 60_000) life.build();
    at = time(27, 11, 45);
    const writes = f.set.mock.calls.length;
    at = time(27, 12, 1); life.configure(false, "");
    expect(f.set).toHaveBeenCalledTimes(writes + 1);
    expect(life.view()).toMatchObject({ enabled: false, continuity: { cursorAt: at,
      events: [expect.objectContaining({ id: "2026-07-27:上午", status: "materialized" })] } });
  });

  it("长缺口概括后仅记录恢复以后的片段，二者不重叠", () => {
    const f = memoryStorage();
    let at = time(1, 9);
    const first = createLifeContext(f.storage, () => at);
    first.build(); first.stop();
    at = time(20, 9);
    const resumed = createLifeContext(f.storage, () => at);
    resumed.build();
    for (at += 15 * 60_000; at <= time(20, 12); at += 15 * 60_000) resumed.build();
    at = time(20, 12);
    const events = resumed.view().continuity.events;
    expect(events).toHaveLength(2);
    expect(events[1].startAt).toBe(events[0].endAt);
    expect(events[1]).toMatchObject({ source: "runtime_schedule", status: "materialized", startAt: time(20, 9) });
  });

  it("今日完成查询注入有效记录，当前状态和未来安排查询不注入", () => {
    const f = memoryStorage();
    let at = time(27, 7);
    const life = createLifeContext(f.storage, () => at);
    life.build();
    at = time(27, 13);
    for (const query of ["今天上午做了什么", "2026-07-27做了什么", "刚才干了什么"]) {
      expect(life.build(query)).toContain("[角色世界生活记录]");
    }
    for (const query of ["今天有什么安排", "你现在做什么", "2026-07-28做了什么", "你好"]) {
      expect(life.build(query)).not.toContain("[角色世界生活记录]");
    }
  });

  it.each([72, 73])("离线 %i 小时遵守详细续演边界", (hours) => {
    const f = memoryStorage();
    let at = time(1, 6);
    const first = createLifeContext(f.storage, () => at);
    first.build(); first.stop();
    at += hours * 60 * 60 * 1000;
    const resumed = createLifeContext(f.storage, () => at);
    resumed.build();
    const events = resumed.view().continuity.events;
    expect(events).toHaveLength(hours === 72 ? 9 : 1);
    expect(events.every((event) => event.status === "inferred" && event.source === "offline_inference")).toBe(true);
    expect(events.some((event) => event.id.startsWith("gap:"))).toBe(hours > 72);
  });

  it("stop 后读取与再次 start 均不会写入，修改被拒绝", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(time(27, 6));
      const f = memoryStorage(), life = createLifeContext(f.storage);
      life.start();
      const before = life.view(), writes = f.set.mock.calls.length;
      life.stop(); life.stop(); life.start();
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
      life.build("昨天做了什么"); life.status();
      expect(life.view()).toEqual(before);
      expect(f.set).toHaveBeenCalledTimes(writes);
      expect(() => life.configure(false, "")).toThrow("已停止");
      expect(() => life.revokeEvent("missing")).toThrow("已停止");
    } finally { vi.useRealTimers(); }
  });

  it("撤销记录保留历史与版本，重启后查询不再使用或重复生成", () => {
    const f = memoryStorage();
    let at = time(27, 13);
    const life = createLifeContext(f.storage, () => at);
    life.build();
    const event = life.view().continuity.events[0];
    life.revokeEvent(event.id);
    expect(life.view().continuity.events[0]).toEqual({ ...event, status: "revoked", revision: 2 });
    at = time(28, 8);
    const restored = createLifeContext(f.storage, () => at);
    const prompt = restored.build("昨天做了什么");
    expect(prompt).not.toContain(event.text);
    expect(restored.view().continuity.events.filter((item) => item.id === event.id)).toHaveLength(1);
  });

  it("未完成日程只是计划，不创建未来事件或声称执行现实工具", () => {
    const f = memoryStorage(), life = createLifeContext(f.storage, () => time(27, 8));
    const prompt = life.build();
    expect(life.view().continuity.events).toEqual([]);
    expect(prompt).toContain("日程安排只表示计划");
    expect(prompt).toContain("不要声称因此操作过现实设备或外部服务");
  });
});

describe("生活账本 v2：损坏拒写", () => {
  it.each([
    ["重复事件 ID", (state: any) => state.events.push(structuredClone(state.events[0]))],
    ["无效日历日期", (state: any) => { state.events[0].date = "2026-02-30"; }],
    ["负时间", (state: any) => { state.events[0].startAt = -1; }],
    ["结束不晚于开始", (state: any) => { state.events[0].endAt = state.events[0].startAt; }],
    ["事件超前于游标", (state: any) => { state.events[0].endAt = state.cursorAt + 1; }],
    ["事件版本超前", (state: any) => { state.events[0].revision = state.revision + 1; }],
    ["来源冒充实发生", (state: any) => { state.events[0].status = "materialized"; }],
    ["未知来源", (state: any) => { state.events[0].source = "tool_success"; }],
    ["无效纪念日", (state: any) => { state.settings.importantDates = [{ date: "02-30", label: "无效" }]; }],
    ["启用下界超前", (state: any) => { state.recordAfterAt = state.cursorAt + 1; }],
  ])("%s 时不覆盖，也不回退到旧文件", (_name, mutate) => {
    const seed = memoryStorage();
    createLifeContext(seed.storage, () => time(27, 13)).build();
    const state = structuredClone(seed.data.get("life-state"));
    mutate(state);
    const f = memoryStorage([["life-state", state], ["life-continuity", oldContinuity]]);
    const before = structuredClone([...f.data]);
    expect(() => createLifeContext(f.storage, () => time(28, 13))).toThrow("损坏");
    expect([...f.data]).toEqual(before);
    expect(f.set).not.toHaveBeenCalled();
  });

  it("旧版重复 ID 拒绝迁移，年度闰日仍有效", () => {
    const f = memoryStorage([["life-continuity", { ...oldContinuity, events: [oldEvent, oldEvent] }]]);
    expect(() => createLifeContext(f.storage, () => time(27, 13))).toThrow("损坏");
    expect(f.set).not.toHaveBeenCalled();
    const good = createLifeContext(memoryStorage().storage, () => time(27, 6));
    expect(() => good.configure(true, "02-29 年度闰日\n2028-02-29 闰年约定")).not.toThrow();
    expect(() => good.configure(true, "2026-02-29 错误闰日")).toThrow("纪念日格式无效");
  });
});
