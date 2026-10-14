// @vitest-environment jsdom
import React, { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useSlashSkills } from "./useSlashSkills";

afterEach(() => { document.body.innerHTML = ""; vi.unstubAllGlobals(); });

it("completes without sending, respects IME/Shift, Escape and Chat isolation", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => { cb(); return 1; });
  const getSkillSuggestions = vi.fn(async () => ["alpha", "beta"].map(id => ({ id, name: id, description: "test", source: "user" as const })));
  vi.stubGlobal("settings", { getSkillSuggestions });
  let latest!: ReturnType<typeof useSlashSkills>;
  let update!: (value: string) => void;
  const submit = vi.fn();
  function Probe({ mode }: { mode: string }) {
    const [value, setValue] = useState("/"); update = setValue;
    latest = useSlashSkills(mode, value, setValue);
    return createElement("div", { ref: latest.host, onKeyDownCapture: latest.onKeyDownCapture },
      latest.menu, createElement("textarea", { value, onChange: () => {}, onKeyDown: submit }));
  }
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  const key = async (key: string, options: KeyboardEventInit = {}) => {
    await act(async () => host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options })));
  };
  try {
    await act(async () => root.render(createElement(Probe, { mode: "work" })));
    await act(async () => { host.querySelector("textarea")!.setSelectionRange(1, 1); latest.trackCursor(); });
    expect(getSkillSuggestions).toHaveBeenCalledWith("work");
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(2);
    await key("ArrowDown");
    expect(host.querySelector('[aria-selected="true"]')?.textContent).toContain("beta");
    await key("Enter", { isComposing: true });
    expect(host.querySelector("textarea")!.value).toBe("/");
    await key("Enter", { shiftKey: true });
    expect(host.querySelector("textarea")!.value).toBe("/");
    submit.mockClear();
    await key("Tab");
    expect(host.querySelector("textarea")!.value).toBe("/beta ");
    expect(submit).not.toHaveBeenCalled();
    await act(async () => update("/"));
    await act(async () => { host.querySelector("textarea")!.setSelectionRange(1, 1); latest.trackCursor(); });
    await key("Escape");
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    getSkillSuggestions.mockClear();
    await act(async () => root.render(createElement(Probe, { mode: "chat" })));
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(getSkillSuggestions).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});
