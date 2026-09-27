import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createMockPluginContext } from "@playa0v0/cyrene-plugin-sdk/testing";
import type { PluginLlmService } from "@playa0v0/cyrene-plugin-sdk";
import chatPlugin from "../plugins/companion-chat/src/index";
import { CHAT_ID } from "../plugins/shared/protocol";
import type { LifePlanningInput } from "../plugins/companion-chat/src/life-planning";

const { JSDOM } = require("jsdom");

function validReply(messages: Array<{ content: string }>): string {
  const input = JSON.parse(messages.at(-1)!.content) as LifePlanningInput;
  return JSON.stringify({ kind: input.kind, date: input.date, revision: input.revision,
    windows: input.windows.map((window) => ({ id: window.id, activities: [input.activities[0]] })) });
}

async function withPlugin(generateText: PluginLlmService["generateText"], check: (invoke: (action: string, data?: unknown) => Promise<any>) => Promise<void>) {
  const parent = path.resolve(".test-runtime");
  mkdirSync(parent, { recursive: true });
  const parentReal = realpathSync(parent), root = mkdtempSync(path.join(parent, "life-planning-"));
  const ctx = createMockPluginContext({ pluginId: CHAT_ID, deps: { llm: { generateText } } });
  ctx.storage.rootDir = () => root;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 26, 6));
  try {
    await chatPlugin.register(ctx);
    await check(async (action, data) => ctx.ipcChannels.get("ui")!(action, data));
  } finally {
    await ctx.dispose();
    await chatPlugin.unregister?.();
    vi.useRealTimers();
    if (path.dirname(realpathSync(root)) !== parentReal || !path.basename(root).startsWith("life-planning-")) throw new Error("测试目录越界");
    rmSync(root, { recursive: true, force: true });
  }
}

describe("生活规划实际插件入口", () => {
  it("默认不额外调用模型，手动规划通过现有模型服务且预算有界", async () => {
    const generateText = vi.fn().mockImplementation(async (messages) => validReply(messages));
    await withPlugin(generateText, async (invoke) => {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      const initial = await invoke("life-state");
      expect(initial.data.planning).toMatchObject({ enabled: false, busy: false, attempts: [], plans: [] });
      expect(generateText).not.toHaveBeenCalled();
      const result = await invoke("life-plan", { kind: "daily" });
      expect(result).toMatchObject({ ok: true, data: { status: "applied" } });
      expect(generateText).toHaveBeenCalledOnce();
      expect(generateText.mock.calls[0][1]).toMatchObject({ maxTokens: 4096, timeoutMs: 90_000, reasoning: "off" });
      const current = await invoke("life-state");
      expect(current.data.planning.plans).toHaveLength(1);
      expect(current.data.planning.enabled).toBe(false);
    });
  });

  it("非法类型和设置不能触发模型，自动开关可以从 IPC 保存", async () => {
    const generateText = vi.fn().mockImplementation(async (messages) => validReply(messages));
    await withPlugin(generateText, async (invoke) => {
      for (const data of [undefined, { kind: "diary" }, { kind: 1 }, { kind: null }]) {
        expect(await invoke("life-plan", data)).toMatchObject({ ok: false });
      }
      for (const enabled of [undefined, "true", 1, null]) {
        expect(await invoke("life-planning-settings", { enabled })).toMatchObject({ ok: false });
      }
      expect(generateText).not.toHaveBeenCalled();
      expect(await invoke("life-planning-settings", { enabled: true })).toMatchObject({ ok: true, data: { planning: { enabled: true } } });
      expect(await invoke("life-planning-settings", { enabled: false })).toMatchObject({ ok: true, data: { planning: { enabled: false } } });
    });
  });

  it("取消入口中止进行中的调用，重复请求不会再次调用模型", async () => {
    const generateText = vi.fn().mockImplementation((_messages, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("模拟取消")), { once: true });
    }));
    await withPlugin(generateText, async (invoke) => {
      const pending = invoke("life-plan", { kind: "daily" });
      await vi.waitFor(() => expect(generateText).toHaveBeenCalledOnce());
      const duplicate = await invoke("life-plan", { kind: "daily" });
      expect(duplicate.ok === false || duplicate.data?.status === "skipped").toBe(true);
      expect(await invoke("life-plan-cancel")).toMatchObject({ ok: true });
      expect(await pending).toMatchObject({ ok: true, data: { status: "cancelled" } });
      expect(generateText).toHaveBeenCalledOnce();
      expect((await invoke("life-state")).data.planning).toMatchObject({ busy: false, plans: [] });
    });
  });
});

