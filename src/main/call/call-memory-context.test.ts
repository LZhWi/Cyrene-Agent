import { expect, it } from "vitest";
import { callMemoryContext } from "./call-memory-context";

it("only includes new visible calls before the frozen user message", () => {
  const messages: any[] = [{ id: "old", role: "model", content: "old", at: 1000 }, { id: "u", role: "user", content: "now", at: 3000 }];
  const events = [{ id: "stale", startedAt: 10, endedAt: 100, summary: "old call" },
    { id: "new", startedAt: 1500, endedAt: 2000, summary: "new call" },
    { id: "future", startedAt: 4000, endedAt: 5000, summary: "future call" }];
  const text = callMemoryContext(messages, "u", events);
  expect(text).toContain("new call"); expect(text).not.toContain("old call"); expect(text).not.toContain("future call");
  expect(callMemoryContext([...messages, { id: "next", role: "user", content: "next", at: 6000 }], "next", events.slice(0, 2))).toBe("");
});
