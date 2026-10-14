import { describe, expect, it } from "vitest";
import { clampFloatingCardPosition } from "./floating-card";

describe("floating card positioning", () => {
  it("uses the same viewport bounds for Work and Code cards", () => {
    expect(clampFloatingCardPosition({ x: 900, y: -10 }, { width: 240, minVisibleHeight: 48 }, {
      width: 1024,
      height: 768,
    })).toEqual({ x: 784, y: 0 });
  });
  it("keeps cards below the titlebar", () => {
    expect(clampFloatingCardPosition({ x: 40, y: -10 }, { width: 240, minVisibleHeight: 48, minTop: 92 }, {
      width: 1024, height: 768,
    })).toEqual({ x: 40, y: 92 });
  });
  it("bounds the titlebar inset in a tiny viewport", () => {
    expect(clampFloatingCardPosition({ x: 40, y: 100 }, { width: 240, minVisibleHeight: 48, minTop: 92 }, {
      width: 200, height: 60,
    })).toEqual({ x: 0, y: 12 });
  });
});
