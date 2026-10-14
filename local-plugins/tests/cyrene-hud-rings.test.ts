import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as { JSDOM: new (html: string, options: { runScripts: string }) => { window: Window & typeof globalThis } };
const { normalizeSettings } = require("../plugins/cyrene-hud/settings.cjs");
const { readStatus } = require("../plugins/cyrene-hud/status.cjs");
const { describe: metric } = require("../plugins/cyrene-hud/metrics.js");
it("migrates the selected legacy metric and preserves a validated unique order", () => {
  expect(normalizeSettings({ metric: "clock" }).metrics).toEqual(["clock"]);
  expect(normalizeSettings({}).metrics).toEqual(["memory", "cpu", "gpu"]);
  expect(normalizeSettings({ metrics: ["gpu", "shell", "memory", "gpu", "status", 42] }).metrics).toEqual(["gpu", "memory"]);
  expect(normalizeSettings({ metrics: [] }).metrics).toEqual(["memory", "cpu", "gpu"]);
});
it("projects only status/feeling flags through the two fixed read endpoints", async () => {
  const invoke = vi.fn(async channel => channel === "runtime-state:get" ? { status: "陪伴中", feeling: "开心", expression: 2, history: "private" } : { connected: true, runtimeSync: "local", apiKey: "private", model: "private" });
  expect(await readStatus(invoke)).toEqual({ available: true, enabled: true, connected: true, status: "陪伴中", feeling: "开心" });
  expect(invoke.mock.calls).toEqual([["runtime-state:get"], ["model-config:get"]]);
  invoke.mockRejectedValue(Error("Unsupported host"));
  expect(await readStatus(invoke)).toEqual({ available: false, enabled: false, connected: false, status: "", feeling: "" });
});
it("formats memory capacity, GPU sensors, local clock and absent values without invented utilization", () => {
  expect(metric("memory", { memoryUsedGb: 25.7, memoryTotalGb: 31.4, memoryPercent: 82 })).toMatchObject({ value: "25.7 / 31.4 GB", progress: 82, ringValue: "82%", detailLabel: "内存", detailValue: "25.7 / 31.4 GB" });
  expect(metric("gpu", { gpuPercent: 41, gpuSource: "nvidia:0", gpuTemperature: 60, vramUsedGb: 2, vramTotalGb: 8 }).note).toBe("60 °C · 显存 2/8 GB");
  expect(metric("network", { networkBytesPerSecond: 1048576 })).toMatchObject({ value: "1.00 MB/s", progress: null });
  expect(metric("network", { networkBytesPerSecond: 4194304, networkUploadBytesPerSecond: 1048576, networkDownloadBytesPerSecond: 3145728 })).toMatchObject({ ringValue: "↑↓", detailLabel: "↑ 1.00 MB/s", detailValue: "↓ 3.00 MB/s", progress: null });
  expect(metric("gpu", { gpuPercent: 41, gpuSource: "nvidia:0", gpuTemperature: 60, vramUsedGb: 2, vramTotalGb: 8 })).toMatchObject({ ringValue: "41%", detailLabel: "GPU · 60 °C", detailValue: "显存 2 / 8 GB" });
  expect(metric("cpu", { cpuPercent: 50, cpuFrequencyGhz: 3.2 })).toMatchObject({ ringValue: "50%", detailLabel: "CPU", detailValue: "3.20 GHz" });
  expect(metric("cpu", { cpuPercent: 50, cpuFrequencyGhz: 3.2, cpuTemperature: 68 })).toMatchObject({ detailLabel: "CPU · 68 °C", detailValue: "3.20 GHz" });
  expect(metric("battery", {})).toMatchObject({ value: "—", progress: null });
  expect(metric("cpu", { cpuPercent: 50 }, {}, new Date(), true)).toMatchObject({ value: "—", progress: null });
  expect(metric("cpu", { cpuPercent: 50, cpuFrequencyGhz: 3.2 }, {}, new Date(), true)).toMatchObject({ ringValue: "—", detailValue: "采集暂不可用" });
  expect(metric("status", {}, { available: true, enabled: false, status: "old" }).value).toBe("—");
});
it("uses a second GPU ring only for a valid dedicated VRAM reading", () => {
  const data = { gpuPercent: 41, gpuSource: "nvidia:0", vramUsedGb: 2, vramTotalGb: 8 };
  expect(metric("gpu", data)).toMatchObject({ progress: 41, innerProgress: 25 });
  expect(metric("gpu", { ...data, vramUsedGb: 0 }).innerProgress).toBe(0);
  for (const patch of [{ gpuSource: "wmi-engine-sum" }, { vramTotalGb: 0 }, { vramUsedGb: -1 }, { vramUsedGb: 9 }, { vramUsedGb: null }]) expect(metric("gpu", { ...data, ...patch }).innerProgress).toBeNull();
  expect(metric("gpu", data, {}, new Date(), true).innerProgress).toBeNull();
});
it("renders one or two fans on a fixed RPM scale and keeps stacked network rates separate from expanded details", () => {
  expect(normalizeSettings({ metrics: ["fan", "memory"] }).metrics).toEqual(["fan", "memory"]);
  const cpu = { id: "cpu", rpm: 4200 }, gpu = { id: "gpu", rpm: 4400 };
  expect(metric("fan", { fans: [cpu] })).toMatchObject({ progress: 4200 / 6300 * 100, innerProgress: null, detailLabel: "CPU 4200 RPM" });
  expect(metric("fan", { fans: [cpu, gpu] })).toMatchObject({ progress: 4200 / 6300 * 100, innerProgress: 4400 / 6300 * 100, detailLabel: "CPU 4200 RPM", detailValue: "GPU 4400 RPM" });
  const custom = metric("fan", { fans: [cpu, gpu] }, {}, new Date(), false, { cpuFanReferenceRpm: 6000, gpuFanReferenceRpm: 8000 });
  expect(custom).toMatchObject({ progress: 70, ringValue: "70%" }); expect(custom.innerProgress).toBeCloseTo(55);
  expect(metric("fan", { fans: [cpu] }, {}, new Date(), false, { cpuFanReferenceRpm: 2000 }).progress).toBe(100);
  expect(metric("fan", { fans: [{ ...cpu, rpm: 0 }] })).toMatchObject({ progress: 0, innerProgress: null });
  expect(metric("fan", { fans: [] })).toMatchObject({ progress: null, innerProgress: null, value: "—" });
  expect(metric("fan", { fans: [cpu, gpu] }, {}, new Date(), true)).toMatchObject({ progress: null, innerProgress: null, value: "—" });
  expect(metric("network", { networkUploadBytesPerSecond: 1048576, networkDownloadBytesPerSecond: 3145728 })).toMatchObject({ ringRates: ["1.00", "3.00"], detailLabel: "↑ 1.00 MB/s", detailValue: "↓ 3.00 MB/s" });
});
it("shows independent GPU and VRAM progress, falls back to one ring and hides only rings that overlap real avatar content", async () => {
  const dom = new JSDOM(readFileSync(new URL("../plugins/cyrene-hud/hud.html", import.meta.url), "utf8"), { runScripts: "outside-only" });
  const { measure, compose } = require("../plugins/cyrene-hud/motion.cjs");
  const config = normalizeSettings({}), base = measure(config);
  let change!: (state: any) => void, onLayout!: (frame: any) => void, visibility!: (visible: boolean) => void, onSnapshot!: (value: any) => void;
  const frame = { ...compose(base, config.metrics, {}), avatarProgress: 0, avatarDetailX: 74, avatarDetailWidth: 76 };
  const state = { config, layout: frame, effectiveBackground: "solid" };
  let data: any = { gpuPercent: 41, gpuSource: "nvidia:0", vramUsedGb: 2, vramTotalGb: 8 };
  (dom.window as any).matchMedia = () => ({ matches: false, addEventListener() {} });
  (dom.window as any).cyreneHud = { state: async () => state, onChange(fn: any) { change = fn; }, onLayout(fn: any) { onLayout = fn; }, onVisibility(fn: any) { visibility = fn; }, onSnapshot(fn: any) { onSnapshot = fn; }, reducedMotion: async () => {}, detailWidths: async () => {}, snapshot: async () => data, status: async () => ({}) };
  try {
    for (const file of ["metrics.js", "hud.js"]) dom.window.eval(readFileSync(new URL(`../plugins/cyrene-hud/${file}`, import.meta.url), "utf8"));
    await vi.waitFor(() => expect(dom.window.document.querySelectorAll(".ring")).toHaveLength(3));
    visibility(true);
    const gpu = () => dom.window.document.querySelector('[data-metric="gpu"]')!;
    await vi.waitFor(() => expect(gpu().querySelector(".inner-ring")!.hasAttribute("hidden")).toBe(false));
    expect(Number(gpu().querySelector("svg > .progress")!.getAttribute("stroke-dasharray")!.split(" ")[0])).toBeCloseTo(201.062 * .41);
    expect(gpu().querySelector(".inner-ring .progress")!.getAttribute("stroke-dasharray")).toBe(`${150.796 * .25} 150.796`);
    onLayout({ ...frame, avatarProgress: 1 });
    expect((gpu() as HTMLElement).style.opacity).toBe("1");
    expect((dom.window.document.querySelector('[data-metric="memory"]') as HTMLElement).style.opacity).toBe("0");
    onLayout({ ...frame, avatarProgress: .5 });
    const avatarDetail = dom.window.document.querySelector("#avatarDetail") as HTMLElement;
    expect(avatarDetail.style.width).toBe("76px");
    expect(avatarDetail.style.getPropertyValue("--reveal-edge")).toBe("38px");
    expect(avatarDetail.style.getPropertyValue("--reveal-solid")).toBe("22px");
    expect(avatarDetail.style.clipPath).toBe("");
    data = { gpuPercent: 10, gpuSource: "wmi-engine-sum" }; onSnapshot(data);
    await vi.waitFor(() => expect(gpu().querySelector(".inner-ring")!.hasAttribute("hidden")).toBe(true));
    change(state); expect(dom.window.document.querySelector("#hud [title]") === null).toBe(true);
  } finally { dom.window.close(); }
});
it("reuses the same ring for the expanded readout and renders two compact detail lines", async () => {
  const dom = new JSDOM(readFileSync(new URL("../plugins/cyrene-hud/hud.html", import.meta.url), "utf8"), { runScripts: "outside-only" });
  const { measure, compose, DETAIL_WIDTH } = require("../plugins/cyrene-hud/motion.cjs");
  const config = normalizeSettings({ metrics: ["memory", "network"], background: "solid" });
  const base = measure(config);
  const frame = (amount: number) => ({ ...compose(base, config.metrics, { memory: amount }), avatarProgress: 0, avatarX: 14, avatarDetailX: 74, avatarDetailWidth: 240 });
  let onLayout!: (frame: any) => void, onVisibility!: (visible: boolean) => void;
  (dom.window as any).matchMedia = () => ({ matches: false, addEventListener() {} });
  (dom.window as any).cyreneHud = {
    state: async () => ({ config, effectiveBackground: "solid", layout: frame(0) }),
    onChange() {}, onLayout(fn: any) { onLayout = fn; }, onVisibility(fn: any) { onVisibility = fn; }, onSnapshot() {},
    reducedMotion: async () => {}, avatarHover: async () => {}, detailWidths: async () => {},
    snapshot: async () => ({ memoryUsedGb: 25.7, memoryTotalGb: 31.4, memoryPercent: 82, networkBytesPerSecond: 4194304, networkUploadBytesPerSecond: 1048576, networkDownloadBytesPerSecond: 3145728 }),
    status: async () => ({}),
  };
  try {
    for (const file of ["metrics.js", "hud.js"]) dom.window.eval(readFileSync(new URL(`../plugins/cyrene-hud/${file}`, import.meta.url), "utf8"));
    const doc = dom.window.document;
    await vi.waitFor(() => expect(doc.querySelectorAll(".ring")).toHaveLength(2));
    onVisibility(true);
    await vi.waitFor(() => expect(doc.querySelector('[data-metric="memory"] .ring-value')!.textContent).toBe("82%"));
    const ring = doc.querySelector('[data-metric="memory"] .ring')!;
    onLayout(frame(DETAIL_WIDTH.memory / 2));
    expect((ring.parentElement as HTMLElement).style.getPropertyValue("--detail-progress")).toBe("0.5");
    const detail = doc.querySelector('[data-metric="memory"] .metric-detail') as HTMLElement;
    expect(detail.style.width).toBe(`${DETAIL_WIDTH.memory}px`);
    expect(detail.style.getPropertyValue("--reveal-edge")).toBe(`${DETAIL_WIDTH.memory / 2}px`);
    expect(detail.style.getPropertyValue("--reveal-solid")).toBe(`${DETAIL_WIDTH.memory / 2 - 16}px`);
    expect(detail.style.opacity).toBe("");
    expect(detail.querySelector("strong")!.textContent).toBe("25.7 / 31.4 GB");
    onLayout(frame(DETAIL_WIDTH.memory));
    expect(doc.querySelector('[data-metric="memory"] .ring')).toBe(ring);
    expect(ring.querySelector(".ring-label")!.textContent).toBe("内存");
    expect(doc.querySelector('[data-metric="memory"] small')!.textContent).toBe("内存");
    expect(doc.querySelector('[data-metric="memory"] strong')!.textContent).toBe("25.7 / 31.4 GB");
    expect(doc.querySelector('[data-metric="network"] small')!.textContent).toBe("↑ 1.00 MB/s");
    expect(doc.querySelector('[data-metric="network"] strong')!.textContent).toBe("↓ 3.00 MB/s");
    expect(doc.querySelector('[data-metric="network"] .upload')!.textContent).toBe("1.00");
    expect(doc.querySelector('[data-metric="network"] .download')!.textContent).toBe("3.00");
    expect(Array.from(doc.querySelectorAll('[data-metric="network"] .network-rate b'), node => node.textContent)).toEqual(["↑", "↓"]);
    expect(doc.querySelector("#hud [title]") === null).toBe(true);
    expect(doc.querySelector('[data-metric="memory"]')!.getAttribute("aria-label")).toContain("25.7 / 31.4");
    onLayout(frame(0));
    expect((ring.parentElement as HTMLElement).style.getPropertyValue("--detail-progress")).toBe("0");
    expect(doc.querySelector('[data-metric="memory"] .metric-detail')!.getAttribute("aria-hidden")).toBe("true");
    expect(detail.style.width).toBe(`${DETAIL_WIDTH.memory}px`);
    expect(detail.style.getPropertyValue("--reveal-edge")).toBe("0px");
  } finally { dom.window.close(); }
});
it("uses the same palette for the same backdrop brightness regardless of previous palette", async () => {
  const dom = new JSDOM(readFileSync(new URL("../plugins/cyrene-hud/hud.html", import.meta.url), "utf8"), { runScripts: "outside-only" });
  let change!: (state: any) => void;
  const state = { config: normalizeSettings({}), effectiveBackground: "acrylic", backdropLuminance: 137 };
  (dom.window as any).matchMedia = () => ({ matches: false, addEventListener() {} });
  (dom.window as any).cyreneHud = { state: async () => state, onChange(fn: any) { change = fn; }, onLayout() {}, onVisibility() {}, onSnapshot() {}, reducedMotion: async () => {}, detailWidths: async () => {} };
  try {
    for (const file of ["metrics.js", "hud.js"]) dom.window.eval(readFileSync(new URL(`../plugins/cyrene-hud/${file}`, import.meta.url), "utf8"));
    await vi.waitFor(() => expect(dom.window.document.querySelectorAll(".ring")).toHaveLength(3));
    const dark = () => dom.window.document.body.classList.contains("dark-tint");
    change(state); const initial = dark();
    change({ ...state, backdropLuminance: 100 }); expect(dark()).toBe(true);
    change(state); expect(dark()).toBe(initial);
    change({ ...state, backdropLuminance: 200 }); expect(dark()).toBe(false);
    change(state); expect(dark()).toBe(initial);
    const palette = () => ({ track: dom.window.document.body.style.getPropertyValue("--hud-track"), ring: dom.window.document.body.style.getPropertyValue("--hud-ring") });
    const brightness = (color: string) => { const rgb = color.match(/[\d.]+/g)!.map(Number); return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722; };
    const lightPalettes = [165, 200, 247].map(luminance => {
      change({ ...state, backdropLuminance: luminance });
      const colors = palette();
      expect(brightness(colors.track)).toBeGreaterThan(195);
      expect(brightness(colors.track)).toBeLessThan(236);
      expect(brightness(colors.ring)).toBeGreaterThan(160);
      expect(brightness(colors.ring)).toBeLessThan(200);
      expect(brightness(colors.track) - brightness(colors.ring)).toBeGreaterThan(20);
      const channels = colors.ring.match(/\d+/g)!.map(Number);
      expect(channels[0] - channels[1]).toBeGreaterThan(75);
      expect(channels[0] - channels[1]).toBeLessThan(106);
      expect(dom.window.document.documentElement.style.getPropertyValue("--hud-tint")).toBe("rgba(249,244,248,0.2)");
      return colors;
    });
    expect(brightness(lightPalettes[2].ring)).toBeGreaterThan(brightness(lightPalettes[0].ring));
    change({ ...state, backdropLuminance: 165 }); expect(palette()).toEqual(lightPalettes[0]);
    change({ ...state, backdropLuminance: null });
    expect(dark()).toBe(false); expect(brightness(palette().track)).toBeGreaterThan(220);
    expect(dom.window.document.querySelector("#hud [title]") === null).toBe(true);
  } finally { dom.window.close(); }
});
it("saves reordered checked metrics, rejects an empty selection and has no countdown selector", async () => {
  const dom = new JSDOM(readFileSync(new URL("../plugins/cyrene-hud/settings.html", import.meta.url), "utf8"), { runScripts: "outside-only" });
  const state = { config: normalizeSettings({}), displays: [], materialSupported: true, glassStatus: "off", edition: "local" };
  const save = vi.fn(async config => ({ ...state, config }));
  (dom.window as any).cyreneHud = { state: async () => state, onChange() {}, save, listSessions: async () => [] };
  try {
    for (const file of ["metrics.js", "settings.js"]) dom.window.eval(readFileSync(new URL(`../plugins/cyrene-hud/${file}`, import.meta.url), "utf8"));
    const doc = dom.window.document;
    await vi.waitFor(() => expect(doc.querySelectorAll("#metricList input").length).toBe(7));
    expect(doc.getElementById("hideTrigger")).toBeNull();
    expect(doc.getElementById("width")).toBeNull();
    expect(Array.from(doc.querySelectorAll<HTMLOptionElement>("#position option")).filter(option => !option.disabled).map(option => option.value)).toEqual(["top-center"]);
    (doc.querySelector('[data-metric="cpu"] button') as HTMLButtonElement).click();
    const battery = doc.querySelector('input[data-metric="battery"]') as HTMLInputElement;
    battery.checked = true; battery.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    doc.getElementById("form")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ metrics: ["cpu", "memory", "gpu", "battery"] })));
    await vi.waitFor(() => expect(doc.getElementById("feedback")!.textContent).toBe("已保存"));
    const gpuRow = doc.querySelector('div[data-metric="gpu"]')!;
    const drag = new dom.window.Event("dragstart", { bubbles: true });
    Object.defineProperty(drag, "dataTransfer", { value: { setData() {} } });
    gpuRow.dispatchEvent(drag);
    doc.querySelector('div[data-metric="cpu"]')!.dispatchEvent(new dom.window.Event("drop", { bubbles: true, cancelable: true }));
    doc.getElementById("form")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ metrics: ["gpu", "cpu", "memory", "battery"] })));
    await new Promise(resolve => setTimeout(resolve, 0));
    for (const input of doc.querySelectorAll<HTMLInputElement>("#metricList input")) { input.checked = false; input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); }
    save.mockClear(); doc.getElementById("form")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    expect(save).not.toHaveBeenCalled(); expect(doc.getElementById("feedback")!.textContent).toBe("请至少选择一个性能圆环。");
  } finally { dom.window.close(); }
});
