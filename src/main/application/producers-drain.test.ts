import { describe, expect, it, vi } from "vitest";
import { TtsSessionService } from "../tts/tts-session-service";
import { SchedulerEngine } from "../scheduler/scheduler-engine";
import { createProactiveChatService } from "../proactive/proactive-service";
import { createDefaultProactiveState } from "../proactive/proactive-policy";
import type { ScheduledTask } from "../scheduler/types";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const request = { requestId: "r", conversationId: "c", messageId: "m", speechText: "test", converterVersion: "raw-v1" };
const signal = () => new AbortController().signal;

describe("producer shutdown", () => {
  it("reports a scheduler deadline without starting more work", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const task = { id: "t", enabled: true } as ScheduledTask;
    const engine = new SchedulerEngine({ store: { getTasks: () => [task], updateTask: () => task, recordHistory: () => {}, onChange: () => () => {} }, runTask: () => new Promise(() => {}) });
    void engine.fireNow("t");
    const deadline = new AbortController();
    deadline.abort();
    await engine.shutdown(deadline.signal);
    expect(warn).toHaveBeenCalledWith("[Shutdown] scheduler drain deadline reached");
    expect((await engine.fireNow("t")).ok).toBe(false);
    warn.mockRestore();
  });
  it("waits for initial TTS synthesis, cancels it and rejects new admission", async () => {
    const gate = deferred<any>();
    let synthesisSignal!: AbortSignal;
    const synthesize = vi.fn((_r, s: AbortSignal) => { synthesisSignal = s; return gate.promise; });
    const service = new TtsSessionService(synthesize);
    const start = service.start(request);
    let done = false;
    const drain = service.shutdown(signal()).then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    expect(synthesisSignal.aborted).toBe(true);
    await expect(service.start(request)).resolves.toMatchObject({ status: "cancelled" });
    expect(synthesize).toHaveBeenCalledTimes(1);
    gate.resolve({ requestId: "r", status: "cancelled" });
    await drain;
    await expect(start).resolves.toMatchObject({ status: "cancelled" });
  });

  it("waits for a cancelled streaming request even after replacement", async () => {
    const old = deferred<void>();
    const service = new TtsSessionService(async r => ({ result: { requestId: r.requestId, status: "streaming", cacheKey: "x", format: "mp3" }, completion: old.promise }));
    await service.start(request);
    service.cancel("r");
    await service.start(request);
    let done = false;
    const drain = service.shutdown(signal()).then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    old.resolve();
    await drain;
  });

  it("bounds TTS waiting and diagnoses unfinished work", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new TtsSessionService(() => new Promise(() => {}));
    void service.start(request);
    const controller = new AbortController();
    const drain = service.shutdown(controller.signal);
    controller.abort();
    await drain;
    expect(warn).toHaveBeenCalledWith("[Shutdown] tts drain deadline reached");
    warn.mockRestore();
  });

  it("waits for scheduled execution and closes manual and timer admission", async () => {
    vi.useFakeTimers();
    try {
      const task = { id: "t", enabled: true, nextFireAt: new Date(Date.now() + 100).toISOString(), schedule: { kind: "daily", timeOfDay: "08:00" } } as ScheduledTask;
      const gate = deferred<any>();
      const runTask = vi.fn(() => gate.promise);
      const engine = new SchedulerEngine({ store: { getTasks: () => [task], updateTask: () => task, recordHistory: () => {}, onChange: () => () => {} }, runTask });
      engine.start();
      const run = engine.fireNow("t");
      let done = false;
      const drain = engine.shutdown(signal()).then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(200);
      expect(done).toBe(false);
      expect((await engine.fireNow("t")).ok).toBe(false);
      engine.start(); engine.refreshPluginTasks();
      expect(vi.getTimerCount()).toBe(0);
      gate.resolve({});
      await Promise.all([run, drain]);
      expect(runTask).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it.each(["messages", "model", "commit"])("waits for proactive %s and prevents late generation/delivery", async stage => {
    const gate = deferred<any>();
    const state = createDefaultProactiveState();
    const runModel = vi.fn(() => stage === "model" ? gate.promise : Promise.resolve({ kind: "send" as const, text: "hi" }));
    const commitMessage = vi.fn(() => stage === "commit" ? gate.promise : Promise.resolve({ kind: "committed" as const }));
    const service = createProactiveChatService({ loadState: () => state, saveState: () => {},
      getSnapshot: () => ({ now: Date.UTC(2026, 6, 13, 6), localHour: 14, idleSec: 0, enabled: true, conversationBusy: false, generationBusy: false, screenLocked: false }),
      buildMessages: () => stage === "messages" ? gate.promise : Promise.resolve([]), runModel, commitMessage, getFallback: async () => null });
    const candidate = { sceneId: "work_break" as const, score: 90, sceneCooldownMs: 0 };
    const work = service.evaluateCandidate(candidate);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    let done = false;
    const drain = service.shutdown(signal()).then(() => { done = true; });
    await Promise.resolve(); expect(done).toBe(false);
    await service.evaluateCandidate(candidate);
    gate.resolve(stage === "messages" ? [] : stage === "model" ? { kind: "send", text: "late" } : { kind: "committed" });
    await Promise.all([work, drain]);
    expect(commitMessage).toHaveBeenCalledTimes(stage === "commit" ? 1 : 0);
    expect(runModel).toHaveBeenCalledTimes(stage === "messages" ? 0 : 1);
  });
});
