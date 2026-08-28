import { describe, expect, it, vi } from "vitest";
import { DesktopNeutralRecoveryController } from "./desktop-neutral-recovery";

function createModel(values: number[]) {
  let afterMotionUpdate: (() => void) | null = null;
  let motionStart: ((group: string, index: number) => void) | null = null;
  const coreModel = {
    getParameterCount: () => values.length,
    getParameterValueByIndex: (index: number) => values[index],
    setParameterValueByIndex: (index: number, value: number) => { values[index] = value; },
  };
  const motionManager = {
    on: vi.fn((_event: string, listener: (group: string, index: number) => void) => { motionStart = listener; }),
    off: vi.fn(),
  };
  const internalModel = {
    coreModel,
    motionManager,
    on: vi.fn((_event: string, listener: () => void) => { afterMotionUpdate = listener; }),
    off: vi.fn(),
  };
  return {
    model: { internalModel } as never,
    emitAfterMotionUpdate: () => afterMotionUpdate?.(),
    emitMotionStart: (group: string, index: number) => motionStart?.(group, index),
    internalModel,
    motionManager,
  };
}

describe("DesktopNeutralRecoveryController", () => {
  it("smoothly restores every parameter over eight hundred milliseconds", () => {
    const values = [1, 0, 0.25];
    const { model, emitAfterMotionUpdate } = createModel(values);
    const now = vi.spyOn(performance, "now").mockReturnValue(100);
    const controller = new DesktopNeutralRecoveryController(model, 800);

    values.splice(0, values.length, 0.4, 1, 0.75);
    controller.start();

    now.mockReturnValue(500);
    emitAfterMotionUpdate();
    expect(values).toEqual([0.7, 0.5, 0.5]);

    now.mockReturnValue(900);
    emitAfterMotionUpdate();
    expect(values).toEqual([1, 0, 0.25]);

    values[0] = 0.2;
    emitAfterMotionUpdate();
    expect(values[0]).toBe(0.2);
    controller.dispose();
    now.mockRestore();
  });

  it("keeps recovering for the neutral motion but cancels for a new action", () => {
    const values = [1];
    const { model, emitAfterMotionUpdate, emitMotionStart } = createModel(values);
    const now = vi.spyOn(performance, "now").mockReturnValue(100);
    const controller = new DesktopNeutralRecoveryController(model, 800);

    values[0] = 0;
    controller.start();
    emitMotionStart("动作#6", 0);
    now.mockReturnValue(500);
    emitAfterMotionUpdate();
    expect(values[0]).toBe(0.5);

    emitMotionStart("动作#6", 1);
    values[0] = 0.2;
    emitAfterMotionUpdate();
    expect(values[0]).toBe(0.2);
    controller.dispose();
    now.mockRestore();
  });

  it("detaches both model listeners when disposed", () => {
    const { model, internalModel, motionManager } = createModel([1]);
    const controller = new DesktopNeutralRecoveryController(model);

    controller.dispose();

    expect(internalModel.off).toHaveBeenCalledWith("afterMotionUpdate", expect.any(Function));
    expect(motionManager.off).toHaveBeenCalledWith("motionStart", expect.any(Function));
  });
});
