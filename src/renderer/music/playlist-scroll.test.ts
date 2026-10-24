import { describe, expect, it } from "vitest";
import { wheelToHorizontalScroll } from "./playlist-scroll";

const strip = (scrollLeft: number, scrollWidth = 1200, clientWidth = 600) => ({ scrollLeft, scrollWidth, clientWidth });

describe("wheelToHorizontalScroll", () => {
  it("converts vertical scrolling in both directions", () => {
    expect(wheelToHorizontalScroll(strip(0), 0, 120)).toBe(120);
    expect(wheelToHorizontalScroll(strip(300), 0, -120)).toBe(180);
  });
  it("clamps movement to the scrollable range", () => {
    expect(wheelToHorizontalScroll(strip(550), 0, 200)).toBe(600);
    expect(wheelToHorizontalScroll(strip(50), 0, -200)).toBe(0);
  });
  it("does not handle movement past either end", () => {
    expect(wheelToHorizontalScroll(strip(600), 0, 120)).toBeNull();
    expect(wheelToHorizontalScroll(strip(0), 0, -120)).toBeNull();
  });
  it("does not handle a strip without overflow", () => {
    expect(wheelToHorizontalScroll(strip(0, 500, 600), 0, 120)).toBeNull();
  });
  it("leaves horizontal and equal-axis gestures to the browser", () => {
    expect(wheelToHorizontalScroll(strip(0), 80, 10)).toBeNull();
    expect(wheelToHorizontalScroll(strip(0), 80, 80)).toBeNull();
  });
});
