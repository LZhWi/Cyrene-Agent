import { describe, expect, it, vi } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createLifeContext } from "../plugins/companion-chat/src/life-context";

const time = (hour: number, minute = 0) => new Date(2026, 8, 28, hour, minute).getTime();

function fixture() {
  let clock = time(9), saved: unknown;
  const storage: PluginStorage = {
    get: <T>(key: string) => key === "life-state" ? structuredClone(saved) as T : undefined,
    set: (_key, value) => { saved = structuredClone(value); },
    rootDir: () => "memory-only",
  };
  const life = createLifeContext(storage, () => clock, { generate: vi.fn() });
  life.configurePlanning(true);
  const offer = (runId: string) => {
    const prompt = life.build("我在想今天做什么", { conversationRunId: runId });
    const match = /planToken=(\d+)；可修改的未来窗口=(\[[^\n]+\])/.exec(prompt);
    if (!match) throw new Error("没有可修改的未来窗口");
    return { planToken: Number(match[1]), windows: JSON.parse(match[2]) as Array<{ id: string; startAt: number; endAt: number }> };
  };
  const proposal = (runId: string, activity: string) => {
    const current = offer(runId), window = current.windows[0];
    return JSON.stringify({ action: "revise", planToken: current.planToken,
      window: { id: window.id, startAt: window.startAt, endAt: window.endAt,
        segments: [{ activity, minutes: (window.endAt - window.startAt) / 60_000 }] } });
  };
  return { life, offer, proposal, setTime: (hour: number, minute = 0) => { clock = time(hour, minute); }, state: () => structuredClone(saved) };
}

describe("对话中调整未来生活", () => {
  it("成功落盘的一轮只能修改未来窗口一次，冷却后仍可再次修改", () => {
    const f = fixture();
    const first = f.proposal("run-1", "读书：《星灯游记》");
    expect(f.life.applyConversationUpdate("run-1", first)).toBe(true);
    expect(f.life.applyConversationUpdate("run-1", first)).toBe(false);
    expect(f.life.view().planning.conversationPlans).toHaveLength(1);
    expect(f.life.build("下一段做什么")).toContain("读书：《星灯游记》");
    expect(f.life.build("想改计划", { conversationRunId: "run-too-soon" })).not.toContain("cyrene-life-update");
    f.setTime(9, 16);
    const second = f.proposal("run-2", "沿河边小路散步");
    expect(f.life.applyConversationUpdate("run-2", second)).toBe(true);
    expect(f.life.view().planning.conversationPlans).toHaveLength(2);
    expect(f.life.view().planning.conversationPlans[1].activities).toEqual(["沿河边小路散步"]);
    f.setTime(9, 20);
    expect(f.life.status()?.text).toContain("读书：《星灯游记》");
    f.setTime(9, 50);
    expect(f.life.status()?.text).toContain("沿河边小路散步");
    expect(f.life.view().planning.conversationPlans).toHaveLength(1);
    expect(createLifeContext({ get: <T>() => f.state() as T, set: () => {}, rootDir: () => "memory-only" }, () => time(9, 50),
      { generate: vi.fn() }).view().planning.conversationPlans).toHaveLength(1);
  });

  it("旧版本、过期窗口、外部动作与不合规时长都不写入", () => {
    const f = fixture();
    const valid = f.proposal("stale", "读书：《星灯游记》");
    expect(f.life.applyConversationUpdate("stale", valid.replace('"planToken":0', '"planToken":9'))).toBe(false);
    const badAction = f.proposal("external", "发送消息给用户");
    expect(f.life.applyConversationUpdate("external", badAction)).toBe(false);
    const badDuration = JSON.parse(f.proposal("duration", "散步"));
    badDuration.window.segments[0].minutes -= 15;
    expect(f.life.applyConversationUpdate("duration", JSON.stringify(badDuration))).toBe(false);
    const tooLate = f.proposal("late", "散步");
    f.setTime(9, 16);
    expect(f.life.applyConversationUpdate("late", tooLate)).toBe(false);
    expect(f.life.view().planning.conversationPlans).toHaveLength(0);
  });

  it("多次对话调整不受每日次数限制，损坏的持久化计划拒绝加载", () => {
    const f = fixture();
    for (const [index, minute] of [0, 16, 32, 48, 64, 80].entries()) {
      f.setTime(9 + Math.floor(minute / 60), minute % 60);
      expect(f.life.applyConversationUpdate(`run-${index}`, f.proposal(`run-${index}`, `沿河散步第${index + 1}段`))).toBe(true);
      expect(f.life.view().planning.conversationPlans.length).toBeLessThanOrEqual(2);
    }
    const corrupt: any = f.state();
    corrupt.planning.conversationPlans.at(-1).durations[0] -= 15;
    expect(() => createLifeContext({ get: <T>() => structuredClone(corrupt) as T, set: () => {}, rootDir: () => "memory-only" },
      () => time(10, 20), { generate: vi.fn() })).toThrow("生活规划状态损坏");
  });

  it("关闭自动规划时不向 Soul 提供修改协议", () => {
    const f = fixture();
    f.life.configurePlanning(false);
    expect(f.life.build("你好", { conversationRunId: "off" })).not.toContain("cyrene-life-update");
    expect(f.life.applyConversationUpdate("off", JSON.stringify({ action: "revise" }))).toBe(false);
  });
});
