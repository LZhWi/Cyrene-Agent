import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createMockPluginContext } from "@playa0v0/cyrene-plugin-sdk/testing";
import type { PluginLlmService, PluginAssistantDeliveryService } from "@playa0v0/cyrene-plugin-sdk";
import chatPlugin from "../plugins/companion-chat/src/index";
import { CHAT_ID } from "../plugins/shared/protocol";

const { JSDOM } = require("jsdom");
type Invoke = (action: string, data?: unknown) => Promise<any>;

async function withPlugin(check: (invoke: Invoke) => Promise<void>, options: {
  generateText: PluginLlmService["generateText"];
  deliver: PluginAssistantDeliveryService["postProactiveMessage"];
}) {
  const parent = path.resolve(".test-runtime");
  mkdirSync(parent, { recursive: true });
  const parentReal = realpathSync(parent), root = mkdtempSync(path.join(parent, "life-sharing-"));
  const ctx = createMockPluginContext({ pluginId: CHAT_ID, deps: {
    llm: { generateText: options.generateText },
    assistantDelivery: { postProactiveMessage: options.deliver },
    userPresence: { snapshot: async () => ({ at: new Date().toISOString(), idleSeconds: 0, screenLocked: false }) },
  } });
  ctx.storage.rootDir = () => root;
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 26, 6));
  const random = vi.spyOn(Math, "random").mockReturnValue(0);
  try {
    await chatPlugin.register(ctx);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    await check(async (action, data) => ctx.ipcChannels.get("ui")!(action, data));
  } finally {
    await ctx.dispose(); await chatPlugin.unregister?.(); random.mockRestore(); vi.useRealTimers();
    if (path.dirname(realpathSync(root)) !== parentReal || !path.basename(root).startsWith("life-sharing-")) throw new Error("测试目录越界");
    rmSync(root, { recursive: true, force: true });
  }
}

async function startAutomaticShare(invoke: Invoke) {
  expect(await invoke("save-proactive-settings", { enabled: true })).toMatchObject({ ok: true });
  await vi.advanceTimersByTimeAsync(20 * 60_000);
}

describe("生活分享实际插件入口", () => {
  it("查看不调用模型，现有主动 sender 先记录待确认，收到回执后关联来源与消息", async () => {
    const generateText = vi.fn().mockResolvedValue('{"decision":"send","text":"刚才读了一会儿自己的故事书。"}');
    let finishDelivery: ((value: { conversationId: string; messageId: string; at: string }) => void) | undefined;
    const deliver = vi.fn().mockImplementation(() => new Promise((resolve) => { finishDelivery = resolve; }));
    await withPlugin(async (invoke) => {
      const initial = (await invoke("life-state")).data;
      const event = initial.continuity.events.find((item: any) => item.status === "materialized" && item.source === "runtime_schedule");
      expect(event).toBeDefined();
      expect(initial.sharing.records).toEqual([]);
      await invoke("state"); await invoke("life-state");
      expect(generateText).not.toHaveBeenCalled();
      await startAutomaticShare(invoke);
      expect(generateText).toHaveBeenCalledOnce(); expect(deliver).toHaveBeenCalledOnce();
      expect(generateText.mock.calls[0][1]).toMatchObject({ maxTokens: 2048, timeoutMs: 90_000 });
      expect(JSON.stringify(generateText.mock.calls[0][0]).includes(event.id)).toBe(true);
      expect((await invoke("life-state")).data.sharing.records).toEqual([expect.objectContaining({
        eventId: event.id, eventRevision: event.revision, status: "pending", receipt: null,
      })]);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(generateText).toHaveBeenCalledOnce(); expect(deliver).toHaveBeenCalledOnce();
      const receipt = { conversationId: "synthetic-proactive", messageId: "synthetic-shared-message", at: new Date().toISOString() };
      finishDelivery!(receipt);
      await vi.waitFor(async () => expect((await invoke("life-state")).data.sharing.records[0]).toMatchObject({ status: "delivered", receipt }));
    }, { generateText, deliver });
  });

  it("生成中撤销来源会取消请求，非法撤销不取消，迟到回复零投递", async () => {
    let finish: ((value: string) => void) | undefined, signal: AbortSignal | undefined;
    const generateText = vi.fn().mockImplementation((_messages, options) => {
      signal = options.signal;
      return new Promise<string>((resolve) => { finish = resolve; });
    });
    const deliver = vi.fn().mockResolvedValue({ conversationId: "synthetic", messageId: "must-not-deliver", at: "2026-09-26T04:20:00.000Z" });
    await withPlugin(async (invoke) => {
      const event = (await invoke("life-state")).data.continuity.events.find((item: any) => item.status === "materialized");
      await startAutomaticShare(invoke);
      expect(generateText).toHaveBeenCalledOnce(); expect(signal?.aborted).toBe(false);
      for (const id of [undefined, 0, "missing-synthetic-event"]) expect(await invoke("life-event-revoke", { id })).toMatchObject({ ok: false });
      expect(signal?.aborted).toBe(false);
      const revoked = await invoke("life-event-revoke", { id: event.id });
      expect(revoked).toMatchObject({ ok: true });
      expect(revoked.data.continuity.events.find((item: any) => item.id === event.id).status).toBe("revoked");
      expect(signal?.aborted).toBe(true);
      finish!('{"decision":"send","text":"这条迟到模拟消息不得投递。"}');
      await vi.waitFor(async () => expect((await invoke("state")).data.proactive.busy).toBe(false));
      expect(deliver).not.toHaveBeenCalled();
      expect((await invoke("life-state")).data.sharing.records).toEqual([]);
    }, { generateText, deliver });
  });

  it("手动主动测试仍使用原入口，不消耗生活分享来源", async () => {
    const generateText = vi.fn().mockResolvedValue('{"decision":"silent"}'), deliver = vi.fn();
    await withPlugin(async (invoke) => {
      expect(await invoke("send-proactive-test")).toMatchObject({ ok: true, data: { kind: "silent" } });
      expect(generateText).toHaveBeenCalledOnce(); expect(deliver).not.toHaveBeenCalled();
      expect((await invoke("life-state")).data.sharing.records).toEqual([]);
    }, { generateText, deliver });
  });

  it("关闭生活系统后已有记录不再触发生活分享", async () => {
    const generateText = vi.fn(), deliver = vi.fn();
    await withPlugin(async (invoke) => {
      expect(await invoke("save-life-settings", { enabled: false, importantDatesText: "" })).toMatchObject({ ok: true });
      await startAutomaticShare(invoke);
      expect(generateText).not.toHaveBeenCalled(); expect(deliver).not.toHaveBeenCalled();
      expect((await invoke("life-state")).data.sharing.records).toEqual([]);
    }, { generateText, deliver });
  });

  it("投递结果未知保留待确认标记，不自动重发同一生活来源", async () => {
    const generateText = vi.fn().mockResolvedValue('{"decision":"send","text":"刚才在模拟生活里休息了一会儿。"}');
    const deliver = vi.fn().mockRejectedValue(new Error("模拟回执丢失"));
    await withPlugin(async (invoke) => {
      await startAutomaticShare(invoke);
      expect(generateText).toHaveBeenCalledOnce(); expect(deliver).toHaveBeenCalledOnce();
      expect((await invoke("life-state")).data.sharing.records[0]).toMatchObject({ status: "pending", receipt: null });
      await vi.advanceTimersByTimeAsync(25 * 60_000);
      expect(generateText).toHaveBeenCalledOnce(); expect(deliver).toHaveBeenCalledOnce();
    }, { generateText, deliver });
  });
});