describe("生活规划界面与 preload", () => {
  it("实际 preload 放行生活操作并拒绝未知动作", async () => {
    let bridge: any;
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    runInNewContext(readFileSync(path.resolve("plugins/companion-chat/static/preload.cjs"), "utf8"), {
      require: (name: string) => {
        if (name !== "electron") throw new Error("意外依赖");
        return { contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => { bridge = value; } }, ipcRenderer: { invoke } };
      },
    });
    for (const action of ["life-state", "life-planning-settings", "life-plan", "life-plan-cancel"]) {
      await bridge.invoke(action, { synthetic: true });
      expect(invoke).toHaveBeenLastCalledWith("plugin:companion-chat:ui", action, { synthetic: true });
    }
    await expect(bridge.invoke("arbitrary-write")).rejects.toThrow("操作未授权");
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it("打开生活面板只读取状态，文本安全渲染，生成期间禁止重复并可取消", async () => {
    const root = path.resolve("plugins/companion-chat/static");
    const dom = new JSDOM(readFileSync(path.join(root, "ui.html"), "utf8"), { runScripts: "outside-only" });
    const w = dom.window, calls: Array<{ action: string; data: any }> = [];
    w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    w.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new w.Event("close")); };
    const today = new Date();
    if (today.getHours() < 4) today.setDate(today.getDate() - 1);
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const life = { enabled: true, self: { energy: 70, focus: 60, restNeed: 20, activity: "读书" },
      planning: { enabled: false, busy: false, attempts: [], plans: [{ kind: "daily", date,
        windows: [{ startAt: Date.now(), endAt: Date.now() + 1800000, activities: ["<img src=x onerror=alert(1)>"] }] }], lastResult: null },
      continuity: { events: [{ date, text: "<script>unsafe()</script>", endAt: Date.now(), status: "inferred" }] } };
    let finish: ((value: any) => void) | undefined;
    w.companion = { invoke: async (action: string, data: any) => {
      calls.push({ action, data });
      if (action === "state") return { ok: true, data: { chat: { sessions: [] }, life } };
      if (action === "life-state") return { ok: true, data: life };
      if (action === "life-plan") { life.planning.busy = true; return new Promise((resolve) => { finish = resolve; }); }
      if (action === "life-plan-cancel") { life.planning.busy = false; finish?.({ ok: true, data: { status: "cancelled", message: "已取消" } }); return { ok: true, data: life }; }
      return { ok: false, error: "未预期的操作" };
    } };
    try {
      w.eval(readFileSync(path.join(root, "ui.js"), "utf8"));
      const el = (id: string) => w.document.getElementById(id) as any;
      await el("life-open").onclick();
      expect(calls.every((call) => ["state", "life-state"].includes(call.action))).toBe(true);
      expect(el("life-planning-enabled").checked).toBe(false);
      expect(el("life-plans").textContent).toContain("<img");
      expect(el("life-plans").querySelector("img")).toBeNull();
      expect(el("life-events").querySelector("script")).toBeNull();
      const pending = el("life-plan-daily").onclick();
      expect(el("life-plan-daily").disabled).toBe(true);
      expect(el("life-plan-refine").disabled).toBe(true);
      expect(el("life-plan-cancel").disabled).toBe(false);
      await el("life-plan-daily").onclick();
      expect(calls.filter((call) => call.action === "life-plan")).toHaveLength(1);
      await el("life-plan-cancel").onclick(); await pending;
      expect(el("life-result").textContent).toBe("已取消");
      el("life-close").onclick();
      expect(el("life-dialog").open).toBe(false);
    } finally { dom.window.close(); }
  });
});
