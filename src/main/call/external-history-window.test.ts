import { describe, it, expect } from "vitest";
import { mergeCompanionHistory } from "./external-history-window";
describe("shared external history window", () => {
  it("counts call and Minecraft events against the same 16 slots without adding roles", () => {
    const messages = Array.from({length: 18}, (_, i) => ({role: "user" as const, content: String(i), at: i * 10}));
    const events = [{kind: "call" as const, content: "old", startedAt: -1},
      {kind: "call" as const, content: "call", startedAt: 155},
      {kind: "minecraft" as const, content: "mc", startedAt: 165}];
    const result = mergeCompanionHistory(messages, events);
    expect(result.messages.map(m => m.content)).toEqual(messages.slice(4).map(m => m.content));
    expect(result.events.map(e => e.content)).toEqual(["call", "mc"]);
    expect(result.messages).toHaveLength(14);
    expect(messages).toHaveLength(18);
  });
  it("matches local tie ordering and keeps undated messages last", () => {
    const messages = Array.from({length: 16}, (_, i) => ({role: "user" as const, content: String(i), at: i ? 1 : undefined}));
    const result = mergeCompanionHistory(messages, [{kind: "call", content: "call", startedAt: 1}]);
    expect(result.messages[0].content).toBe("2");
    expect(result.messages.at(-1)?.content).toBe("0");
    expect(result.events).toHaveLength(1);
  });
});
