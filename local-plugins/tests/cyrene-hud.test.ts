import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { createCollector, parseNvidia } = require("../plugins/cyrene-hud/collector.cjs");
const { normalizeSettings, hudBounds, supportsMaterial } = require("../plugins/cyrene-hud/settings.cjs");
const { createGlass } = require("../plugins/cyrene-hud/glass.cjs");
const motion = require("../plugins/cyrene-hud/motion.cjs");

describe("HUD hover dwell", () => {
  async function hoverFixture(displayWidth = 1920, snapshotRead = vi.fn(async () => ({ capturedAt: Date.now() }))) {
    let point = { x: 0, y: 0 }, visible = false, bounds = { x: 0, y: 0, width: 0, height: 0 }, zoom = 1;
    const ignored = vi.fn(), topmost = vi.fn(), moveTop = vi.fn();
    let glassStatus: () => void, glassPower: (value: boolean) => void;
    const handlers: Record<string, (...args: any[]) => any> = {}, disposals: (() => void)[] = [];
    const saved: Record<string, any> = { settings: { mode: "hover", background: "solid", metric: "clock" } };
    const display = { size: { width: displayWidth, height: 1080 }, bounds: { x: 0, y: 0, width: displayWidth, height: 1080 }, workArea: { x: 0, y: 0, width: displayWidth, height: 1080 } };
    const reveal = vi.fn(() => { visible = true; });
    class Window extends EventEmitter {
      webContents = { send() {}, setWindowOpenHandler() {}, on() {}, setZoomFactor(value: number) { zoom = value; } };
      async loadFile() {} isDestroyed() { return false; } destroy() { visible = false; } showInactive = reveal;
      hide() { visible = false; } isVisible() { return visible; } getBounds() { return bounds; }
      setBounds(value: typeof bounds) { bounds = value; } setBackgroundMaterial() {} setBackgroundColor() {}
      getNativeWindowHandle() { return Buffer.alloc(8); } setOpacity() {} setIgnoreMouseEvents = ignored; setAlwaysOnTop = topmost; moveTop = moveTop;
    }
    const screen = Object.assign(new EventEmitter(), { getAllDisplays: () => [display], getPrimaryDisplay: () => display, getCursorScreenPoint: () => point });
    const module = { exports: {} as any };
    runInNewContext(readFileSync(new URL("../plugins/cyrene-hud/index.cjs", import.meta.url), "utf8"), {
      module, __dirname: "hud", Buffer, Date, setInterval, clearInterval, setTimeout, clearTimeout, process,
      require: (name: string) => name === "./notifications.cjs" ? require("../plugins/cyrene-hud/notifications.cjs") : name === "./motion.cjs" ? motion : name === "./edition.cjs" ? "local" : name === "electron" ? { BrowserWindow: Window, screen } : name === "./settings.cjs" ? { normalizeSettings, hudBounds, supportsMaterial } : name === "./collector.cjs" ? { createCollector: () => ({ dispose() {}, snapshot: snapshotRead }) } : name === "./glass.cjs" ? { createGlass: (status: () => void, _launch: unknown, _luminance: unknown, power: (value: boolean) => void) => { glassStatus = status; glassPower = power; return { status: "off", set() {}, sync() {}, dispose() {} }; } } : require(name),
    });
    await module.exports.register({ storage: { get: (key: string) => saved[key], set: (key: string, value: any) => { saved[key] = value; } }, signal: { throwIfAborted() {} }, registerIpc: (name: string, handler: any) => { handlers[name] = handler; }, onDispose: (fn: () => void) => { disposals.push(fn); } });
    return { handlers, saved, snapshotRead, reveal, ignored, topmost, moveTop, glassStatus: () => glassStatus(), glassPower: (value: boolean) => glassPower(value), zoom: () => zoom, bounds: () => handlers.state().layout.bounds || bounds, windowBounds: () => bounds, point: (value: typeof point) => { point = value; }, windowVisible: () => visible, hide: () => { visible = false; }, expanded: () => visible && handlers.state().expanded, enter: () => { point = { x: displayWidth / 2, y: 0 }; }, enterWindow: () => { const card = handlers.state().layout.bounds || bounds; point = { x: card.x + card.width / 2, y: card.y + card.height / 2 }; }, leave: () => { point = { x: 0, y: 0 }; }, dispose: () => disposals.forEach(fn => fn()) };
  }
  it("samples in the main process every five seconds while collapsed or hidden and every second while expanded", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = await hoverFixture();
    try {
      f.handlers.save({ ...f.handlers.state().config, metrics: ["memory"] });
      await vi.advanceTimersByTimeAsync(50); expect(f.snapshotRead).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4950); expect(f.snapshotRead).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(50); expect(f.snapshotRead).toHaveBeenCalledTimes(2);
      const cached = f.handlers.snapshot(); f.handlers.snapshot(); expect(f.handlers.snapshot()).toBe(cached); expect(f.snapshotRead).toHaveBeenCalledTimes(2);
      f.handlers.preview(); f.enter();
      await vi.advanceTimersByTimeAsync(50); expect(f.snapshotRead).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(2000); expect(f.snapshotRead).toHaveBeenCalledTimes(5);
      f.leave(); f.hide();
      await vi.advanceTimersByTimeAsync(1000); const hiddenCount = f.snapshotRead.mock.calls.length;
      await vi.advanceTimersByTimeAsync(4950); expect(f.snapshotRead).toHaveBeenCalledTimes(hiddenCount);
      await vi.advanceTimersByTimeAsync(50); expect(f.snapshotRead).toHaveBeenCalledTimes(hiddenCount + 1);
      f.dispose(); const finalCount = f.snapshotRead.mock.calls.length;
      await vi.advanceTimersByTimeAsync(6000); expect(f.snapshotRead).toHaveBeenCalledTimes(finalCount);
    } finally { f.dispose(); vi.useRealTimers(); }
  });
  it("skips hardware for clock-only and UI simulations without starting overlapping queries", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    let finish!: (value: any) => void;
    const sample = vi.fn(() => new Promise<any>(resolve => { finish = resolve; }));
    const f = await hoverFixture(1920, sample);
    try {
      await vi.advanceTimersByTimeAsync(6000); expect(sample).not.toHaveBeenCalled();
      f.handlers.save({ ...f.handlers.state().config, metrics: ["cpu"] });
      await vi.advanceTimersByTimeAsync(6000); expect(sample).toHaveBeenCalledTimes(1);
      finish({ cpuPercent: 70 }); await vi.advanceTimersByTimeAsync(50); expect(sample).toHaveBeenCalledTimes(2);
      f.handlers["ui-test"]("cpu"); finish({ cpuPercent: 80 });
      await vi.advanceTimersByTimeAsync(6000); expect(sample).toHaveBeenCalledTimes(2);
      expect(f.handlers.snapshot()).toMatchObject({ cpuPercent: 70 });
      f.handlers["ui-test"]("stop"); await vi.advanceTimersByTimeAsync(50); expect(sample).toHaveBeenCalledTimes(3);
      f.dispose(); finish({ cpuPercent: 90 }); await Promise.resolve(); expect(f.handlers.snapshot()).toMatchObject({ cpuPercent: 70 });
    } finally { f.dispose(); vi.useRealTimers(); }
  });
  it("reports collection failures and resumes periodic monitoring after a later success", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const sample = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue({ memoryPercent: 72 });
    const f = await hoverFixture(1920, sample);
    try {
      f.handlers.save({ ...f.handlers.state().config, metrics: ["memory"] });
      await vi.advanceTimersByTimeAsync(50); expect(() => f.handlers.snapshot()).toThrow("性能数据暂不可用");
      await vi.advanceTimersByTimeAsync(5000); expect(f.handlers.snapshot()).toMatchObject({ memoryPercent: 72 });
    } finally { f.dispose(); vi.useRealTimers(); }
  });
  it("simulates hover, leave and notifications without persisting test state or consuming real unread", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = await hoverFixture();
    try {
      f.handlers.save({ ...f.handlers.state().config, metrics: ["memory", "cpu"], mode: "persistent" });
      const saved = JSON.stringify(f.saved.settings);
      f.handlers["ui-test"]("cpu"); vi.advanceTimersByTime(2500);
      expect(f.handlers.state()).toMatchObject({ testing: true, expanded: true, layout: { active: "cpu" } });
      f.handlers["ui-test"]("avatar"); vi.advanceTimersByTime(1800);
      expect(f.handlers.state().layout.avatarProgress).toBe(1);
      f.handlers["ui-test"]("leave"); vi.advanceTimersByTime(5500);
      expect(f.handlers.state().layout.revealProgress).toBe(0);
      f.handlers["ui-test"]("notification"); vi.advanceTimersByTime(1500);
      expect(f.handlers.state().layout.noticeProgress).toBe(1);
      expect(f.handlers.state().notification.count).toBe(1);
      f.handlers["notification-batch"]({ sessionIds: ["p"], messages: [{ id: "real", sessionId: "p", at: Date.now(), preview: "真实消息" }] });
      expect(f.handlers["notification-target"]()).toBeNull();
      vi.advanceTimersByTime(3000);
      expect(f.handlers.state().layout.noticeProgress).toBe(0);
      f.handlers["ui-test"]("memory"); vi.advanceTimersByTime(2500);
      expect(f.handlers.state()).toMatchObject({ expanded: true, notification: { count: 1 }, layout: { active: "memory" } });
      f.handlers["ui-test"]("stop");
      expect(f.handlers.state()).toMatchObject({ testing: false, expanded: true, notification: { count: 1, preview: "真实消息" } });
      expect(JSON.stringify(f.saved.settings)).toBe(saved);
      expect(f.saved.notifications.unread).toHaveLength(1);
    } finally { f.dispose(); vi.useRealTimers(); }
  });
  it("finishes an automatic tour, expires individual tests and rejects unknown regions", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = await hoverFixture();
    try {
      expect(() => f.handlers["ui-test"]("invalid")).toThrow();
      f.handlers["ui-test"]("all"); vi.advanceTimersByTime(30000);
      expect(f.handlers.state().testing).toBe(false);
      expect(f.handlers.state().notification.count).toBe(0);
      f.handlers["ui-test"]("avatar"); vi.advanceTimersByTime(61000);
      expect(f.handlers.state().testing).toBe(false);
    } finally { f.dispose(); vi.useRealTimers(); }
  });
  it("shows a notification for two settled seconds and retains unread while normal HUD takes priority", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = await hoverFixture();
    try {
      f.handlers["notification-batch"]({ sessionIds: ["p"], messages: [{ id: "a", sessionId: "p", at: 10001, preview: "你好" }] });
      vi.advanceTimersByTime(1200);
      expect(f.handlers.state().layout.noticeProgress).toBe(1);
      expect(f.handlers.state().layout.width).toBe(216);
      expect(f.handlers.state().notification.count).toBe(1);
      vi.advanceTimersByTime(1000); expect(f.handlers.state().layout.noticeProgress).toBe(1);
      vi.advanceTimersByTime(2000); expect(f.handlers.state().layout.noticeProgress).toBe(0);
      expect(f.handlers.state().layout.width).toBe(48);
      f.handlers.preview(); f.enter(); vi.advanceTimersByTime(1500);
      f.handlers["notification-batch"]({ sessionIds: ["p"], messages: [{ id: "b", sessionId: "p", at: 15000, preview: "第二条" }] });
      expect(f.handlers.state().notification.count).toBe(2);
      expect(f.handlers.state().layout.noticeProgress).toBe(0);
      expect(f.handlers.state().expanded).toBe(true);
      f.handlers["notification-read"](f.handlers["notification-target"]());
      expect(f.handlers.state().notification.count).toBe(0);
    } finally { f.dispose(); vi.useRealTimers(); }
  });
  it("waits 0.35 seconds continuously, resets after leaving and does not repeatedly reveal", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = await hoverFixture();
    try {
      expect(f.windowVisible()).toBe(true); f.reveal.mockClear();
      f.enter(); vi.advanceTimersByTime(300); expect(f.expanded()).toBe(false);
      f.leave(); vi.advanceTimersByTime(50);
      f.enter(); vi.advanceTimersByTime(350); expect(f.expanded()).toBe(false);
      vi.advanceTimersByTime(50); expect(f.expanded()).toBe(true); expect(f.reveal).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(5000); expect(f.reveal).toHaveBeenCalledOnce(); expect(f.expanded()).toBe(true);
      f.leave(); vi.advanceTimersByTime(4300); expect(f.expanded()).toBe(false);
    } finally { f.dispose(); vi.useRealTimers(); }
  });
  it("raises on reveal and maintains topmost for both capsule and expanded HUD", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = await hoverFixture();
    try {
      f.topmost.mockClear(); f.moveTop.mockClear(); f.handlers.preview();
      expect(f.topmost).toHaveBeenLastCalledWith(true, "floating"); expect(f.moveTop).toHaveBeenCalledOnce();
      f.enterWindow(); f.moveTop.mockClear(); f.topmost.mockClear();
      vi.advanceTimersByTime(500); expect(f.moveTop).not.toHaveBeenCalled();
      vi.advanceTimersByTime(550); expect(f.moveTop).toHaveBeenCalledOnce(); expect(f.topmost).toHaveBeenCalledOnce();
      f.handlers.save({ ...f.handlers.state().config, mode: "hover" }); f.leave();
      f.moveTop.mockClear(); f.topmost.mockClear(); vi.advanceTimersByTime(2500);
      expect(f.moveTop).toHaveBeenCalledTimes(2); expect(f.topmost).toHaveBeenCalledTimes(2);
    } finally { f.dispose(); vi.useRealTimers(); }
  });
  it("morphs the resident capsule on a fixed canvas and reverses a live retraction", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = await hoverFixture();
    try {
      f.handlers.save({ ...f.handlers.state().config, displayDuration: .3 });
      const canvas = { ...f.windowBounds() };
      const capsuleTop = f.handlers.state().layout.bounds.y + 21 * f.zoom();
      expect(f.windowVisible()).toBe(true);
      expect(f.handlers.state().layout).toMatchObject({ width: 48, height: 10, revealProgress: 0, radius: 5 });
      f.enter(); vi.advanceTimersByTime(500);
      expect(f.expanded()).toBe(true);
      expect(f.handlers.state().layout.revealProgress).toBeGreaterThan(0);
      expect(f.handlers.state().layout.revealProgress).toBeLessThan(1);
      expect(f.handlers.state().layout.bounds.y + 21 * f.zoom()).toBe(capsuleTop);
      vi.advanceTimersByTime(1500);
      expect(f.handlers.state().layout).toMatchObject({ height: 60, revealProgress: 1 });
      expect(f.handlers.state().layout.bounds.y + 21 * f.zoom()).toBe(capsuleTop);
      f.leave(); vi.advanceTimersByTime(450);
      expect(f.expanded()).toBe(false);
      const before = f.handlers.state().layout.revealProgress;
      expect(before).toBeGreaterThan(0); expect(before).toBeLessThan(1);
      f.enter(); vi.advanceTimersByTime(50); expect(f.expanded()).toBe(true);
      vi.advanceTimersByTime(1500); expect(f.handlers.state().layout.revealProgress).toBe(1);
      f.leave(); vi.advanceTimersByTime(2000);
      expect(f.handlers.state().layout).toMatchObject({ width: 48, height: 10, revealProgress: 0 });
      expect(f.windowVisible()).toBe(true); expect(f.windowBounds()).toEqual(canvas);
      expect(f.ignored).toHaveBeenLastCalledWith(true, { forward: true });
      f.handlers["reduced-motion"](true); f.handlers.preview();
      expect(f.handlers.state().layout.revealProgress).toBe(1);
      vi.advanceTimersByTime(400); expect(f.handlers.state().layout.revealProgress).toBe(0);
    } finally { f.dispose(); vi.useRealTimers(); }
  });
  it("eases the shell slowly at both ends without rebound while keeping the top edge fixed", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = await hoverFixture();
    try {
      f.handlers.save({ ...f.handlers.state().config, displayDuration: .1 });
      f.enter(); f.handlers.preview();
      const opening: any[] = [];
      for (let i = 0; i < 90; i++) { vi.advanceTimersByTime(16); opening.push({ ...f.handlers.state().layout }); }
      const width = opening.at(-1).width;
      expect(Math.max(...opening.map(frame => frame.width))).toBe(width);
      for (let i = 1; i < opening.length; i++) expect(opening[i].width).toBeGreaterThanOrEqual(opening[i - 1].width);
      const early = opening[3].revealProgress - opening[0].revealProgress;
      const middle = opening[11].revealProgress - opening[8].revealProgress;
      const late = opening[19].revealProgress - opening[16].revealProgress;
      expect(middle).toBeGreaterThan(early * 4); expect(middle).toBeGreaterThan(late * 4);
      const settledAt = opening.findLastIndex(frame => frame.revealProgress !== 1) * .016;
      expect(settledAt).toBeGreaterThan(.25); expect(settledAt).toBeLessThan(.35);
      f.leave(); vi.advanceTimersByTime(150);
      const closing: any[] = [];
      for (let i = 0; i < 90; i++) { vi.advanceTimersByTime(16); closing.push({ ...f.handlers.state().layout }); }
      expect(Math.min(...closing.map(frame => frame.width))).toBe(48);
      for (let i = 1; i < closing.length; i++) expect(closing[i].width).toBeLessThanOrEqual(closing[i - 1].width);
      expect(closing.at(-1)).toMatchObject({ width: 48, height: 10, revealProgress: 0 });
      for (const frame of [...opening, ...closing]) { expect(frame.bounds.y).toBe(opening[0].bounds.y); expect(frame.width).toBeGreaterThanOrEqual(48); expect(frame.height).toBeGreaterThanOrEqual(10); }
    } finally { f.dispose(); vi.useRealTimers(); }
  });
  it("transitions directly from a notification into HUD without shrinking or overshooting", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = await hoverFixture();
    try {
      f.handlers.save({ ...f.handlers.state().config, metrics: ["memory", "cpu", "gpu"] });
      f.handlers["notification-batch"]({ sessionIds: ["p"], messages: [{ id: "a", sessionId: "p", at: 10001, preview: "你好" }] });
      vi.advanceTimersByTime(1200); expect(f.handlers.state().layout.width).toBe(216);
      f.enter(); f.handlers.preview();
      let previous = 216;
      for (let i = 0; i < 60; i++) {
        vi.advanceTimersByTime(16);
        const width = f.handlers.state().layout.width;
        expect(width).toBeGreaterThanOrEqual(previous); expect(width).toBeLessThanOrEqual(256);
        previous = width;
      }
      expect(previous).toBe(256);
    } finally { f.dispose(); vi.useRealTimers(); }
  });
  it("applies saved delays immediately, cancels pending dwell on save and keeps preview immediate", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = await hoverFixture();
    try {
      f.enter(); vi.advanceTimersByTime(250);
      f.handlers.save({ ...f.handlers.state().config, hoverDelay: 1 });
      expect(f.saved.settings.hoverDelay).toBe(1);
      vi.advanceTimersByTime(1000); expect(f.expanded()).toBe(false);
      vi.advanceTimersByTime(50); expect(f.expanded()).toBe(true);
      f.handlers.save({ ...f.handlers.state().config, hoverDelay: 0 });
      vi.advanceTimersByTime(50); expect(f.expanded()).toBe(true);
      f.handlers.save({ ...f.handlers.state().config, mode: "persistent", hoverDelay: 10 });
      expect(f.expanded()).toBe(true);
      f.handlers.save({ ...f.handlers.state().config, mode: "hover" }); f.leave();
      f.handlers.preview(); expect(f.expanded()).toBe(true);
      vi.advanceTimersByTime(4250); expect(f.expanded()).toBe(false);
      f.enter(); f.dispose(); vi.advanceTimersByTime(11000); expect(f.expanded()).toBe(false);
    } finally { f.dispose(); vi.useRealTimers(); }
  });
  it.each(["trigger", "trigger-and-window"])("migrates legacy %s timing to leaving both trigger and HUD", async hideTrigger => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = await hoverFixture();
    try {
      f.handlers.save({ ...f.handlers.state().config, displayDuration: .5, hideTrigger });
      f.enter(); vi.advanceTimersByTime(400); expect(f.expanded()).toBe(true);
      vi.advanceTimersByTime(1200); f.enterWindow(); vi.advanceTimersByTime(1000); expect(f.expanded()).toBe(true);
      f.leave(); vi.advanceTimersByTime(500); expect(f.expanded()).toBe(true);
      vi.advanceTimersByTime(300); expect(f.expanded()).toBe(false);
      expect(f.saved.settings.displayDuration).toBe(.5); expect(f.saved.settings).not.toHaveProperty("hideTrigger");
    } finally { f.dispose(); vi.useRealTimers(); }
  });
  it("resets countdown on returning to the selected area, including during spring retraction", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = await hoverFixture();
    try {
      f.handlers.save({ ...f.handlers.state().config, displayDuration: .5, hideTrigger: "trigger-and-window" });
      f.handlers.preview(); f.enter(); vi.advanceTimersByTime(1500); f.leave(); vi.advanceTimersByTime(300);
      f.enterWindow(); vi.advanceTimersByTime(1000); expect(f.expanded()).toBe(true);
      f.leave(); vi.advanceTimersByTime(550); expect(f.expanded()).toBe(false); expect(f.handlers.state().layout.revealProgress).toBeGreaterThan(0);
      f.enterWindow(); vi.advanceTimersByTime(1000); expect(f.expanded()).toBe(true);
      f.leave(); vi.advanceTimersByTime(300);
      f.enter(); vi.advanceTimersByTime(1000); expect(f.expanded()).toBe(true);
      f.leave(); vi.advanceTimersByTime(800); expect(f.expanded()).toBe(false);
    } finally { f.dispose(); vi.useRealTimers(); }
  });
  it("does not let the hidden window area trigger reveal and never expires in persistent mode", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = await hoverFixture();
    try {
      f.handlers.save({ ...f.handlers.state().config, displayDuration: .1, hideTrigger: "trigger-and-window" });
      f.point({ x: 960, y: 65 }); vi.advanceTimersByTime(1000); expect(f.expanded()).toBe(false);
      f.handlers.save({ ...f.handlers.state().config, mode: "persistent" });
      f.leave(); vi.advanceTimersByTime(10000); expect(f.expanded()).toBe(true);
    } finally { f.dispose(); vi.useRealTimers(); }
  });
  it("springs one hovered ring, holds its screen position, and restores the row after leaving", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = await hoverFixture();
    try {
      f.handlers.save({ ...f.handlers.state().config, metrics: ["memory", "cpu", "gpu"], mode: "persistent" });
      const rest = { ...f.bounds() }, ring = f.handlers.state().layout.items[0];
      const ringX = rest.x + 16 + ring.ringX;
      f.point({ x: ringX + 24, y: rest.y + 51 });
      vi.advanceTimersByTime(150); expect(f.handlers.state().layout.active).toBe(null);
      vi.advanceTimersByTime(130);
      const midway = f.handlers.state().layout;
      expect(midway.width).toBeGreaterThan(256); expect(midway.width).toBeLessThan(384);
      expect(midway.items.slice(1).every((item: any) => item.amount === 0)).toBe(true);
      vi.advanceTimersByTime(1500);
      const full = f.handlers.state().layout;
      expect(full.active).toBe("memory"); expect(full.width).toBe(384);
      expect(f.bounds().x + 16 + full.items[0].ringX).toBeCloseTo(ringX, 0);
      f.point({ x: ringX + 120, y: rest.y + 51 }); vi.advanceTimersByTime(500); expect(f.handlers.state().layout.active).toBe("memory");
      f.leave(); vi.advanceTimersByTime(150); expect(f.handlers.state().layout.active).toBe("memory");
      vi.advanceTimersByTime(1800); expect(f.handlers.state().layout.width).toBe(256); expect(f.bounds()).toEqual(rest);
    } finally { f.dispose(); vi.useRealTimers(); }
  });
  it("keeps native window bounds fixed throughout expansion and collapse", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = await hoverFixture();
    try {
      f.handlers.save({ ...f.handlers.state().config, metrics: ["memory", "cpu", "gpu"], mode: "persistent" });
      const canvas = { ...f.windowBounds() }, card = f.bounds(), ring = f.handlers.state().layout.items[0];
      f.point({ x: card.x + 16 + ring.ringX + 24, y: card.y + 51 });
      for (let elapsed = 0; elapsed < 1800; elapsed += 16) { vi.advanceTimersByTime(16); expect(f.windowBounds()).toEqual(canvas); expect(f.bounds().x).toBe(card.x); }
      expect(f.handlers.state().layout.width).toBe(384);
      f.leave();
      for (let elapsed = 0; elapsed < 1800; elapsed += 16) { vi.advanceTimersByTime(16); expect(f.windowBounds()).toEqual(canvas); expect(f.bounds().x).toBe(card.x); }
      expect(f.handlers.state().layout.width).toBe(256);
    } finally { f.dispose(); vi.useRealTimers(); }
  });
  it("does not treat blank canvas as HUD for pointer capture or the hide timer", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = await hoverFixture();
    try {
      f.handlers.save({ ...f.handlers.state().config, displayDuration: .3, clickThrough: false });
      f.handlers.preview(); f.enter(); vi.advanceTimersByTime(1500); f.enterWindow(); vi.advanceTimersByTime(100);
      expect(f.ignored).toHaveBeenLastCalledWith(false, { forward: true });
      f.point({ x: 10, y: f.windowBounds().y + f.windowBounds().height / 2 }); vi.advanceTimersByTime(100);
      expect(f.ignored).toHaveBeenLastCalledWith(true, { forward: true });
      vi.advanceTimersByTime(600); expect(f.expanded()).toBe(false);
    } finally { f.dispose(); vi.useRealTimers(); }
  });
  it("glass readiness and the first power report preserve an expanded detail when material is unchanged", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = await hoverFixture();
    try {
      f.handlers.save({ ...f.handlers.state().config, metrics: ["memory"], mode: "persistent" });
      const card = f.bounds(), ring = f.handlers.state().layout.items[0];
      f.point({ x: card.x + 16 + ring.ringX + 24, y: card.y + 51 }); vi.advanceTimersByTime(1800);
      const before = { ...f.handlers.state().layout };
      f.glassStatus(); f.glassPower(false);
      expect(f.handlers.state().layout).toEqual(before);
    } finally { f.dispose(); vi.useRealTimers(); }
  });
  it("reserves rightward expansion space on a narrow display without moving the left edge", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = await hoverFixture(400);
    try {
      f.handlers.save({ ...f.handlers.state().config, metrics: ["memory", "cpu", "gpu"], mode: "persistent" });
      f.handlers["reduced-motion"](true);
      const rest = f.bounds(), ring = f.handlers.state().layout.items[2];
      f.point({ x: rest.x + (16 + ring.ringX + 24) * f.zoom(), y: rest.y + 51 * f.zoom() }); vi.advanceTimersByTime(300);
      expect(f.handlers.state().layout.active).toBe("gpu");
      expect(f.bounds().x).toBe(rest.x); expect(f.bounds().x + f.bounds().width).toBeLessThanOrEqual(400);
      expect(f.handlers.state().layout.items[2].detailX).toBeGreaterThan(ring.ringX);
    } finally { f.dispose(); vi.useRealTimers(); }
  });
  it("animates measured text widths without moving the shell left edge or reserving empty avatar space", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = await hoverFixture();
    try {
      f.handlers.save({ ...f.handlers.state().config, metrics: ["memory", "cpu", "gpu"], mode: "persistent" });
      const rest = { ...f.bounds() };
      f.handlers["detail-widths"]({ metrics: { memory: 100, cpu: 70, gpu: 112 }, avatar: 76 });
      f.point({ x: rest.x + 16 + 100, y: rest.y + 51 }); vi.advanceTimersByTime(1800);
      expect(f.handlers.state().layout.width).toBe(356); expect(f.bounds().x).toBe(rest.x);
      f.handlers["detail-widths"]({ metrics: { memory: 140 }, avatar: 76 });
      expect(f.handlers.state().layout.width).toBe(356); vi.advanceTimersByTime(80);
      expect(f.handlers.state().layout.width).toBeGreaterThan(356); expect(f.handlers.state().layout.width).toBeLessThan(396);
      vi.advanceTimersByTime(1800); expect(f.handlers.state().layout.width).toBe(396);
      f.point({ x: rest.x + 45, y: rest.y + 51 }); vi.advanceTimersByTime(1800);
      const avatar = f.handlers.state().layout;
      expect(avatar.avatarProgress).toBe(1); expect(avatar.avatarDetailWidth).toBe(76); expect(avatar.width).toBe(256);
      expect(f.bounds().x).toBe(rest.x);
    } finally { f.dispose(); vi.useRealTimers(); }
  });
  it("avatar details grow only when necessary and reuse a wider shell without growth", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = await hoverFixture();
    try {
      f.handlers.save({ ...f.handlers.state().config, metrics: ["memory", "cpu", "gpu"], mode: "persistent" });
      const rest = { ...f.bounds() };
      f.point({ x: rest.x + 45, y: rest.y + 51 }); vi.advanceTimersByTime(1500);
      expect(f.handlers.state().layout).toMatchObject({ active: "avatar", avatarProgress: 1, width: 328 }); expect(f.bounds().width).toBe(rest.width + 72);
      f.point({ x: rest.x + 180, y: rest.y + 51 }); vi.advanceTimersByTime(600); expect(f.handlers.state().layout.active).toBe("avatar");
      f.leave(); vi.advanceTimersByTime(1700); expect(f.handlers.state().layout.avatarProgress).toBe(0);
      f.handlers.save({ ...f.handlers.state().config, metrics: ["memory", "cpu", "gpu", "network", "clock"] });
      const wide = { ...f.bounds() }; f.point({ x: wide.x + 45, y: wide.y + 51 }); vi.advanceTimersByTime(1500);
      expect(f.handlers.state().layout.avatarProgress).toBe(1); expect(f.bounds()).toEqual(wide);
    } finally { f.dispose(); vi.useRealTimers(); }
  });
  it("loads a legacy edge position at top center and honors reduced motion", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = await hoverFixture();
    try {
      f.handlers.save({ ...f.handlers.state().config, metrics: ["memory", "cpu", "gpu"], position: "top-right", mode: "persistent" });
      f.handlers["reduced-motion"](true);
      const rest = { ...f.bounds() }, ring = f.handlers.state().layout.items[2];
      expect(f.handlers.state().config.position).toBe("top-center");
      expect(rest.x + rest.width / 2).toBe(960);
      const ringX = rest.x + 16 + ring.ringX;
      f.point({ x: ringX + 24, y: rest.y + 51 }); vi.advanceTimersByTime(250);
      const full = f.handlers.state().layout;
      expect(full.items[2].amount).toBe(152);
      expect(f.bounds().x + 16 + full.items[2].ringX).toBeCloseTo(ringX, 0);
      expect(f.bounds().x + f.bounds().width).toBeLessThanOrEqual(1920);
    } finally { f.dispose(); vi.useRealTimers(); }
  });
  it("does not reopen a ring swept under a stationary pointer while the previous detail collapses", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = await hoverFixture();
    try {
      f.handlers.save({ ...f.handlers.state().config, metrics: ["memory", "cpu", "gpu"], mode: "persistent" });
      const hover = (id: string) => {
        const item = f.handlers.state().layout.items.find((item: any) => item.id === id);
        f.point({ x: f.bounds().x + 16 + item.ringX + 24, y: f.bounds().y + 51 });
        vi.advanceTimersByTime(1600);
        expect(f.handlers.state().layout.active).toBe(id);
      };
      hover("memory"); hover("cpu");
      const cpu = f.handlers.state().layout.items[1];
      f.point({ x: f.bounds().x + 16 + cpu.ringX - 6, y: f.bounds().y + 51 });
      vi.advanceTimersByTime(3000);
      expect(f.handlers.state().layout.active).toBe(null);
      expect(f.handlers.state().layout.width).toBe(256);
      hover("gpu");
    } finally { f.dispose(); vi.useRealTimers(); }
  });
});

