// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useFloatingCard } from "./floating-card";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

it("measures the fixed titlebar bottom on mount, drag and resize and cleans up", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let resize: () => void = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe = vi.fn();
    disconnect = disconnect;
  });
  document.body.innerHTML = '<header class="cy-workspace-titlebar"></header><div id="root"></div>';
  const titlebar = document.querySelector("header")!;
  let bottom = 100;
  vi.spyOn(titlebar, "getBoundingClientRect").mockImplementation(() => ({ bottom, top: 40, height: bottom - 40 }) as DOMRect);
  function Card() {
    const floating = useFloatingCard({ width: 260, top: 0 });
    return React.createElement("div", {
      id: "card", onMouseDown: floating.onHeaderMouseDown,
      style: { position: "fixed", left: floating.position.x, top: floating.position.y },
    });
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(React.createElement(Card)));
    const card = document.getElementById("card")!;
    expect(card.style.top).toBe("100px");
    await act(async () => {
      card.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientY: 100 }));
      window.dispatchEvent(new MouseEvent("mousemove", { clientY: -200 }));
    });
    expect(card.style.top).toBe("100px");
    bottom = 140;
    await act(async () => resize());
    expect(card.style.top).toBe("140px");
    bottom = 160;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(card.style.top).toBe("160px");
  } finally {
    await act(async () => root.unmount());
  }
  expect(disconnect).toHaveBeenCalledOnce();
});
