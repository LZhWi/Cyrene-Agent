import { describe, expect, it } from "vitest";
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
  return text.split("\n").filter((line) => !line.startsWith("你现在正在做：")).join("\n");
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
});
