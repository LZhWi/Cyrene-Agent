import { describe, expect, it, vi } from "vitest";
import { ModelRuntimeCoordinator, modelRuntimeClassForAgentDescription } from "./model-runtime-coordinator";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("ModelRuntimeCoordinator", () => {
  it("classifies desktop, channel and scheduler agent entries", () => {
    expect(modelRuntimeClassForAgentDescription("Cyrene 主聊天")).toBe("interactive");
    expect(modelRuntimeClassForAgentDescription("bot:feishu:user")).toBe("channel");
    expect(modelRuntimeClassForAgentDescription("mobile-proactive:session")).toBe("channel");
    expect(modelRuntimeClassForAgentDescription("Scheduled task: morning")).toBe("scheduler");
  });

  it("reserves capacity so a background task cannot block an interactive task", async () => {
    const coordinator = new ModelRuntimeCoordinator(2, 1);
    const backgroundOne = deferred();
    const backgroundTwo = deferred();
    const events: string[] = [];

    const first = coordinator.run("vision-background", async () => {
      events.push("background-1:start");
      await backgroundOne.promise;
    });
    const second = coordinator.run("scheduler", async () => {
      events.push("background-2:start");
      await backgroundTwo.promise;
    });
    await vi.waitFor(() => expect(events).toEqual(["background-1:start"]));

    const foreground = coordinator.run("interactive", async () => { events.push("interactive:start"); });
    await foreground;
    expect(events).toEqual(["background-1:start", "interactive:start"]);

    backgroundOne.resolve();
    await first;
    await vi.waitFor(() => expect(events).toContain("background-2:start"));
    backgroundTwo.resolve();
    await second;
  });

  it("starts the highest-priority waiter first", async () => {
    const coordinator = new ModelRuntimeCoordinator(1, 1);
    const blocker = deferred();
    const events: string[] = [];
    const active = coordinator.run("interactive", async () => { await blocker.promise; });
    const background = coordinator.run("vision-background", async () => { events.push("background"); });
    const call = coordinator.run("call", async () => { events.push("call"); });

    blocker.resolve();
    await active;
    await call;
    await background;
    expect(events).toEqual(["call", "background"]);
  });

  it("removes a cancelled waiter without consuming capacity", async () => {
    const coordinator = new ModelRuntimeCoordinator(1, 1);
    const blocker = deferred();
    const active = coordinator.run("interactive", async () => { await blocker.promise; });
    const controller = new AbortController();
    const queued = coordinator.run("scheduler", async () => undefined, controller.signal);
    controller.abort();

    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    blocker.resolve();
    await active;
    await expect(coordinator.run("interactive", async () => "ok")).resolves.toBe("ok");
  });
});
