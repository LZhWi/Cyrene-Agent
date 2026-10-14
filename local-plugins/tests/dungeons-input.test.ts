import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InputManager, validatePulse, validateFollow } from "../plugins/dungeons-input/src/manager";
import { createPlugin } from "../plugins/dungeons-input/src/index";

const valid = { pad: 2, control: "right", durationMs: 200, delayMs: 5000 };
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string, options: unknown) => { window: Window & { eval(code: string): void; MessageEvent: typeof MessageEvent; Event: typeof Event } };
};
function worker() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() });
  const requests: any[] = [];
  child.stdin.on("data", data => requests.push(JSON.parse(String(data))));
  const launch = vi.fn((_file: string, _args: readonly string[], _options: unknown) => child);
  const manager = new InputManager("C:/isolated/runtime", launch as unknown as typeof spawn);
  const message = (data: unknown) => child.stdout.write(JSON.stringify(data) + "\n");
  return { child, requests, launch, manager, message };
}
afterEach(() => vi.useRealTimers());
describe("Dungeons bounded input", () => {
  it.each([
    [{ ...valid, pad: 0 }, "手柄"], [{ ...valid, pad: 3 }, "手柄"],
    [{ ...valid, durationMs: 0 }, "脉冲"], [{ ...valid, durationMs: 1001 }, "脉冲"],
    [{ ...valid, durationMs: 100.5 }, "脉冲"], [{ ...valid, delayMs: 1999 }, "延迟"],
    [{ ...valid, delayMs: 10001 }, "延迟"], [{ ...valid, control: "arbitrary-code" }, "按键"],
    [{ ...valid, pad: 1 }, "确认"], [null, "手柄"],
  ])("rejects unsafe pulse %j", (value, reason) => expect(() => validatePulse(value)).toThrow(reason));
  it("accepts explicit P1 initialization and strips caller metadata", () => {
    expect(validatePulse({ ...valid, pad: 1, confirmP1: true, id: "caller", exe: "sequel" })).toEqual({ pad: 1, control: "right", durationMs: 200, delayMs: 5000, confirmP1: true });
  });
  it.each([null, {}, { delayMs: 1999 }, { delayMs: 10001 }, { delayMs: 5000.5 }, { delayMs: 5000 }])("rejects unconfirmed follow %j", value => {
    expect(() => validateFollow(value, false)).toThrow();
  });
  it("observation requires no movement confirmation and ignores caller routing", () => {
    expect(validateFollow({ delayMs: 5000, pad: 1, path: "sequel" }, true)).toEqual({ delayMs: 5000, confirmCamp: false });
    expect(validateFollow({ delayMs: 5000, confirmCamp: true }, false)).toEqual({ delayMs: 5000, confirmCamp: true });
  });
  it("follow is explicit, mutually exclusive, stops on exit and never replays", () => {
    vi.useFakeTimers(); const w = worker();
    expect(() => w.manager.follow({ delayMs: 5000 }, true)).toThrow("先创建");
    w.manager.start(); w.message({ type: "state", ready: true, pads: [1, 2] });
    w.manager.follow({ delayMs: 5000 }, true);
    expect(w.requests).toEqual([{ type: "follow-observe", delayMs: 5000, confirmCamp: false }]);
    expect(() => w.manager.pulse(valid)).toThrow("停止观察");
    expect(() => w.manager.follow({ delayMs: 5000, confirmCamp: true })).toThrow("已有");
    w.message({ type: "follow", phase: "complete", frame: { png: "local-preview", p1: {}, p2: {} } });
    expect(w.manager.status().follow.frame.png).toBe("local-preview");
    w.manager.follow({ delayMs: 5000, confirmCamp: true, pad: 1 });
    expect(w.requests.at(-1)).toEqual({ type: "follow-start", delayMs: 5000, confirmCamp: true });
    w.manager.cancel(); expect(w.requests.at(-1)).toEqual({ type: "cancel" });
    w.message({ type: "follow", phase: "stopped", reason: "manual" });
    w.manager.pulse(valid); w.child.emit("close", 0); vi.advanceTimersByTime(10000);
    expect(w.launch).toHaveBeenCalledTimes(1); expect(w.manager.status().follow.phase).toBe("stopped");
    expect(w.requests.filter(r => r.type === "follow-start")).toHaveLength(1);
  });
  it("pending manual pulse rejects follow before any follow request", () => {
    vi.useFakeTimers(); const w = worker(); w.manager.start(); w.message({ type: "state", ready: true, pads: [1, 2] });
    w.manager.pulse(valid); expect(() => w.manager.follow({ delayMs: 5000 }, true)).toThrow("已有");
    expect(w.requests.filter(r => r.type === "follow-observe")).toEqual([]); w.child.emit("close", 0);
  });
  it("native follow rejection restores manual input availability", () => {
    vi.useFakeTimers(); const w = worker(); w.manager.start(); w.message({ type: "state", ready: true, pads: [1, 2] });
    w.manager.follow({ delayMs: 5000 }, true); w.message({ type: "follow", phase: "rejected", reason: "native busy" });
    expect(() => w.manager.pulse(valid)).not.toThrow(); w.child.emit("close", 0);
  });
  it("starts neutral, sends owned unique request once, and blocks overlap", async () => {
    vi.useFakeTimers(); const w = worker(); w.manager.start();
    expect(w.requests).toEqual([]); expect(w.launch.mock.calls[0]).toHaveLength(3);
    expect(() => w.manager.pulse(valid)).toThrow("先创建");
    w.message({ type: "state", ready: true, pads: [0, 1] });
    const result = w.manager.pulse({ ...valid, id: "caller" });
    expect(result.id).not.toBe("caller"); expect(w.requests).toHaveLength(1);
    expect(() => w.manager.pulse(valid)).toThrow("已有");
    w.manager.cancel(); expect(w.requests[1]).toEqual({ type: "cancel" });
    w.message({ type: "result", id: result.id, status: "cancelled" });
    w.manager.pulse(valid); expect(w.requests.filter(r => r.type === "pulse")).toHaveLength(2);
    const stopping = w.manager.stop(); expect(w.requests.at(-1)).toEqual({ type: "stop" });
    w.child.emit("close", 0); await stopping; expect(w.manager.status().running).toBe(false);
  });
  it("loses pending action on exit without automatic restart or replay", () => {
    vi.useFakeTimers(); const w = worker(); w.manager.start(); w.message({ type: "state", ready: true, pads: [0, 1] });
    w.manager.pulse(valid); w.child.emit("close", 1);
    vi.advanceTimersByTime(10000);
    expect(w.launch).toHaveBeenCalledTimes(1); expect(w.requests).toHaveLength(1);
    expect(w.manager.status().results.at(-1).status).toBe("disconnected");
  });
  it("heartbeats only while owned worker lives and disposes it", async () => {
    vi.useFakeTimers(); const w = worker(); w.manager.start(); vi.advanceTimersByTime(1000);
    expect(w.requests).toEqual([{ type: "heartbeat" }, { type: "heartbeat" }]);
    const closing = w.manager.close(); w.child.emit("close", 0); await closing;
    const count = w.requests.length; vi.advanceTimersByTime(10000); expect(w.requests).toHaveLength(count);
    expect(() => w.manager.start()).toThrow("停止");
  });
  it("probe never creates targets or leaves a live test session", async () => {
    const w = worker(); const checked = w.manager.probe();
    expect(w.launch.mock.calls[0][1]).toEqual(["--probe"]);
    w.message({ type: "probe", available: false, error: "missing driver" }); w.child.emit("close", 1);
    expect(await checked).toMatchObject({ available: false }); expect(w.manager.status().running).toBe(false); expect(w.requests).toEqual([]);
  });
  it("registers only local input IPC and owns disposal", async () => {
    const manager = { status: vi.fn(), probe: vi.fn(), start: vi.fn(), pulse: vi.fn(), cancel: vi.fn(), stop: vi.fn(), close: vi.fn() };
    const calls: string[] = []; let dispose: (() => unknown) | undefined;
    const plugin = createPlugin(() => manager as unknown as InputManager);
    await plugin.register!({ signal: new AbortController().signal, onDispose: (fn: () => unknown) => { dispose = fn; }, registerIpc: (name: string) => calls.push(name) } as any);
    expect(calls).toEqual(["input-status", "input-probe", "input-start", "input-pulse", "input-cancel", "input-stop", "follow-observe", "follow-start"]);
    await dispose!(); expect(manager.close).toHaveBeenCalledOnce();
  });
  it("panel uses actual host bridge, starts on P2, and forwards bounded pulse", async () => {
    const html = await readFile("plugins/dungeons-input/static/settings.html", "utf8");
    const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://panel.invalid" });
    const requests: any[] = [];
    dom.window.addEventListener("message", event => {
      const message = event.data;
      if (message.kind !== "invoke") return;
      requests.push(message);
      const data = message.channel === "input-status" ? { running: true, state: { ready: true, pads: [1, 2], xinputSlots: [0, 1] }, results: [], notices: [] } : { requested: true };
      dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { protocol: "cyrene-panel/1", kind: "invoke-result", seq: message.seq, ok: true, data } }));
    });
    dom.window.eval(await readFile("../src/main/plugin-panel/panel-bridge.js", "utf8"));
    dom.window.eval(await readFile("plugins/dungeons-input/static/settings.js", "utf8"));
    dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { protocol: "cyrene-panel/1", kind: "init", theme: {} } }));
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(dom.window.document.querySelector<HTMLSelectElement>("#pad")!.value).toBe("2");
      expect(dom.window.document.querySelector<HTMLInputElement>("#confirm-p1")!.checked).toBe(false);
      dom.window.document.querySelector<HTMLButtonElement>("#pulse")!.click(); await new Promise(resolve => setTimeout(resolve, 30));
      expect(requests.find(r => r.channel === "input-pulse").args).toEqual([{ ...valid, confirmP1: false }]);
    } finally { dom.window.close(); }
  });
  it.each([false, true])("panel blocks actions until worker readiness (running=%s)", async running => {
    const html = await readFile("plugins/dungeons-input/static/settings.html", "utf8");
    const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://panel.invalid" });
    const requests: string[] = [];
    const button = (id: string) => dom.window.document.querySelector<HTMLButtonElement>(`#${id}`)!;
    expect(button("pulse").disabled).toBe(true); expect(button("cancel").disabled).toBe(true);
    dom.window.addEventListener("message", event => {
      const m = event.data; if (m.kind !== "invoke") return; requests.push(m.channel);
      const data = m.channel === "input-status" ? { running, state: { ready: false, pads: [] }, results: [], notices: [] } : m.channel === "input-probe" ? { available: true } : { requested: true };
      dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { protocol: "cyrene-panel/1", kind: "invoke-result", seq: m.seq, ok: true, data } }));
    });
    dom.window.eval(await readFile("../src/main/plugin-panel/panel-bridge.js", "utf8"));
    dom.window.eval(await readFile("plugins/dungeons-input/static/settings.js", "utf8"));
    dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { protocol: "cyrene-panel/1", kind: "init", theme: {} } }));
    try {
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(button("pulse").disabled).toBe(true); expect(button("cancel").disabled).toBe(true);
      expect(Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>("[data-menu-control]")).every(b => b.disabled)).toBe(true);
      expect(dom.window.document.querySelector<HTMLElement>("#connection-hint")!.hidden).toBe(false);
      expect(dom.window.document.querySelector("#result")!.textContent).toBe("尚未发送任何动作。");
      button("pulse").click(); button("cancel").click();
      expect(requests).not.toContain("input-pulse"); expect(requests).not.toContain("input-cancel");
      if (!running) {
        button("start").click(); await new Promise(resolve => setTimeout(resolve, 40));
        expect(dom.window.document.querySelector("#notice")!.textContent).toContain("这一步不会发送 LS");
        expect(dom.window.document.querySelector("#notice")!.textContent).not.toBe("请求已提交");
      }
    } finally { dom.window.close(); }
  });
  it("waits for actual host initialization instead of losing the first status request", async () => {
    vi.useFakeTimers();
    const dom = new JSDOM(await readFile("plugins/dungeons-input/static/settings.html", "utf8"), { runScripts: "outside-only", url: "https://panel.invalid" });
    let registered = false; const requests: string[] = [];
    dom.window.addEventListener("message", event => {
      const m = event.data; if (m.kind !== "invoke") return; requests.push(m.channel);
      if (!registered) return; // Actual settings host ignores pre-load requests.
      const data = { running: true, state: { ready: true, pads: [9, 10], xinputSlots: [0, 1] }, results: [], notices: [] };
      dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { protocol: "cyrene-panel/1", kind: "invoke-result", seq: m.seq, ok: true, data } }));
    });
    dom.window.eval(await readFile("../src/main/plugin-panel/panel-bridge.js", "utf8"));
    dom.window.eval(await readFile("plugins/dungeons-input/static/settings.js", "utf8"));
    try {
      await vi.advanceTimersByTimeAsync(2000);
      expect(requests).toEqual([]); expect(dom.window.document.querySelector<HTMLButtonElement>("#start")!.disabled).toBe(true);
      registered = true;
      dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { protocol: "cyrene-panel/1", kind: "init", theme: {} } }));
      await vi.advanceTimersByTimeAsync(100);
      expect(requests).toEqual(["input-status"]);
      expect(dom.window.document.querySelector("#summary")!.textContent).toContain("两只手柄已创建");
      expect(dom.window.document.querySelector("#summary")!.textContent).toContain("9、10");
      expect(dom.window.document.querySelector<HTMLButtonElement>("#pulse")!.disabled).toBe(false);
      dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { protocol: "cyrene-panel/1", kind: "theme-changed", theme: {} } }));
      await vi.advanceTimersByTimeAsync(100); expect(requests).toEqual(["input-status"]);
      await vi.advanceTimersByTimeAsync(500); expect(requests.filter(name => name === "input-status").length).toBeGreaterThan(1);
    } finally { dom.window.close(); }
  });
  it("panel gates camp confirmation, prevents overlapping follow and uses the stop channel", async () => {
    const dom = new JSDOM(await readFile("plugins/dungeons-input/static/settings.html", "utf8"), { runScripts: "outside-only", url: "https://panel.invalid" });
    const requests: any[] = []; let follow = { phase: "idle", reason: "idle" };
    dom.window.addEventListener("message", event => {
      const m = event.data; if (m.kind !== "invoke") return; requests.push(m);
      let data;
      if (m.channel === "input-status") data = { running: true, state: { ready: true, pads: [1, 2], xinputSlots: [0, 1] }, results: [], notices: [], follow };
      else if (m.channel === "follow-start") { data = validateFollow(m.args[0], false); follow = { phase: "countdown", reason: "armed" }; }
      else if (m.channel === "input-cancel") { data = { requested: true }; follow = { phase: "stopped", reason: "manual" }; }
      else throw Error(`Unexpected follow IPC: ${m.channel}`);
      dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { protocol: "cyrene-panel/1", kind: "invoke-result", seq: m.seq, ok: true, data } }));
    });
    dom.window.eval(await readFile("../src/main/plugin-panel/panel-bridge.js", "utf8"));
    dom.window.eval(await readFile("plugins/dungeons-input/static/settings.js", "utf8"));
    const button = (id: string) => dom.window.document.querySelector<HTMLButtonElement>(`#${id}`)!;
    try {
      expect(button("observe").disabled).toBe(true); expect(button("follow").disabled).toBe(true);
      dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { protocol: "cyrene-panel/1", kind: "init", theme: {} } }));
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(button("observe").disabled).toBe(false); expect(button("follow").disabled).toBe(true);
      const confirmation = dom.window.document.querySelector<HTMLInputElement>("#confirm-camp")!;
      confirmation.checked = true; confirmation.dispatchEvent(new dom.window.Event("change"));
      await new Promise(resolve => setTimeout(resolve, 30));
      // A manual P1 selection must not route autonomous follow to P1.
      dom.window.document.querySelector<HTMLSelectElement>("#pad")!.value = "1";
      button("follow").click(); button("follow").click(); await new Promise(resolve => setTimeout(resolve, 30));
      expect(requests.filter(r => r.channel === "follow-start").map(r => r.args)).toEqual([[{ delayMs: 5000, confirmCamp: true }]]);
      expect(button("pulse").disabled).toBe(true); expect(button("observe").disabled).toBe(true); expect(button("follow").disabled).toBe(true);
      expect(button("follow-cancel").disabled).toBe(false); button("follow-cancel").click();
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(requests.filter(r => r.channel === "input-cancel")).toHaveLength(1);
      expect(dom.window.document.querySelector("#follow-result")!.textContent).toContain("manual");
    } finally { dom.window.close(); }
  });
  it.each(["A", "B", "DpadUp", "DpadDown", "DpadLeft", "DpadRight"])("menu shortcut %s forwards one bounded gamepad pulse", async control => {
    const dom = new JSDOM(await readFile("plugins/dungeons-input/static/settings.html", "utf8"), { runScripts: "outside-only", url: "https://panel.invalid" });
    const requests: any[] = []; let results: any[] = [];
    dom.window.addEventListener("message", event => {
      const m = event.data; if (m.kind !== "invoke") return;
      let data;
      if (m.channel === "input-status") data = { running: true, state: { ready: true, pads: [1, 2], xinputSlots: [0, 1] }, results, notices: [] };
      else if (m.channel === "input-pulse") {
        data = { id: "menu-test", status: "scheduled", ...validatePulse(m.args[0]) }; requests.push(m.args[0]); results = [data];
      } else throw Error(`Unexpected menu IPC: ${m.channel}`);
      dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { protocol: "cyrene-panel/1", kind: "invoke-result", seq: m.seq, ok: true, data } }));
    });
    dom.window.eval(await readFile("../src/main/plugin-panel/panel-bridge.js", "utf8"));
    dom.window.eval(await readFile("plugins/dungeons-input/static/settings.js", "utf8"));
    dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { protocol: "cyrene-panel/1", kind: "init", theme: {} } }));
    const button = dom.window.document.querySelector<HTMLButtonElement>(`[data-menu-control="${control}"]`)!;
    try {
      for (let n = 0; n < 30 && button.disabled; n++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(button.disabled).toBe(false); button.click(); button.click();
      for (let n = 0; n < 30 && (!requests.length || !button.disabled); n++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(requests).toEqual([{ ...valid, control, confirmP1: false }]);
      expect(dom.window.document.querySelector<HTMLSelectElement>("#control")!.value).toBe(control);
      expect(Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>("[data-menu-control]")).every(b => b.disabled)).toBe(true);
    } finally { dom.window.close(); }
  });
});