describe("Native glass lifecycle", () => {
  function fixture() {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stdin: Object.assign(new EventEmitter(), { write: vi.fn() }), kill: vi.fn() });
    const launch = vi.fn((_handle?: string, _args?: string[]) => child), changed = vi.fn(), glass = createGlass(changed, launch);
    return { child, launch, changed, glass };
  }
  it("starts once, applies the latest radius, and stops on a plain background", () => {
    const f = fixture();
    f.glass.set(normalizeSettings({ background: "acrylic" }), "123");
    f.glass.set(normalizeSettings({ background: "acrylic", radius: 70 }), "123");
    expect(f.launch).toHaveBeenCalledTimes(1);
    f.child.stdout.emit("data", '{"ready":true}\n');
    expect(f.child.stdin.write).toHaveBeenLastCalledWith("style 70 408 60 acrylic\n");
    f.glass.set(normalizeSettings({ background: "solid" }), "123");
    expect(f.child.kill).toHaveBeenCalledTimes(1); expect(f.glass.status).toBe("off");
    f.child.emit("exit", 0); expect(f.changed).toHaveBeenCalledTimes(1); f.glass.dispose();
  });
  it("requests recovery only on a native occlusion report and ignores old helper replies", () => {
    const f = fixture(), raise = vi.fn(), glass = createGlass(f.changed, f.launch, undefined, undefined, raise);
    glass.set(normalizeSettings({ background: "acrylic" }), "123");
    f.child.stdout.emit("data", '{"ready":true}\n{"luminance":80}\n{"needsRaise":false}\n{"needsRaise":"true"}\n');
    expect(raise).not.toHaveBeenCalled();
    f.child.stdout.emit("data", '{"needsRaise":true}\n'); expect(raise).toHaveBeenCalledOnce();
    glass.dispose(); f.child.stdout.emit("data", '{"needsRaise":true}\n'); expect(raise).toHaveBeenCalledOnce();
  });
  it("fails closed without restarting in a loop and ignores disposed startup replies", () => {
    const f = fixture(), settings = normalizeSettings({ background: "acrylic" });
    f.glass.set(settings, "123"); f.child.emit("error", new Error("missing helper"));
    expect(f.glass.status).toBe("failed"); f.glass.set(settings, "123"); expect(f.launch).toHaveBeenCalledTimes(1);
    f.glass.dispose(); f.child.stdout.emit("data", '{"ready":true}\n');
    expect(f.child.stdin.write).not.toHaveBeenCalled();
  });
  it("sends changed glass geometry even if Windows already rounded its bounds, while coalescing identical frames", () => {
    const f = fixture(), settings = normalizeSettings({ background: "acrylic" });
    f.glass.set({ ...settings, width: 407 }, "123");
    f.child.stdout.emit("data", '{"ready":true}\n');
    f.child.stdin.write.mockClear();
    f.glass.set({ ...settings, width: 408 }, "123", false);
    expect(f.child.stdin.write).toHaveBeenLastCalledWith("style 30 408 60 acrylic\n");
    f.glass.set({ ...settings, width: 408 }, "123", false);
    expect(f.child.stdin.write).toHaveBeenCalledTimes(1);
    f.glass.set({ ...settings, width: 408 }, "123", true);
    expect(f.child.stdin.write).toHaveBeenCalledTimes(2);
    f.glass.dispose();
  });
  it("terminates a helper that never becomes ready", () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); f.glass.set(normalizeSettings({ background: "acrylic" }), "123");
      vi.advanceTimersByTime(8000); expect(f.glass.status).toBe("failed"); expect(f.child.kill).toHaveBeenCalledOnce(); f.glass.dispose();
    } finally { vi.useRealTimers(); }
  });
  it("keeps the collapsed sampling width separate from animated glass width", () => {
    const f = fixture(), settings = { ...normalizeSettings({ background: "acrylic" }), canvasWidth: 1920, offsetX: 800, offsetY: 0, scale: 1.2, sampleWidth: 256 };
    f.glass.set({ ...settings, width: 256 }, "123");
    f.child.stdout.emit("data", '{"ready":true}\n');
    expect(f.child.stdin.write).toHaveBeenLastCalledWith("style 30 256 60 acrylic 800 0 1920 1.2 256\n");
    f.glass.set({ ...settings, width: 384 }, "123");
    expect(f.child.stdin.write).toHaveBeenLastCalledWith("style 30 384 60 acrylic 800 0 1920 1.2 256\n");
    f.glass.dispose();
  });
  it("starts a hidden sampling-only helper for transparent backgrounds and accepts only valid luminance", () => {
    const f = fixture(), luminance = vi.fn(), glass = createGlass(f.changed, f.launch, luminance);
    glass.set(normalizeSettings({ background: "clear" }), "123");
    expect(f.launch.mock.calls[0][1]).toEqual(["123", "--sample-only"]);
    f.child.stdout.emit("data", '{"ready":true}\n{"luminance":');
    f.child.stdout.emit("data", '90}\n{"luminance":999}\n{"luminance":"20"}\n');
    expect(luminance).toHaveBeenLastCalledWith(90);
    glass.dispose(); expect(luminance).toHaveBeenLastCalledWith(null);
    f.child.stdout.emit("data", '{"luminance":10}\n'); expect(luminance).toHaveBeenLastCalledWith(null);
    expect(f.child.kill).toHaveBeenCalledOnce();
  });
  it("propagates battery-saver changes without accepting invalid values or old child messages", () => {
    const f = fixture(), power = vi.fn(), glass = createGlass(f.changed, f.launch, undefined, power);
    glass.set(normalizeSettings({ background: "acrylic" }), "123");
    f.child.stdout.emit("data", '{"ready":true}\n{"powerPaused":true}\n{"powerPaused":false}\n{"powerPaused":1}\n');
    expect(power.mock.calls).toEqual([[true], [false]]);
    glass.dispose(); f.child.stdout.emit("data", '{"powerPaused":true}\n');
    expect(power).toHaveBeenCalledTimes(2);
  });
});

