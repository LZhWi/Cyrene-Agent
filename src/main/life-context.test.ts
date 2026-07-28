import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildLifeContext, localDateKey } from "./life-context";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "life-context-test-"));
}

/** 去掉随时间窗变化的「你现在正在做」行，剩余部分即当日固定的日程表。 */
function stripCurrentLine(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.startsWith("你现在正在做："))
    .join("\n");
}

function getCurrentLine(text: string): string | undefined {
  return text.split("\n").find((line) => line.startsWith("你现在正在做："));
}

function getSlotItems(text: string, label: string): string[] {
  const line = text.split("\n").find((l) => l.startsWith(`${label}：`));
  if (!line) return [];
  return line.slice(label.length + 1).split("、");
}

describe("buildLifeContext", () => {
  it("同一天内日程表部分完全一致（「正在做」行除外）", () => {
    const dir = makeTempDir();
    const morning = buildLifeContext(new Date(2026, 6, 27, 9, 15), dir);
    const evening = buildLifeContext(new Date(2026, 6, 27, 21, 40), dir);
    expect(stripCurrentLine(morning)).toBe(stripCurrentLine(evening));
  });

  it("同一时间窗内多次调用输出完全一致", () => {
    const dir = makeTempDir();
    const a = buildLifeContext(new Date(2026, 6, 27, 13, 0), dir);
    const b = buildLifeContext(new Date(2026, 6, 27, 13, 5), dir);
    expect(a).toBe(b);
  });

  it("不同日期的日程会变化（连续 10 天至少出现 2 种输出）", () => {
    const dir = makeTempDir();
    const outputs = new Set<string>();
    for (let day = 1; day <= 10; day += 1) {
      outputs.add(buildLifeContext(new Date(2026, 6, day, 12, 0), dir));
    }
    expect(outputs.size).toBeGreaterThanOrEqual(2);
  });

  it("输出包含标题、三个时段的日程行与使用规则", () => {
    const text = buildLifeContext(new Date(2026, 6, 27, 12, 0), makeTempDir());
    expect(text).toContain("[你的生活]");
    expect(text).toContain("今天（7月27日）你在你的虚拟世界里的日程：");
    expect(text).toContain("上午：");
    expect(text).toContain("下午：");
    expect(text).toContain("晚上：");
    expect(text).toContain("使用规则：当你主动给用户发消息时，最多自然地提到一条你的日程");
    expect(text).toContain("不得声称发生在现实世界或用户所在的城市");
    expect(text).toContain("以「你现在正在做」为准");
  });

  it("时段内（7:00-23:00）输出「正在做」且来自当前时段的日程", () => {
    const dir = makeTempDir();
    const text = buildLifeContext(new Date(2026, 6, 27, 13, 0), dir);
    const current = getCurrentLine(text);
    expect(current).toBeDefined();
    const doing = current!.slice("你现在正在做：".length);
    expect(getSlotItems(text, "下午")).toContain(doing);
  });

  it("日程空窗（23点后、7点前）不输出「正在做」行", () => {
    const dir = makeTempDir();
    expect(getCurrentLine(buildLifeContext(new Date(2026, 6, 27, 23, 30), dir))).toBeUndefined();
    expect(getCurrentLine(buildLifeContext(new Date(2026, 6, 27, 6, 30), dir))).toBeUndefined();
  });

  it("时间窗确定性推进：下午有 2 条时，前半段与后半段「正在做」不同且按顺序", () => {
    const dir = makeTempDir();
    // 日期哈希决定条数，找一个下午恰好 2 条的日期来验证推进
    let target: number | null = null;
    for (let day = 1; day <= 28; day += 1) {
      const text = buildLifeContext(new Date(2026, 7, day, 12, 30), dir);
      if (getSlotItems(text, "下午").length === 2) {
        target = day;
        break;
      }
    }
    expect(target).not.toBeNull();
    const early = buildLifeContext(new Date(2026, 7, target!, 12, 30), dir);
    const late = buildLifeContext(new Date(2026, 7, target!, 17, 30), dir);
    const items = getSlotItems(early, "下午");
    expect(getCurrentLine(early)).toBe(`你现在正在做：${items[0]}`);
    expect(getCurrentLine(late)).toBe(`你现在正在做：${items[1]}`);
  });

  it("跨时段去重：同一天三个时段没有重复条目", () => {
    const dir = makeTempDir();
    for (let day = 1; day <= 28; day += 1) {
      const text = buildLifeContext(new Date(2026, 6, day, 12, 0), dir);
      const all = [
        ...getSlotItems(text, "上午"),
        ...getSlotItems(text, "下午"),
        ...getSlotItems(text, "晚上"),
      ];
      expect(new Set(all).size).toBe(all.length);
      expect(all.length).toBeGreaterThanOrEqual(3);
      expect(all.length).toBeLessThanOrEqual(6);
    }
  });

  it("上午/下午大概率排 2 条（60 天窗口内 2 条占比不低于 60%）", () => {
    const dir = makeTempDir();
    let morningTwo = 0;
    let afternoonTwo = 0;
    const totalDays = 60;
    for (let i = 0; i < totalDays; i += 1) {
      const date = new Date(2026, 6, 1 + i, 12, 0);
      const text = buildLifeContext(date, dir);
      const morning = getSlotItems(text, "上午").length;
      const afternoon = getSlotItems(text, "下午").length;
      // 每时段条数只可能是 1 或 2
      expect(morning === 1 || morning === 2).toBe(true);
      expect(afternoon === 1 || afternoon === 2).toBe(true);
      if (morning === 2) morningTwo += 1;
      if (afternoon === 2) afternoonTwo += 1;
    }
    // singleOdds=4 → 期望 75% 的日子是 2 条；留哈希抖动余量断言 ≥60%
    expect(morningTwo / totalDays).toBeGreaterThanOrEqual(0.6);
    expect(afternoonTwo / totalDays).toBeGreaterThanOrEqual(0.6);
  });

  it("important-dates 命中 MM-DD 与 YYYY-MM-DD，未命中不注入", () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "important-dates.json"),
      JSON.stringify([
        { date: "07-27", label: "认识纪念日" },
        { date: "2026-07-27", label: "出发去深圳前一个月" },
        { date: "08-15", label: "不该出现的条目" },
      ]),
      "utf8",
    );
    const hit = buildLifeContext(new Date(2026, 6, 27, 12, 0), dir);
    expect(hit).toContain("今天对你们来说是特别的日子：认识纪念日；出发去深圳前一个月。");
    expect(hit).not.toContain("不该出现的条目");

    const miss = buildLifeContext(new Date(2026, 6, 28, 12, 0), dir);
    expect(miss).not.toContain("特别的日子");
  });

  it("important-dates.json 缺失或损坏时静默跳过，不影响日程主体", () => {
    const missingDir = makeTempDir();
    expect(buildLifeContext(new Date(2026, 6, 27, 12, 0), missingDir)).toContain("[你的生活]");

    const brokenDir = makeTempDir();
    fs.writeFileSync(path.join(brokenDir, "important-dates.json"), "{ not valid json", "utf8");
    const text = buildLifeContext(new Date(2026, 6, 27, 12, 0), brokenDir);
    expect(text).toContain("[你的生活]");
    expect(text).not.toContain("特别的日子");
  });

  it("localDateKey 使用本地日期并补零", () => {
    expect(localDateKey(new Date(2026, 0, 5, 3, 0))).toBe("2026-01-05");
  });
});
