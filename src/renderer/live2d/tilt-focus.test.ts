import { describe, expect, it, vi } from "vitest";
import { TiltFocusController } from "./tilt-focus";

const canvas = {
  getBoundingClientRect: () => ({ width: 320, height: 240 }),
} as HTMLCanvasElement;

function key(key: "left" | "right" | "up" | "down" | "home", event: string) {
  return { version: 1 as const, type: "key" as const, key, event, at: 1 };
}

describe("TiltFocusController", () => {
  it("maps active tilt events to the four canvas edges", () => {
    const focus = vi.fn();
    const controller = new TiltFocusController(canvas, { focus } as never);

    controller.handleInput(key("left", "start"));
    controller.handleInput(key("right", "long_start"));
    controller.handleInput(key("up", "long_repeat"));
    controller.handleInput(key("down", "start"));

    expect(focus.mock.calls).toEqual([[0, 120], [320, 120], [160, 0], [160, 240]]);
  });

  it("returns to center when a tilt ends and ignores raw IMU samples", () => {
    const focus = vi.fn();
    const controller = new TiltFocusController(canvas, { focus } as never);

    controller.handleInput(key("left", "short"));
    controller.handleInput(key("up", "long_end"));
    controller.handleInput({ version: 1, type: "imu", roll: 1, pitch: 2, gx: 0, gy: 0, gz: 0, at: 2 });

    expect(focus.mock.calls).toEqual([[160, 120, false], [160, 120, false]]);
  });
});
