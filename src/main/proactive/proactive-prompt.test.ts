import { describe, expect, it } from "vitest";
import { buildProactiveMessages, parseProactiveDecision } from "./proactive-prompt";

const turn = (role: "user" | "model", index: number) => ({ role, content: `${role}-${index}`, at: index });

describe("proactive prompt", () => {
  it("labels and limits ordinary and proactive histories independently", () => {
    const messages = buildProactiveMessages({
      basePersona: "PERSONA",
      userProfile: "PROFILE",
      relevantMemory: "MEMORY",
      ordinaryHistory: Array.from({ length: 20 }, (_, index) => turn(index % 2 ? "model" : "user", index)),
      proactiveHistory: Array.from({ length: 18 }, (_, index) => ({
        role: index % 2 ? "model" as const : "user" as const,
        content: `proactive-${index}`,
        at: index,
      })),
      sceneId: "work_break",
      localNow: new Date(2026, 6, 13, 14, 0),
      idleSec: 0,
      unansweredCount: 0,
    });

    const system = String(messages[0].content);
    expect(system).toContain("PERSONA");
    expect(system).toContain("[最近使用的普通聊天会话]");
    expect(system).toContain("[主动聊天专用会话]");
    expect(system).toContain("user-4");
    expect(system).not.toContain("user-2");
    expect(system).toContain("proactive-2"); // proactive history independently retains its own last 16
    expect(system).toContain("不要把历史聊天中的最后一句当作用户刚刚发来的消息");
  });

  it("adds night system only during an active local night", () => {
    const night = buildProactiveMessages({
      basePersona: "P",
      ordinaryHistory: [],
      proactiveHistory: [],
      sceneId: "late_night",
      localNow: new Date(2026, 6, 13, 23, 0),
      idleSec: 20,
      unansweredCount: 0,
    });
    const day = buildProactiveMessages({
      basePersona: "P",
      ordinaryHistory: [],
      proactiveHistory: [],
      sceneId: "work_break",
      localNow: new Date(2026, 6, 13, 14, 0),
      idleSec: 0,
      unansweredCount: 0,
    });

    expect(String(night[0].content)).toContain("[night_system]");
    expect(String(night[0].content)).toContain("不要透露你检测到了用户的键盘");
    expect(String(day[0].content)).not.toContain("[night_system]");
  });

  it("adds strict final-followup rules after one unanswered message", () => {
    const messages = buildProactiveMessages({
      basePersona: "P",
      ordinaryHistory: [],
      proactiveHistory: [],
      sceneId: "rainy_day",
      localNow: new Date(2026, 6, 13, 14, 0),
      idleSec: 0,
      unansweredCount: 1,
    });
    expect(String(messages[0].content)).toContain("[followup_system]");
    expect(String(messages[0].content)).toContain("最后一次主动机会");
    expect(String(messages[0].content)).toContain("不要机械地重复“在吗”");
  });

  it("asks for strict JSON without tool instructions", () => {
    const messages = buildProactiveMessages({
      basePersona: "P",
      ordinaryHistory: [],
      proactiveHistory: [],
      sceneId: "morning",
      localNow: new Date(2026, 6, 13, 9, 0),
      idleSec: 0,
      unansweredCount: 0,
    });
    const combined = messages.map((message) => String(message.content)).join("\n");
    expect(combined).toContain('{"decision":"silent","text":""}');
    expect(combined).not.toContain("工具目录");
    expect(combined).not.toContain("Tool Calling");
  });
});

describe("parseProactiveDecision", () => {
  it("parses send and silent decisions", () => {
    expect(parseProactiveDecision('{"decision":"send","text":"早点休息呀♪"}')).toEqual({
      kind: "send",
      text: "早点休息呀♪",
    });
    expect(parseProactiveDecision('{"decision":"silent","text":"ignored"}')).toEqual({ kind: "silent" });
  });

  it("rejects prose wrappers, empty send text, and oversized output", () => {
    expect(parseProactiveDecision('好的：{"decision":"silent","text":""}').kind).toBe("invalid");
    expect(parseProactiveDecision('{"decision":"send","text":"   "}').kind).toBe("invalid");
    expect(parseProactiveDecision(JSON.stringify({ decision: "send", text: "x".repeat(501) })).kind).toBe("invalid");
  });
});