describe("生活分享界面边界", () => {
  it("实际 preload 仅放行撤销 IPC，不暴露分享预占或投递接口", async () => {
    let bridge: any;
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    runInNewContext(readFileSync(path.resolve("plugins/companion-chat/static/preload.cjs"), "utf8"), {
      require: () => ({ contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => { bridge = value; } }, ipcRenderer: { invoke } }),
    });
    await bridge.invoke("life-event-revoke", { id: "synthetic-event" });
    expect(invoke).toHaveBeenCalledWith("plugin:companion-chat:ui", "life-event-revoke", { id: "synthetic-event" });
    for (const action of ["life-share-reserve", "life-share-complete", "life-share-send"]) {
      await expect(bridge.invoke(action, {})).rejects.toThrow();
    }
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("来源正文与回执按纯文本显示，撤销操作明确传递事件 id", async () => {
    const root = path.resolve("plugins/companion-chat/static"), calls: Array<{ action: string; data: any }> = [];
    const dom = new JSDOM(readFileSync(path.join(root, "ui.html"), "utf8"), { runScripts: "outside-only" });
    const w = dom.window;
    w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    w.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new w.Event("close")); };
    const event = { id: "event-1", date: "2026-09-26", revision: 2, endAt: 1, text: "<img src=x onerror=alert(1)>", source: "runtime_schedule", status: "materialized" };
    const life = { enabled: true, continuity: { events: [event] }, sharing: { records: [
      { eventId: "event-1", eventRevision: 2, text: event.text, reservedAt: 2, status: "pending", receipt: null },
      { eventId: "event-older", eventRevision: 1, text: "<script>unsafe()</script>", reservedAt: 1, status: "delivered", receipt: { conversationId: "<b>conversation</b>", messageId: "synthetic-message" } },
    ] } };
    w.companion = { invoke: async (action: string, data: any) => {
      calls.push({ action, data });
      if (action === "state") return { ok: true, data: { chat: { sessions: [] }, life } };
      if (action === "life-event-revoke") event.status = "revoked";
      return { ok: true, data: life };
    } };
    try {
      w.eval(readFileSync(path.join(root, "ui.js"), "utf8"));
      const el = (id: string) => w.document.getElementById(id) as any;
      await el("life-open").onclick();
      expect(el("life-sharing").textContent).toContain("结果待确认，不自动重发");
      expect(el("life-sharing").textContent).toContain("已分享");
      expect(el("life-sharing").textContent).toContain("event-1 r2");
      expect(el("life-sharing").textContent).toContain("synthetic-message");
      expect(el("life-sharing").querySelector("script,img,b")).toBeNull();
      expect(el("life-events").querySelector("img")).toBeNull();
      await el("life-events").querySelector('[data-event-id="event-1"]').onclick();
      expect(calls.at(-1)).toEqual({ action: "life-event-revoke", data: { id: "event-1" } });
      expect(el("life-events").textContent).toContain("已撤销");
      expect(el("life-events").querySelector("button")).toBeNull();
      expect(el("life-sharing").textContent).toContain("结果待确认，不自动重发");
      el("life-close").onclick();
    } finally { dom.window.close(); }
  });
});
