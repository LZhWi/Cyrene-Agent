import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setPosition: vi.fn(),
  pressButton: vi.fn(),
  releaseButton: vi.fn(),
}));

vi.mock("@nut-tree-fork/nut-js", () => ({
  mouse: {
    setPosition: mocks.setPosition,
    pressButton: mocks.pressButton,
    releaseButton: mocks.releaseButton,
  },
  Point: class Point {
    constructor(public x: number, public y: number) {}
  },
  Button: { LEFT: 0 },
  keyboard: { pressKey: vi.fn(), releaseKey: vi.fn() },
  Key: {},
}));

import { click } from "./input";

describe("gamebot mouse input", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setPosition.mockResolvedValue(undefined);
    mocks.pressButton.mockResolvedValue(undefined);
    mocks.releaseButton.mockResolvedValue(undefined);
  });

  it("移动后明确按下并释放左键", async () => {
    await click(320, 240);
    expect(mocks.setPosition).toHaveBeenCalledWith(expect.objectContaining({ x: 320, y: 240 }));
    expect(mocks.pressButton).toHaveBeenCalledWith(0);
    expect(mocks.releaseButton).toHaveBeenCalledWith(0);
    expect(mocks.pressButton.mock.invocationCallOrder[0]).toBeLessThan(mocks.releaseButton.mock.invocationCallOrder[0]);
  });

  it("释放失败会向上报告", async () => {
    mocks.releaseButton.mockRejectedValue(new Error("release failed"));
    await expect(click(1, 2)).rejects.toThrow("release failed");
    expect(mocks.releaseButton).toHaveBeenCalledWith(0);
  });
});
