import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdleMotionController } from "./idle-motion";

function createModel() {
  const state = {
    currentGroup: undefined as string | undefined,
    currentIndex: undefined as number | undefined,
    reservedGroup: undefined as string | undefined,
    reservedIdleGroup: undefined as string | undefined,
  };
  const motionManager = {
    definitions: {
      Tick3: [
        { File: "motions/动作#6_1.motion3.json" },
        { File: "motions/动作#6_2.motion3.json" },
        { File: "motions/动作#6_3.motion3.json" },
        { File: "motions/Tick3_3.motion3.json" },
      ],
      "动作#6": [{ File: "motions/动作#6_0.motion3.json" }],
    },
    motionGroups: {
      Tick3: [
        { _motionData: { duration: 3 } },
        { _motionData: { duration: 4 } },
        { _motionData: { duration: 3 } },
        { _motionData: { duration: 60.333 } },
      ],
    },
    state,
    startMotion: vi.fn(async (group: string, index: number) => {
      state.currentGroup = group;
      state.currentIndex = index;
      return true;
    }),
    stopAllMotions: vi.fn(() => {
      state.currentGroup = undefined;
      state.currentIndex = undefined;
      state.reservedGroup = undefined;
      state.reservedIdleGroup = undefined;
    }),
  };
  return {
    model: { internalModel: { motionManager } } as never,
    motionManager,
  };
}

