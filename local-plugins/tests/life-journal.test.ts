import { describe, expect, it } from "vitest";
import type { LifeEvent } from "../plugins/companion-chat/src/life-context";
import { reconcileLifeJournal, rebuildLifeDiary, saveLifeGoal, setLifeGoalStatus, validateJournal, type LifeJournal } from "../plugins/companion-chat/src/life-journal";

const at = (day: number, hour = 12) => new Date(2026, 8, day, hour).getTime();
const event = (id: string, day: number, options: Partial<LifeEvent> = {}): LifeEvent => ({ id, date: `2026-09-${day}`,
  text: "上午：读书", startAt: at(day, 7), endAt: at(day, 12), worldLayer: "simulated_world", status: "materialized", source: "runtime_schedule", revision: 2, ...options });
const empty = (): LifeJournal => ({ goals: [], diaries: [] });

describe("有来源的角色日记与跨日目标", () => {
  it("日记只有来源内的内容与版本，不把推演写成确定经历，重建幂等", () => {
    const events = [event("e1", 25), event("e2", 25, { status: "inferred", source: "offline_inference", text: "下午：听歌" })];
    const journal = reconcileLifeJournal(empty(), events, at(26), 3, "2026-09-26");
    expect(journal.diaries[0].eventRefs).toEqual([{ id: "e1", revision: 2 }, { id: "e2", revision: 2 }]);
    expect(journal.diaries[0].summary).toBe("模拟活动：上午：读书\n离线推演：下午：听歌");
    expect(rebuildLifeDiary(journal, "2026-09-25", events, at(26, 13), 4)).toEqual(journal);
    expect(validateJournal(journal, events, at(26), 3)).toEqual(journal);
  });

  it("来源撤销后日记和目标进展一起失效，原先的旧日记不能继续证明经历", () => {
    const events = [event("e1", 25)];
    const goals = saveLifeGoal([], { title: "继续读书", activity: "读书" }, at(24), 1, ["读书"]);
    const first = reconcileLifeJournal({ goals, diaries: [] }, events, at(26), 3, "2026-09-26");
    expect(first.goals[0].eventRefs).toHaveLength(1);
    events[0] = { ...events[0], status: "revoked", revision: 4 };
    const revoked = reconcileLifeJournal(first, events, at(26), 4, "2026-09-26");
    expect(revoked.goals[0].eventRefs).toEqual([]);
    expect(revoked.diaries[0]).toMatchObject({ status: "revoked", summary: "", eventRefs: [], revision: 4 });
    expect(validateJournal(revoked, events, at(26), 4)).toEqual(revoked);
  });

  it("跨日保留目标，推演和旧版事件不算进展，有进展也不会自动完成", () => {
    const goals = saveLifeGoal([], { title: "读一本书", activity: "读书", dueDate: "2026-09-30", remind: false }, at(24), 1, ["读书"]);
    const events = [event("past", 23), event("real", 25), event("offline", 26, { source: "offline_inference", status: "inferred" }),
      event("legacy", 26, { source: "legacy_schedule" })];
    const journal = reconcileLifeJournal({ goals, diaries: [] }, events, at(27), 3, "2026-09-27");
    expect(journal.goals[0]).toMatchObject({ status: "active", remind: false, source: "user", eventRefs: [{ id: "real", revision: 2 }] });
    expect(setLifeGoalStatus(journal.goals, goals[0].id, "completed", at(27), 4)[0].status).toBe("completed");
  });

  it("暂停期间及恢复前开始的活动不回填，修改目标活动重置来源", () => {
    let goals = saveLifeGoal([], { title: "读书", activity: "读书" }, at(24), 1, ["读书", "学习"]);
    goals = setLifeGoalStatus(goals, goals[0].id, "paused", at(25, 6), 2);
    const paused = reconcileLifeJournal({ goals, diaries: [] }, [event("e1", 25)], at(26), 3, "2026-09-26");
    expect(paused.goals[0].eventRefs).toEqual([]);
    goals = setLifeGoalStatus(paused.goals, goals[0].id, "active", at(26, 10), 4);
    const resumed = reconcileLifeJournal({ goals, diaries: [] }, [event("e1", 25), event("cross", 26), event("next", 27)], at(28), 5, "2026-09-28");
    expect(resumed.goals[0].eventRefs.map((ref) => ref.id)).toEqual(["next"]);
    const edited = saveLifeGoal(resumed.goals, { id: goals[0].id, title: "学点新内容", activity: "学习" }, at(28), 6, ["读书", "学习"]);
    expect(edited[0].eventRefs).toEqual([]);
  });

  it("自动日记仅补近期已结束日期，旧日期可明确重建", () => {
    const events = [event("old", 10), event("today", 26)];
    const journal = reconcileLifeJournal(empty(), events, at(26), 3, "2026-09-26");
    expect(journal.diaries).toEqual([]);
    expect(rebuildLifeDiary(journal, "2026-09-10", events, at(26), 3).diaries[0].eventRefs[0].id).toBe("old");
    expect(() => rebuildLifeDiary(journal, "2026-02-30", events, at(26), 3)).toThrow();
  });

  it("最多三个活跃目标；非法日期、未知活动与悬空引用拒绝保存", () => {
    let goals = [] as LifeJournal["goals"];
    for (let i = 0; i < 3; i++) goals = saveLifeGoal(goals, { title: `目标${i}`, activity: "读书" }, at(24), i + 1, ["读书"]);
    expect(() => saveLifeGoal(goals, { title: "第四个", activity: "读书" }, at(24), 4, ["读书"])).toThrow("3 个");
    expect(() => saveLifeGoal([], { title: "日期", activity: "读书", dueDate: "2026-02-30" }, at(24), 4, ["读书"])).toThrow();
    expect(() => saveLifeGoal([], { title: "动作", activity: "操作用户电脑" }, at(24), 4, ["读书"])).toThrow();
    goals[0].eventRefs = [{ id: "missing", revision: 1 }];
    expect(() => validateJournal({ goals, diaries: [] }, [], at(25), 4)).toThrow("损坏");
  });

  it("拒绝合法引用搭配篡改正文、早于来源的日记，以及目标创建前的伪进度", () => {
    const events = [event("source", 25)];
    const journal = reconcileLifeJournal(empty(), events, at(26), 3, "2026-09-26");
    const forged = structuredClone(journal);
    forged.diaries[0].summary = "用户喜欢草莓";
    expect(() => validateJournal(forged, events, at(26), 3)).toThrow("损坏");
    const early = structuredClone(journal);
    early.diaries[0].createdAt = at(24); early.diaries[0].updatedAt = at(25, 8);
    expect(() => validateJournal(early, events, at(26), 3)).toThrow("损坏");
    const goals = saveLifeGoal([], { title: "新目标", activity: "读书" }, at(26), 3, ["读书"]);
    goals[0].eventRefs = [{ id: "source", revision: 2 }];
    expect(() => validateJournal({ goals, diaries: [] }, events, at(26), 3)).toThrow("损坏");
  });
});
