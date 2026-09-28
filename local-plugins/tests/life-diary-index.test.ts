import { describe, expect, it } from "vitest";
import type { LifeEvent } from "../plugins/companion-chat/src/life-context";
import type { LifeDiary } from "../plugins/companion-chat/src/life-journal";
import { createLifeDiaryIndex } from "../plugins/companion-chat/src/life-diary-index";

const at = new Date("2026-09-30T00:00:00Z").getTime();
const event = (id: string, date: string, text: string, extra: Partial<LifeEvent> = {}): LifeEvent => ({
  id, date, text, startAt: at - 60_000, endAt: at - 30_000, worldLayer: "simulated_world",
  status: "materialized", source: "runtime_schedule", revision: 1, ...extra,
});
const diary = (date: string, summary: string): LifeDiary => ({
  id: `diary:${date}`, date, summary, eventRefs: [], revision: 1, status: "active",
  createdAt: at - 30_000, updatedAt: at - 30_000, source: "model",
});

describe("生活日记与事件索引", () => {
  it("按日期定位日记，按中文关键词找到事件并按日期归并", () => {
    const index = createLifeDiaryIndex(
      [diary("2026-09-28", "沿河散步后读了《星灯游记》"), diary("2026-09-29", "在家整理书页")],
      [event("walk", "2026-09-28", "沿河散步", { modelDetail: "在桥边看见一只猫" }),
        event("read", "2026-09-28", "读《星灯游记》"), event("notes", "2026-09-29", "整理书页")], at);
    expect(index.search("2026-09-28")).toMatchObject([{ date: "2026-09-28", diary: { source: "model" } }]);
    expect(index.search("星灯游记")).toMatchObject([{ date: "2026-09-28" }]);
    expect(index.search("以前读过哪本书")[0].date).toBe("2026-09-28");
    expect(index.search("桥边看见一只猫")[0].events).toMatchObject([{ id: "walk", modelDetail: "在桥边看见一只猫" }]);
    expect(index.search("整理书页")[0].date).toBe("2026-09-29");
  });

  it("索引重建后撤销事件与改写日记立即从结果消失", () => {
    const oldEvent = event("walk", "2026-09-28", "沿河散步", { modelDetail: "看见一只猫" });
    const oldDiary = diary("2026-09-28", "今天看见一只猫");
    const before = createLifeDiaryIndex([oldDiary], [oldEvent], at);
    expect(before.search("一只猫")).toHaveLength(1);
    const after = createLifeDiaryIndex([{ ...oldDiary, summary: "今天在家读书", revision: 2 }],
      [{ ...oldEvent, status: "revoked", modelDetail: undefined, revision: 2 }], at);
    expect(after.search("一只猫")).toEqual([]);
    expect(after.search("读书")).toMatchObject([{ date: "2026-09-28", diary: { revision: 2 }, events: [] }]);
    expect(oldEvent.status).toBe("materialized");
  });

  it("保留推演与旧版来源，忽略尚未发生的事件", () => {
    const index = createLifeDiaryIndex([], [
      event("inferred", "2026-09-28", "雨中散步", { status: "inferred", source: "offline_inference" }),
      event("legacy", "2026-09-27", "旧书阅读", { source: "legacy_schedule" }),
      event("future", "2026-09-30", "未来散步", { endAt: at + 60_000 }),
    ], at);
    expect(index.search("雨中散步")[0].events[0]).toMatchObject({ status: "inferred", source: "offline_inference" });
    expect(index.search("旧书阅读")[0].events[0].source).toBe("legacy_schedule");
    expect(index.search("未来")).toEqual([]);
  });
});