describe("IdleMotionController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits, plays one bounded random Tick3 motion, resets, then waits again", async () => {
    const { model, motionManager } = createModel();
    const onMotionEnd = vi.fn();
    const controller = new IdleMotionController(model, {
      minIntervalMs: 100,
      maxIntervalMs: 100,
      initialMinIntervalMs: 100,
      random: () => 0,
      onMotionEnd,
      resetMotionMs: 50,
    });

    controller.setUserIdle(true);
    controller.setEnabled(true);
    expect(motionManager.startMotion).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(motionManager.startMotion).toHaveBeenCalledWith("Tick3", 0, 1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(motionManager.stopAllMotions).toHaveBeenCalledOnce();
    expect(onMotionEnd).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(50);
    expect(motionManager.startMotion).toHaveBeenCalledWith("动作#6", 0, 2);
    expect(motionManager.stopAllMotions).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(50);
    expect(motionManager.startMotion).toHaveBeenLastCalledWith("Tick3", 0, 1);
  });

  it("caps the long swing motion at twenty seconds", async () => {
    const { model, motionManager } = createModel();
    const controller = new IdleMotionController(model, {
      minIntervalMs: 100,
      maxIntervalMs: 100,
      initialMinIntervalMs: 100,
      random: () => 0.99,
      resetMotionMs: 50,
    });

    controller.setUserIdle(true);
    controller.setEnabled(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(motionManager.startMotion).toHaveBeenCalledWith("Tick3", 3, 1);

    await vi.advanceTimersByTimeAsync(19_999);
    expect(motionManager.stopAllMotions).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(motionManager.stopAllMotions).toHaveBeenCalledOnce();
  });

  it("plays one random bounded motion from a body click even when idle scheduling is disabled", async () => {
    const { model, motionManager } = createModel();
    const controller = new IdleMotionController(model, {
      random: () => 0.4,
      resetMotionMs: 50,
    });

    await expect(controller.playRandomNow()).resolves.toBe(true);
    expect(motionManager.startMotion).toHaveBeenCalledWith("Tick3", 1, 2);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(motionManager.stopAllMotions).toHaveBeenCalledOnce();
    expect(motionManager.startMotion).toHaveBeenLastCalledWith("动作#6", 0, 2);
  });

  it("never selects the swing motion for body clicks", async () => {
    const { model, motionManager } = createModel();
    const controller = new IdleMotionController(model, { random: () => 0.99 });

    await controller.playRandomNow();

    expect(motionManager.startMotion).toHaveBeenCalledWith("Tick3", 2, 2);
  });

  it("interrupts an active neutral reset before a body-click motion", async () => {
    const { model, motionManager } = createModel();
    const controller = new IdleMotionController(model, { random: () => 0 });
    motionManager.state.currentGroup = "动作#6";
    motionManager.state.currentIndex = 0;

    await controller.playRandomNow();

    expect(motionManager.stopAllMotions).toHaveBeenCalledOnce();
    expect(motionManager.startMotion).toHaveBeenCalledWith("Tick3", 0, 2);
  });

  it("stops and resets its own motion when disabled", async () => {
    const { model, motionManager } = createModel();
    const onMotionEnd = vi.fn();
    const controller = new IdleMotionController(model, {
      minIntervalMs: 100,
      maxIntervalMs: 100,
      initialMinIntervalMs: 100,
      random: () => 0,
      onMotionEnd,
      resetMotionMs: 50,
    });
    controller.setUserIdle(true);
    controller.setEnabled(true);
    await vi.advanceTimersByTimeAsync(100);

    controller.setEnabled(false);

    expect(motionManager.stopAllMotions).toHaveBeenCalledOnce();
    expect(onMotionEnd).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(motionManager.startMotion).toHaveBeenCalledTimes(2);
  });

  it("restarts its wait on speech prepare without becoming permanently suspended", async () => {
    const { model, motionManager } = createModel();
    const controller = new IdleMotionController(model, {
      minIntervalMs: 100,
      maxIntervalMs: 100,
      initialMinIntervalMs: 100,
      random: () => 0,
    });
    controller.setUserIdle(true);
    controller.setEnabled(true);
    await vi.advanceTimersByTimeAsync(50);

    controller.restartWait();

    await vi.advanceTimersByTimeAsync(99);
    expect(motionManager.startMotion).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(motionManager.startMotion).toHaveBeenCalledOnce();
  });

  it("does not stop or reset an unrelated action that already took over", async () => {
    const { model, motionManager } = createModel();
    const onMotionEnd = vi.fn();
    const controller = new IdleMotionController(model, {
      minIntervalMs: 100,
      maxIntervalMs: 100,
      initialMinIntervalMs: 100,
      random: () => 0,
      onMotionEnd,
      resetMotionMs: 50,
    });
    controller.setUserIdle(true);
    controller.setEnabled(true);
    await vi.advanceTimersByTimeAsync(100);
    motionManager.state.currentGroup = "动作#6";

    controller.setEnabled(false);

    expect(motionManager.stopAllMotions).not.toHaveBeenCalled();
    expect(onMotionEnd).not.toHaveBeenCalled();
  });

  it("requires continuous keyboard-and-mouse inactivity before entering the wait", async () => {
    const { model, motionManager } = createModel();
    const controller = new IdleMotionController(model, {
      minIntervalMs: 100,
      maxIntervalMs: 100,
      initialMinIntervalMs: 100,
      random: () => 0,
    });
    controller.setEnabled(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(motionManager.startMotion).not.toHaveBeenCalled();

    controller.setUserIdle(true);
    await vi.advanceTimersByTimeAsync(50);
    controller.setUserIdle(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(motionManager.startMotion).not.toHaveBeenCalled();

    controller.setUserIdle(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(motionManager.startMotion).toHaveBeenCalledWith("Tick3", 0, 1);
  });

  it("lets the current idle motion finish after input resumes, then leaves idle mode", async () => {
    const { model, motionManager } = createModel();
    const controller = new IdleMotionController(model, {
      minIntervalMs: 100,
      maxIntervalMs: 100,
      initialMinIntervalMs: 100,
      random: () => 0,
      resetMotionMs: 50,
    });
    controller.setUserIdle(true);
    controller.setEnabled(true);
    await vi.advanceTimersByTimeAsync(100);

    controller.setUserIdle(false);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(motionManager.stopAllMotions).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(motionManager.stopAllMotions).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(motionManager.startMotion).toHaveBeenCalledTimes(2);
  });

  it("waits at least sixty seconds for the first motion but keeps later intervals unchanged", async () => {
    const { model, motionManager } = createModel();
    const controller = new IdleMotionController(model, {
      minIntervalMs: 30_000,
      maxIntervalMs: 120_000,
      random: () => 0,
      resetMotionMs: 50,
    });
    controller.setUserIdle(true);
    controller.setEnabled(true);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(motionManager.startMotion).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(motionManager.startMotion).toHaveBeenCalledWith("Tick3", 0, 1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(motionManager.startMotion).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(motionManager.startMotion).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(motionManager.startMotion).toHaveBeenLastCalledWith("Tick3", 0, 1);
  });

  it("uses the linear screen no-change interval and caps n at five", async () => {
    const { model, motionManager } = createModel();
    const controller = new IdleMotionController(model, { random: () => 0 });
    controller.setScreenNoChangeCount(10);
    controller.setUserIdle(true);
    controller.setEnabled(true);

    await vi.advanceTimersByTimeAsync(119_999);
    expect(motionManager.startMotion).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(motionManager.startMotion).toHaveBeenCalledWith("Tick3", 0, 1);
  });

  it("falls back to the default interval when screen observation is unavailable", async () => {
    const { model, motionManager } = createModel();
    const controller = new IdleMotionController(model, { random: () => 0 });
    controller.setScreenNoChangeCount(null);
    controller.setUserIdle(true);
    controller.setEnabled(true);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(motionManager.startMotion).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(motionManager.startMotion).toHaveBeenCalledWith("Tick3", 0, 1);

    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(motionManager.startMotion).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(motionManager.startMotion).toHaveBeenCalledTimes(3);
  });
});
