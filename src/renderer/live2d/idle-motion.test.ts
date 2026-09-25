import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdleMotionController } from "./idle-motion";

function fixture() {
  const state = { currentGroup: undefined as string | undefined, currentIndex: undefined as number | undefined };
  const motionManager = {
    definitions: { Tick3: [{}, {}, {}, {}], "动作#6": [{}] },
    motionGroups: { Tick3: [{ _motionData: { duration: 3 } }, {}, {}, { _motionData: { duration: 60 } }] },
    state,
    startMotion: vi.fn(async (group: string, index: number) => {
      state.currentGroup = group; state.currentIndex = index; return true;
    }),
    stopAllMotions: vi.fn(() => { state.currentGroup = undefined; state.currentIndex = undefined; }),
  };
  return { model: { internalModel: { motionManager } } as never, motionManager };
}

describe("桌宠待机动作", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("只有显式开启且键鼠空闲后才在首次至少六十秒播放", async () => {
    const { model, motionManager } = fixture();
    const controller = new IdleMotionController(model, { random: () => 0 });
    controller.setEnabled(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(motionManager.startMotion).not.toHaveBeenCalled();
    controller.setUserIdle(true);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(motionManager.startMotion).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(motionManager.startMotion).toHaveBeenCalledWith("Tick3", 0, 1);
  });

  it("身体点击只从前三个短动作中选择并使用普通优先级", async () => {
    const { model, motionManager } = fixture();
    const controller = new IdleMotionController(model, { random: () => 0.99 });
    await expect(controller.playRandomNow()).resolves.toBe(true);
    expect(motionManager.startMotion).toHaveBeenCalledWith("Tick3", 2, 2);
  });
});
