import { describe, expect, it, vi } from "vitest";
import type { PluginLlmMessage, PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createLifeContext } from "../plugins/companion-chat/src/life-context";
import type { LifePlanningInput } from "../plugins/companion-chat/src/life-planning";

const time = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();

function fixture() {
  let value: any, fail = false;
  const set = vi.fn((key: string, next: unknown) => {
    expect(key).toBe("life-state");
    if (fail) { fail = false; throw new Error("模拟原子写失败"); }
    value = structuredClone(next);
  });
  const storage: PluginStorage = { get: <T>(key: string) => (key === "life-state" ? structuredClone(value) : undefined) as T | undefined,
    set, rootDir: () => "unused-memory-only" };
  return { storage, set, disk: () => structuredClone(value), failNext: () => { fail = true; } };
}

function firstMorningActivity(life: ReturnType<typeof createLifeContext>): string {
  return life.build().split("\n").find((line) => line.startsWith("上午："))!.slice(3).split("、")[0];
}

describe("角色日记与目标接线", () => {
  it("跨日才生成来源日记，重复查询和重启不重写或重复创建", () => {
    const f = fixture();
    let at = time(1, 6);
    const life = createLifeContext(f.storage, () => at);
    life.build();
    at = time(1, 23, 30); life.build();
    expect(life.view().journal.diaries).toEqual([]);
    at = time(2, 8); life.build();
    const diary = life.view().journal.diaries[0];
    expect(diary).toMatchObject({ date: "2026-09-01", status: "active" });
    expect(diary.eventRefs).toEqual(life.view().continuity.events.filter((event) => event.date === diary.date)
      .map(({ id, revision }) => ({ id, revision })));
    expect(diary.summary).toContain("模拟活动：");
    const writes = f.set.mock.calls.length;
    life.build("昨日日记"); life.status();
    const restored = createLifeContext(f.storage, () => at);
    restored.build("昨日日记");
    expect(restored.view().journal.diaries).toEqual([diary]);
    expect(f.set).toHaveBeenCalledTimes(writes);
  });

  it("自动范围外的旧日期可以手动重建，没有来源的日期拒绝编造", () => {
    const f = fixture();
    let at = time(1, 6);
    const first = createLifeContext(f.storage, () => at);
    first.build();
    at = time(1, 23, 30); first.build(); first.stop();
    at = time(20, 8);
    const life = createLifeContext(f.storage, () => at);
    life.build();
    expect(life.view().journal.diaries).toEqual([]);
    life.rebuildDiary("2026-09-01");
    expect(life.view().journal.diaries[0]).toMatchObject({ date: "2026-09-01", status: "active" });
    const before = f.disk();
    expect(() => life.rebuildDiary("2026-08-01")).toThrow("没有可引用");
    expect(f.disk()).toEqual(before);
  });

  it("暂停之前结算刚完成活动，目标跨日不会自动完成", () => {
    const f = fixture();
    let at = time(1, 6);
    const life = createLifeContext(f.storage, () => at);
    const activity = firstMorningActivity(life);
    life.saveGoal({ title: "继续自己的小练习", activity });
    const id = life.view().journal.goals[0].id;
    at = time(1, 12, 1);
    life.setGoalStatus(id, "paused");
    expect(life.view().journal.goals[0]).toMatchObject({ status: "paused", eventRefs: [expect.objectContaining({ id: "2026-09-01:上午" })] });
    at = time(2, 13);
    life.setGoalStatus(id, "active");
    expect(life.view().journal.goals[0]).toMatchObject({ status: "active", activeSince: at });
    expect(life.view().journal.goals[0].eventRefs).toHaveLength(1);
    at = time(3, 6); life.build();
    expect(life.view().journal.goals[0].status).toBe("active");
    life.setGoalStatus(id, "completed");
    expect(life.view().journal.goals[0].status).toBe("completed");
  });

  it("事件撤销与日记、目标来源引用在同一次提交中失效", () => {
    const f = fixture();
    let at = time(1, 6);
    const life = createLifeContext(f.storage, () => at);
    life.saveGoal({ title: "早间小练习", activity: firstMorningActivity(life) });
    at = time(2, 8); life.build();
    const event = life.view().continuity.events.find((event) => event.id === "2026-09-01:上午")!;
    expect(life.view().journal.goals[0].eventRefs.some((ref) => ref.id === event.id)).toBe(true);
    const before = life.view(), diskBefore = f.disk();
    f.failNext();
    expect(() => life.revokeEvent(event.id)).toThrow("模拟原子写失败");
    expect(life.view()).toEqual(before);
    expect(f.disk()).toEqual(diskBefore);
    const writes = f.set.mock.calls.length;
    life.revokeEvent(event.id);
    expect(f.set).toHaveBeenCalledTimes(writes + 1);
    expect(life.view().journal.goals[0].eventRefs.some((ref) => ref.id === event.id)).toBe(false);
    expect(life.view().journal.diaries[0].eventRefs.some((ref) => ref.id === event.id)).toBe(false);
    expect(life.view().journal.diaries[0].summary).not.toContain(event.text);
    for (const remaining of life.view().continuity.events.filter((item) => item.date === "2026-09-01" && item.status !== "revoked")) life.revokeEvent(remaining.id);
    expect(life.view().journal.diaries[0]).toMatchObject({ status: "revoked", eventRefs: [], summary: "" });
    expect(createLifeContext(f.storage, () => at).view().journal).toEqual(life.view().journal);
  });

  it("只有活跃目标进入单次规划输入，日记和普通读取不额外调用模型", async () => {
    const f = fixture();
    const generate = vi.fn(async (messages: PluginLlmMessage[]) => {
      const input = JSON.parse(messages.at(-1)!.content) as LifePlanningInput;
      return JSON.stringify({ kind: input.kind, date: input.date, revision: input.revision,
        windows: input.windows.map((window) => ({ id: window.id, activities: [input.activities[0]] })) });
    });
    const life = createLifeContext(f.storage, () => time(1, 9), { generate });
    life.saveGoal({ title: "活跃书页目标", activity: "读书" });
    life.saveGoal({ title: "暂停散步目标", activity: "散步", status: "paused" });
    life.saveGoal({ title: "已完成学习目标", activity: "学习", status: "completed" });
    life.build("日记和目标进展"); life.status();
    expect(generate).not.toHaveBeenCalled();
    expect((await life.plan("daily")).status).toBe("applied");
    const input = JSON.parse(generate.mock.calls[0][0].at(-1)!.content) as LifePlanningInput;
    expect(input.goals).toEqual([expect.objectContaining({ title: "活跃书页目标", activity: "读书" })]);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("日记与目标仅按需注入，问今天不会拿昨天日记顶替", () => {
    const f = fixture();
    let at = time(1, 6);
    const life = createLifeContext(f.storage, () => at);
    life.saveGoal({ title: "寻找蓝色书签", activity: "读书", remind: false });
    at = time(2, 8); life.build();
    expect(life.build("你好")).not.toContain("[角色日记]");
    expect(life.build("你好")).not.toContain("寻找蓝色书签");
    expect(life.build("目标进展")).toContain("寻找蓝色书签");
    expect(life.build("目标进展", { proactive: true })).not.toContain("寻找蓝色书签");
    expect(life.build("昨日日记")).toContain("2026-09-01：");
    expect(life.build("今天日记")).toContain("所问时段没有有效日记");
    expect(life.build("今天日记")).not.toContain("2026-09-01：");
    expect(life.build("目标进展")).toContain("不能作为用户事实");
    at = time(1, 23);
    expect(life.build("2026-09-01日记")).toContain("所问时段没有有效日记");
  });

  it("目标编辑、停止与失败提交都不留下半写入状态", () => {
    const f = fixture();
    const life = createLifeContext(f.storage, () => time(1, 9));
    life.build();
    const before = life.view(), diskBefore = f.disk();
    f.failNext();
    expect(() => life.saveGoal({ title: "小目标", activity: "读书" })).toThrow("模拟原子写失败");
    expect(life.view()).toEqual(before);
    expect(f.disk()).toEqual(diskBefore);
    for (let index = 0; index < 3; index++) life.saveGoal({ title: `小目标${index}`, activity: "读书" });
    expect(() => life.saveGoal({ title: "第四个活跃目标", activity: "读书" })).toThrow("最多同时");
    expect(life.view().journal.goals).toHaveLength(3);
    const id = life.view().journal.goals[0].id;
    life.stop();
    const writes = f.set.mock.calls.length;
    expect(() => life.saveGoal({ id, title: "停止后编辑", activity: "读书" })).toThrow("已停止");
    expect(() => life.setGoalStatus(id, "cancelled")).toThrow("已停止");
    expect(() => life.rebuildDiary("2026-09-01")).toThrow("已停止");
    expect(() => life.setImportantDateReminder("09-01", "纪念日", false)).toThrow("已停止");
    expect(f.set).toHaveBeenCalledTimes(writes);
  });
});

describe("重要日期提醒边界", () => {
  it("不提醒可手动查询，宿主旧文本同步保留标志，改期和移除旧项失效", () => {
    const f = fixture();
    let at = time(1, 9);
    const life = createLifeContext(f.storage, () => at);
    life.configure(true, "09-01 安静纪念日\n09-01 普通日期");
    life.setImportantDateReminder("09-01", "安静纪念日", false);
    life.configure(true, life.view().importantDatesText);
    expect(life.view().importantDates.find((item) => item.label === "安静纪念日")?.remind).toBe(false);
    expect(life.build("今天特别的日期")).toContain("安静纪念日");
    expect(life.build("", { proactive: true })).not.toContain("安静纪念日");
    expect(life.build("", { proactive: true })).toContain("普通日期");
    expect(createLifeContext(f.storage, () => at).view().importantDates).toEqual(life.view().importantDates);
    life.configure(true, "09-02 安静纪念日");
    expect(life.build("", { proactive: true })).not.toContain("普通日期");
    expect(life.build("", { proactive: true })).not.toContain("安静纪念日");
    at = time(2, 9);
    expect(life.build("", { proactive: true })).toContain("安静纪念日");
    expect(() => life.setImportantDateReminder("09-01", "安静纪念日", false)).toThrow("不存在");
    life.configure(true, "");
    expect(life.build("", { proactive: true })).not.toContain("安静纪念日");
  });
});
