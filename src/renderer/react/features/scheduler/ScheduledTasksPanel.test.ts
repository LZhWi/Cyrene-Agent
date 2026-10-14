import { describe, expect, it, vi } from "vitest";
import { scheduleFromDraft } from "./ScheduledTasksPanel";

vi.mock("./ScheduledTasksPanel.css", () => ({}));

const draft = {
  title: "test", prompt: "test", mode: "work" as const, enabled: true, kind: "daily" as const,
  runAt: "", timeOfDay: "08:00", dayOfWeek: 1, every: 1,
  unit: "hours" as const, allowedToolIds: [], limitTools: false,
};

describe("scheduled task editor", () => {
  it("uses only schedule kinds supported by the current scheduler", () => {
    expect(scheduleFromDraft(draft)).toEqual({ kind: "daily", timeOfDay: "08:00" });
    expect(scheduleFromDraft({ ...draft, kind: "weekly", dayOfWeek: 3 })).toEqual({ kind: "weekly", dayOfWeek: 3, timeOfDay: "08:00" });
    expect(scheduleFromDraft({ ...draft, kind: "interval", every: 2 })).toEqual({ kind: "interval", every: 2, unit: "hours" });
  });
  it("rejects a past one-off task and invalid interval", () => {
    expect(() => scheduleFromDraft({ ...draft, kind: "once", runAt: "2000-01-01T00:00" })).toThrow();
    expect(() => scheduleFromDraft({ ...draft, kind: "interval", every: 0 })).toThrow();
  });
});
