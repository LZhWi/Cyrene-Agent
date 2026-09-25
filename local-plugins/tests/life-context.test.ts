import { describe, expect, it, vi } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createLifeContext, localDateKey } from "../plugins/companion-chat/src/life-context";

function storage(initial?: unknown): PluginStorage {
  const data = new Map<string, unknown>();
  if (initial !== undefined) data.set("life-context-settings", initial);
  return {
    get: <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
    set: (key, value) => { data.set(key, structuredClone(value)); },
    rootDir: () => "unused",
  };
}

function stripCurrent(text: string): string {
  return text.split("[角色世界已发生的生活片段]")[0].split("使用规则：")[0]
    .split("\n").filter((line) => !line.startsWith("你现在正在做：")).join("\n");
}

function slotItems(text: string, label: string): string[] {
  const line = text.split("\n").find((item) => item.startsWith(`${label}：`));
  return line ? line.slice(label.length + 1).split("、") : [];
}

describe("陪伴插件生活日程", () => {
  it("默认启用，同一日程日保持一致且跨时段不重复", () => {
    const morning = createLifeContext(storage(), () => new Date(2026, 6, 27, 9, 15).getTime()).build();
    const evening = createLifeContext(storage(), () => new Date(2026, 6, 27, 21, 40).getTime()).build();
    expect(stripCurrent(morning)).toBe(stripCurrent(evening));
    const all = ["上午", "下午", "晚上"].flatMap((label) => slotItems(morning, label));
    expect(new Set(all).size).toBe(all.length);
    expect(morning).toContain("[你的生活]");
    expect(morning).toContain("不得声称发生在现实世界或用户所在的城市");
  });

  it("4 点换日，7:00–23:00 外不声称正在做日程", () => {
    expect(localDateKey(new Date(2026, 0, 5, 3, 59))).toBe("2026-01-04");
    expect(localDateKey(new Date(2026, 0, 5, 4, 0))).toBe("2026-01-05");
    const night = createLifeContext(storage(), () => new Date(2026, 6, 27, 23, 30).getTime()).build();
    expect(night).not.toContain("你现在正在做：");
    expect(createLifeContext(storage(), () => new Date(2026, 6, 27, 23, 30).getTime()).status())
      .toEqual({ text: "休息中", resting: true });
  });

  it("UI 状态与模型上下文使用同一个当前活动", () => {
    const life = createLifeContext(storage(), () => new Date(2026, 6, 27, 9, 15).getTime());
    const activity = life.build().split("\n").find((line) => line.startsWith("你现在正在做："))
      ?.slice("你现在正在做：".length);
    expect(activity).toBeTruthy();
    expect(life.status()).toEqual({
      text: activity!.startsWith("在") ? `正${activity}` : `正在${activity}`,
      resting: false,
    });
  });

  it("纪念日使用插件私有设置，支持年度与单年日期", () => {
    const life = createLifeContext(storage(), () => new Date(2026, 6, 27, 12, 0).getTime());
    life.configure(true, "07-27 认识纪念日\n2026-07-27 出发前一个月\n08-15 不应出现");
    expect(life.build()).toContain("今天对你们来说是特别的日子：认识纪念日；出发前一个月。");
    expect(life.build()).not.toContain("不应出现");
    expect(life.view().importantDatesText).toContain("07-27 认识纪念日");
  });

  it("关闭后返回空内容，坏格式和损坏状态都拒绝覆盖", () => {
    const life = createLifeContext(storage());
    expect(() => life.configure(true, "七月二十七 纪念日")).toThrow("纪念日格式无效");
    life.configure(false, "");
    expect(life.build()).toBe("");
    expect(life.status()).toBeNull();
    expect(() => createLifeContext(storage({ version: 1, enabled: true, importantDates: "bad" })))
      .toThrow("生活日程设置损坏");
  });

  it("已过去的模拟日程记为角色世界已发生，重启后不重复写入", () => {
    const store = storage();
    let at = new Date(2026, 6, 27, 8).getTime();
    const life = createLifeContext(store, () => at);
    expect(life.build()).not.toContain("[角色世界已发生的生活片段]");
    at = new Date(2026, 6, 27, 13).getTime();
    const prompt = life.build();
    expect(prompt).not.toContain("[角色世界已发生的生活片段]");
    expect(life.view().continuity.events).toEqual([expect.objectContaining({
      id: "2026-07-27:上午", worldLayer: "simulated_world", status: "materialized",
    })]);
    expect(createLifeContext(store, () => at).build("今天做了什么")).not.toContain("[角色世界已发生的生活片段]");
    expect(createLifeContext(store, () => at).build("你昨天做了什么")).toContain("[生活记录] 所问时段没有逐项保存的活动；不要编造具体经历。");
    expect(createLifeContext(store, () => at).view().continuity.events).toHaveLength(1);
  });

  it("长时间离线只保留概括，关闭日程期间不补算", () => {
    const store = storage();
    let at = new Date(2026, 6, 1, 9).getTime();
    const life = createLifeContext(store, () => at);
    life.build();
    at = new Date(2026, 6, 20, 9).getTime();
    const resumed = createLifeContext(store, () => at);
    expect(resumed.build()).not.toContain("未逐项保存活动");
    expect(resumed.build("之前做了什么")).toContain("未逐项保存活动");
    expect(resumed.view().continuity.events).toHaveLength(1);
    resumed.configure(false, "");
    at = new Date(2026, 6, 21, 9).getTime();
    expect(resumed.build()).toBe("");
    resumed.configure(true, "");
    expect(resumed.view().continuity.events).toHaveLength(1);
  });

  it("系统时间倒退时不补造新活动，时间恢复后不重复记录", () => {
    const store = storage();
    let at = new Date(2026, 6, 27, 13).getTime();
    const life = createLifeContext(store, () => at);
    life.build();
    expect(life.view().continuity.events).toHaveLength(1);
    at = new Date(2026, 6, 27, 10).getTime();
    life.build();
    expect(life.view().continuity.events).toHaveLength(1);
    at = new Date(2026, 6, 27, 13).getTime();
    life.build();
    expect(life.view().continuity.events).toHaveLength(1);
  });

  it("运行期间按时钟推进，历史询问按日期取记录", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 6, 27, 8));
      const life = createLifeContext(storage());
      life.start();
      vi.advanceTimersByTime(5 * 60 * 60 * 1000);
      expect(life.view().continuity.events).toEqual([expect.objectContaining({ id: "2026-07-27:上午" })]);
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
      expect(life.view().continuity.events.length).toBeGreaterThanOrEqual(4);
      const yesterday = life.build("你昨天做了什么").split("[角色世界已发生的生活片段]")[1].split("使用规则：")[0];
      expect(yesterday).toContain("2026-07-27 上午：");
      expect(yesterday).not.toContain("2026-07-28 上午：");
      life.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("保存的生活记录不再只保留最近 30 条", () => {
    const store = storage();
    let at = new Date(2026, 6, 1, 23, 30).getTime();
    const life = createLifeContext(store, () => at);
    life.build();
    for (let day = 2; day <= 12; day++) {
      at = new Date(2026, 6, day, 23, 30).getTime();
      life.build();
    }
    expect(life.view().continuity.events).toHaveLength(36);
    expect(life.build()).not.toContain("[角色世界已发生的生活片段]");
    expect(life.build("你2026-07-01做了什么")).toContain("2026-07-01 上午：");
    const lastWeek = life.build("你上周做了什么").split("[角色世界已发生的生活片段]")[1].split("使用规则：")[0];
    expect(lastWeek).toContain("2026-07-01 上午：");
    expect(lastWeek).not.toContain("2026-07-06 上午：");
  });
});
