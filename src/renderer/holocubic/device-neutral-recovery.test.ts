import { describe, expect, it, vi } from "vitest";
import { DeviceNeutralRecoveryController } from "./device-neutral-recovery";

function createModel(values: number[]) {
  let afterMotionUpdate: (() => void) | null = null;
  const coreModel = {
    getParameterCount: () => values.length,
    getParameterValueByIndex: (index: number) => values[index],
    setParameterValueByIndex: (index: number, value: number) => { values[index] = value; },
  };
  const internalModel = {
    coreModel,
    on: vi.fn((_event: string, listener: () => void) => { afterMotionUpdate = listener; }),
    off: vi.fn(),
  };
  return {
    model: { internalModel } as never,
    emitAfterMotionUpdate: () => afterMotionUpdate?.(),
    internalModel,
  };
}

describe("DeviceNeutralRecoveryController", () => {
  it("smoothly restores and commits every parameter to its startup value", () => {
    const values = [1, 0, 0.25];
    const { model, emitAfterMotionUpdate } = createModel(values);
    const now = vi.spyOn(performance, "now").mockReturnValue(100);
    const controller = new DeviceNeutralRecoveryController(model, 1_000);

    values.splice(0, values.length, 0.4, 1, 0.75);
    controller.start();

    now.mockReturnValue(600);
    emitAfterMotionUpdate();
    expect(values).toEqual([0.7, 0.5, 0.5]);

    now.mockReturnValue(1_100);
    emitAfterMotionUpdate();
    expect(values).toEqual([1, 0, 0.25]);

    values[0] = 0.2;
    emitAfterMotionUpdate();
    expect(values[0]).toBe(0.2);
    controller.dispose();
    now.mockRestore();
  });

  it("detaches from the device model when disposed", () => {
    const { model, internalModel } = createModel([1]);
    const controller = new DeviceNeutralRecoveryController(model);

    controller.dispose();

    expect(internalModel.off).toHaveBeenCalledWith("afterMotionUpdate", expect.any(Function));
  });
});