function fixture() {
  let time = 10000, idle = 50, user = 50;
  const misc = { disks: [{ DeviceID: "C:", Size: 100 * 1024 ** 3, FreeSpace: 25 * 1024 ** 3 }], net: { r: 300, s: 50 }, bat: { p: 80, status: 2 }, gpuEngine: 20 };
  const system = { cpus: () => [{ model: "Test CPU", speed: 3200, times: { user, idle, sys: 0, irq: 0, nice: 0 } }], totalmem: () => 16 * 1024 ** 3, freemem: () => 4 * 1024 ** 3, uptime: () => 600, platform: () => "win32" };
  const command = vi.fn(async (name: string) => ({ ok: true, stdout: name === "nvidia-smi" ? "45, 35, 2048, 8192" : name.endsWith("AsusSensors.exe") ? JSON.stringify({ temperature: 68, cpuFanRpm: 4200, gpuFanRpm: 4400 }) : JSON.stringify(misc) }));
  return { misc, command, system, now: () => time, advance: () => { time += 3000; idle += 20; user += 80; }, collector: () => createCollector({ system, command, now: () => time }) };
}

describe("HUD data collector", () => {
  it("retains unknown first differences then calculates CPU and network from two snapshots", async () => {
    const f = fixture(), c = f.collector();
    expect(await c.snapshot()).toMatchObject({ cpuPercent: null, cpuTemperature: 68, cpuTemperatureSource: "asus-acpi", fans: [{ id: "cpu", label: "CPU", rpm: 4200 }, { id: "gpu", label: "GPU", rpm: 4400 }], networkBytesPerSecond: null, memoryPercent: 75, gpuTemperature: 45, vramUsedGb: 2, vramPercent: 25, batteryLabel: "已接通电源" });
    f.advance(); f.misc.net.r += 4500; f.misc.net.s += 1500;
    expect(await c.snapshot()).toMatchObject({ cpuPercent: 80, cpuFrequencyGhz: 3.2, networkBytesPerSecond: 2000, networkUploadBytesPerSecond: 500, networkDownloadBytesPerSecond: 1500, disks: [{ name: "C:", percent: 75 }] });
    expect(f.command.mock.calls[0][0]).toBe("nvidia-smi"); c.dispose();
  });
  it("merges concurrent calls and shares a completed cache", async () => {
    const f = fixture(), c = f.collector();
    const a = c.snapshot(), b = c.snapshot(); expect(a).toBe(b);
    const snapshot = await a; expect(await c.snapshot()).toBe(snapshot); expect(f.command).toHaveBeenCalledTimes(3);
    f.advance(); await c.snapshot(); expect(f.command).toHaveBeenCalledTimes(6); c.dispose();
  });
  it("allows scheduled monitoring to refresh a cached snapshot without waiting for its old cache lifetime", async () => {
    const f = fixture(), c = f.collector();
    const first = await c.snapshot(); expect(await c.snapshot()).toBe(first);
    expect(await c.snapshot(0)).not.toBe(first); expect(f.command).toHaveBeenCalledTimes(6); c.dispose();
  });
  it("rejects late results after disposal and aborts command signals", async () => {
    const f = fixture(); let release!: () => void; const signals: AbortSignal[] = [];
    const wait = new Promise<void>(resolve => { release = resolve; });
    const c = createCollector({ system: f.system, command: async (_n: string, _a: string[], _t: number, signal: AbortSignal) => { signals.push(signal); await wait; return { ok: false, stdout: "" }; } });
    const pending = c.snapshot(); const rejected = expect(pending).rejects.toThrow(); c.dispose();
    expect(signals.every(signal => signal.aborted)).toBe(true); release(); await rejected;
    expect(() => c.snapshot()).toThrow();
  });
  it("retries unavailable NVIDIA after backoff; missing sensors are null", async () => {
    const f = fixture(); f.command.mockImplementation(async () => ({ ok: false, stdout: "" }));
    const c = f.collector(); expect(await c.snapshot()).toMatchObject({ gpuPercent: null, gpuTemperature: null, batteryPercent: null, networkBytesPerSecond: null, disks: [] });
    f.advance(); await c.snapshot(); expect(f.command.mock.calls.filter(c => c[0] === "nvidia-smi")).toHaveLength(1);
    for (let i = 0; i < 10; i++) f.advance();
    await c.snapshot(); expect(f.command.mock.calls.filter(c => c[0] === "nvidia-smi")).toHaveLength(2); c.dispose();
  });
  it("rebaselines reset network counters instead of showing negative traffic", async () => {
    const f = fixture(), c = f.collector(); await c.snapshot(); f.advance(); f.misc.net.r = 0; f.misc.net.s += 10000;
    expect(await c.snapshot()).toMatchObject({ networkBytesPerSecond: null, networkUploadBytesPerSecond: null, networkDownloadBytesPerSecond: null }); c.dispose();
  });
  it("rejects invalid ASUS sensor values, backs off unavailable devices and limits valid fans to two", async () => {
    const f = fixture();
    let sensor: any = { temperature: 999, cpuFanRpm: -1, gpuFanRpm: 99999 };
    f.command.mockImplementation(async name => ({ ok: true, stdout: name.endsWith("AsusSensors.exe") ? JSON.stringify(sensor) : "" }));
    const c = f.collector();
    expect(await c.snapshot()).toMatchObject({ cpuTemperature: null, cpuTemperatureSource: null, fans: [] });
    f.advance(); await c.snapshot();
    expect(f.command.mock.calls.filter(call => call[0].endsWith("AsusSensors.exe"))).toHaveLength(1);
    for (let i = 0; i < 10; i++) f.advance();
    sensor = { temperature: 71, cpuFanRpm: 0, gpuFanRpm: 4400, midFanRpm: 3000 };
    expect(await c.snapshot()).toMatchObject({ cpuTemperature: 71, fans: [{ id: "cpu", label: "CPU", rpm: 0 }, { id: "gpu", label: "GPU", rpm: 4400 }] });
    c.dispose();
  });
  it("does not mistake invalid or multi-GPU output for one numeric row", () => {
    expect(parseNvidia("45, 35, 2048, 8192")).toMatchObject({ percent: 35 });
    for (const text of ["", "N/A, 35, 2048, 8192", "45, 35, 2048, 8192\n55, 20, 1, 10", "45, , 1, 10", "45, 101, 1, 10"]) expect(parseNvidia(text)).toBeNull();
  });
});

