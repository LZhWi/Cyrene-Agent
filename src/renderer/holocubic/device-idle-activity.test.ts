import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceIdleActivityController } from "./device-idle-activity";

describe("DeviceIdleActivityController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts idle and returns to idle only after one continuous quiet period", async () => {
    const onIdleChanged = vi.fn();
    const controller = new DeviceIdleActivityController(onIdleChanged, 1_000);

    controller.start();
    expect(onIdleChanged).toHaveBeenLastCalledWith(true);

    controller.recordInput();
    expect(onIdleChanged).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(750);
    controller.recordInput();
    await vi.advanceTimersByTimeAsync(999);
    expect(onIdleChanged).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(onIdleChanged).toHaveBeenLastCalledWith(true);
  });

  it("does not emit or change state after disposal", async () => {
    const onIdleChanged = vi.fn();
    const controller = new DeviceIdleActivityController(onIdleChanged, 1_000);
    controller.start();
    controller.recordInput();
    controller.dispose();

    await vi.advanceTimersByTimeAsync(2_000);
    controller.recordInput();
    expect(onIdleChanged.mock.calls).toEqual([[true], [false]]);
  });
});
