import { describe, expect, it } from "vitest";
import { buildLifePlanningMessages, parseLifePlan, type LifePlanningInput } from "../plugins/companion-chat/src/life-planning";

const input: LifePlanningInput = { kind: "daily", date: "2026-09-26", revision: 7,
  windows: [{ id: "afternoon", startAt: 100, endAt: 200 }, { id: "evening", startAt: 200, endAt: 300 }],
  activities: ["读书", "学习", "休息片刻"],
  self: { energy: 24, focus: 70, restNeed: 76, activity: "学习", habits: { "读书": 60 } } };
const good = () => ({ kind: input.kind, date: input.date, revision: input.revision,
  windows: [{ id: "afternoon", activities: ["休息片刻"] }, { id: "evening", activities: ["读书", "学习"] }] });

describe("模型生活规划的封闭建议协议", () => {
  it("合法建议只选择活动，起止时间和来源版本来自请求", () => {
    const result = parseLifePlan(JSON.stringify(good()), input);
    expect(result).toEqual({ kind: "daily", date: input.date, sourceRevision: 7,
      windows: [{ ...input.windows[0], activities: ["休息片刻"] }, { ...input.windows[1], activities: ["读书", "学习"] }] });
    expect(parseLifePlan("```json\n" + JSON.stringify(good()) + "\n```", input)).toEqual(result);
  });

  it.each([
    ["不完整 JSON", () => '{"kind":"daily"'],
    ["旧版本", () => JSON.stringify({ ...good(), revision: 6 })],
    ["错误日期", () => JSON.stringify({ ...good(), date: "2026-09-25" })],
    ["错误类型", () => JSON.stringify({ ...good(), kind: "refine" })],
    ["额外工具请求", () => JSON.stringify({ ...good(), tool: "open_browser" })],
    ["额外说明", () => JSON.stringify({ ...good(), story: "我已经替用户完成工作" })],
    ["改变时间", () => { const p: any = good(); p.windows[0].startAt = 0; return JSON.stringify(p); }],
    ["未知活动", () => { const p = good(); p.windows[0].activities = ["去用户家里做饭"]; return JSON.stringify(p); }],
    ["重复活动", () => { const p = good(); p.windows[0].activities = ["读书", "读书"]; return JSON.stringify(p); }],
    ["重复窗口", () => { const p = good(); p.windows[1].id = p.windows[0].id; return JSON.stringify(p); }],
    ["遗漏窗口", () => { const p = good(); p.windows.pop(); return JSON.stringify(p); }],
    ["打乱窗口", () => { const p = good(); p.windows.reverse(); return JSON.stringify(p); }],
  ])("拒绝%s", (_name, raw) => {
    expect(() => parseLifePlan(raw(), input)).toThrow("继续使用本地日程");
  });

  it("近段精化只允许一个窗口中的一个活动", () => {
    const refine: LifePlanningInput = { ...input, kind: "refine", windows: input.windows.slice(0, 1) };
    const proposal = { ...good(), kind: "refine", windows: good().windows.slice(0, 1) };
    expect(parseLifePlan(JSON.stringify(proposal), refine).windows).toHaveLength(1);
    proposal.windows[0].activities = ["学习", "读书"];
    expect(() => parseLifePlan(JSON.stringify(proposal), refine)).toThrow();
  });

  it("模型输入只含角色状态、有限习惯和目标，不要求访问用户数据", () => {
    const messages = buildLifePlanningMessages({ ...input, goals: [{ id: "g1", title: "继续读一本自己的书", activity: "读书" }] });
    expect(messages[0].content).toContain("不代表已发生");
    expect(messages[0].content).toContain("休息不会阻止");
    const data = JSON.parse(messages[1].content);
    expect(data.self.energy).toBe(24);
    expect(data.goals[0].id).toBe("g1");
    expect(data).not.toHaveProperty("messages");
  });
});