describe("Model isolation", () => {
  it("local HUD declares only UI navigation, without model services", async () => {
    const manifest = JSON.parse(await readFile(new URL("../plugins/cyrene-hud/manifest.json", import.meta.url), "utf8"));
    expect(manifest.defaultEnabled).toBe(false); expect(manifest.deps).toEqual(["window-navigation"]);
  });
});

describe("HUD placement", () => {
  it("leaves avatar actions disabled by default and validates navigation choices", () => {
    expect(normalizeSettings({})).toMatchObject({ avatarTarget: "none", avatarSession: "new", avatarSessionId: null });
    expect(normalizeSettings({ avatarTarget: "shell", avatarSession: "other", avatarSessionId: {} })).toMatchObject({ avatarTarget: "none", avatarSession: "new", avatarSessionId: null });
    expect(normalizeSettings({ avatarTarget: "code", avatarSession: "existing", avatarSessionId: "code-session" })).toMatchObject({ avatarTarget: "code", avatarSession: "existing", avatarSessionId: "code-session" });
  });
  it("defaults legacy hide timing, preserves valid values and rejects malformed values", () => {
    expect(normalizeSettings({ hoverDelay: .6 })).toMatchObject({ displayDuration: 4 });
    expect(normalizeSettings({ displayDuration: 2.5, hideTrigger: "trigger-and-window" })).toMatchObject({ displayDuration: 2.5 });
    expect(normalizeSettings({ displayDuration: Infinity, hideTrigger: "other" })).toMatchObject({ displayDuration: 4 });
    expect(normalizeSettings({ displayDuration: -1 }).displayDuration).toBe(.1);
    expect(normalizeSettings({ displayDuration: 99 }).displayDuration).toBe(60);
  });
  it("defaults missing or invalid hover delay to 0.35 seconds and preserves bounded user values", () => {
    for (const hoverDelay of [undefined, NaN, Infinity, "0.5"]) expect(normalizeSettings({ hoverDelay }).hoverDelay).toBe(.35);
    for (const hoverDelay of [0, .35, .6, 10]) expect(normalizeSettings({ hoverDelay }).hoverDelay).toBe(hoverDelay);
    expect(normalizeSettings({ hoverDelay: -1 }).hoverDelay).toBe(0);
    expect(normalizeSettings({ hoverDelay: 11 }).hoverDelay).toBe(10);
  });
  it("uses current defaults for missing fields while preserving saved appearance values", () => {
    const settings = normalizeSettings({ metric: "memory", scale: 1.2 });
    expect(settings).toMatchObject({ width: 408, height: 60, radius: 30, background: "acrylic", metric: "memory" });
    expect(hudBounds(settings, { workArea: { x: 0, y: 0, width: 1920, height: 1080 } }, true).bounds).toMatchObject({ width: 490, height: 72 });
    expect(normalizeSettings({ width: 520, height: 118, radius: 24, background: "solid", mode: "persistent", metric: "cpu", backgroundColor: "#fffbfc", opacity: .95, tintOpacity: .35 })).toMatchObject({ width: 520, height: 118, radius: 24, background: "solid", mode: "persistent", metric: "cpu", backgroundColor: "#fffbfc", opacity: .95, tintOpacity: .35 });
  });
  it("rejects malformed appearance values and clamps dimensions independently", () => {
    expect(normalizeSettings({ backgroundColor: "url(file://x)", tintOpacity: 99 })).toMatchObject({ backgroundColor: "#f9f4f8", tintOpacity: 1 });
    expect(normalizeSettings({ backgroundColor: "#AABBCC", tintOpacity: -1 })).toMatchObject({ backgroundColor: "#aabbcc", tintOpacity: 0 });
    expect(normalizeSettings({ width: -1, height: 900, radius: 999, background: "shell" })).toMatchObject({ width: 340, height: 320, radius: 160, background: "acrylic" });
    expect(normalizeSettings({ width: NaN, height: Infinity, radius: -1 })).toMatchObject({ width: 408, height: 60, radius: 0 });
  });
  it("fits large custom cards to small displays, including material windows without shadow margins", () => {
    for (const material of [false, true]) {
      const { bounds } = hudBounds(normalizeSettings({ width: 800, height: 320, scale: 1.4 }), { workArea: { x: -300, y: 0, width: 300, height: 200 } }, material);
      expect(bounds.width).toBe(300); expect(bounds.height).toBeLessThanOrEqual(200);
      expect(bounds.x).toBe(-300);
    }
  });
  it.each([["win32", "10.0.22621", true], ["win32", "10.0.26300", true], ["win32", "10.0.22000", false], ["win32", "10.0.19045", false], ["linux", "6.8.0", false]])("gates native material for %s %s", (platform, release, expected) => {
    expect(supportsMaterial(platform, release)).toBe(expected);
  });
  it("clamps saved settings and rejects unknown metric names", () => {
    expect(normalizeSettings({ metric: "shell", scale: 99, opacity: -1, displayId: "x" })).toMatchObject({ metric: "memory", scale: 1.4, opacity: 0.35, displayId: null });
    expect(normalizeSettings(null).metric).toBe("memory");
  });
  it.each(["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"])("loads %s as top center within a small negative-coordinate display", position => {
    const display = { workArea: { x: -300, y: -200, width: 300, height: 200 } };
    const { bounds } = hudBounds(normalizeSettings({ scale: 1.4, position }), display);
    expect(normalizeSettings({ position }).position).toBe("top-center");
    expect(bounds.x).toBeGreaterThanOrEqual(-300); expect(bounds.y).toBeGreaterThanOrEqual(-200);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(0); expect(bounds.y + bounds.height).toBeLessThanOrEqual(0);
  });
});
