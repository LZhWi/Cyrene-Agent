import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createMockPluginContext } from "@playa0v0/cyrene-plugin-sdk/testing";
import type { PluginLlmService } from "@playa0v0/cyrene-plugin-sdk";
import chatPlugin from "../plugins/companion-chat/src/index";
import { CHAT_ID } from "../plugins/shared/protocol";

const { JSDOM } = require("jsdom");

async function withPlugin(check: (invoke: (action: string, data?: unknown) => Promise<any>) => Promise<void>,
  options?: { generateText?: PluginLlmService["generateText"]; onDelivery?: () => void; recentTopic?: string }) {
  const parent = path.resolve(".test-runtime");
  mkdirSync(parent, { recursive: true });
  const parentReal = realpathSync(parent), root = mkdtempSync(path.join(parent, "life-journal-"));
  const generateText = options?.generateText ?? vi.fn().mockRejectedValue(new Error("日记与目标操作不应调用模型"));
  const ctx = createMockPluginContext({ pluginId: CHAT_ID, deps: { llm: { generateText }, assistantDelivery: {
    postProactiveMessage: async () => {
      options?.onDelivery?.();
      return { conversationId: "synthetic-life", messageId: "synthetic-delivery", at: new Date().toISOString() };
    },
  }, ...(options?.recentTopic ? { conversations: {
    list: async () => ({ items: [{ id: "synthetic-topic", title: "模拟话题", mode: "chat" as const,
      createdAt: "2026-09-25T22:00:00.000Z", updatedAt: "2026-09-25T22:00:00.000Z" }] }),
    getMessages: async () => ({ items: [{ id: "synthetic-topic-message", role: "user" as const,
      text: options.recentTopic!, at: "2026-09-25T22:00:00.000Z" }], range: {} }),
  } } : {}) } });
  ctx.storage.rootDir = () => root;
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 26, 6));
  try {
    await chatPlugin.register(ctx);
    await check(async (action, data) => ctx.ipcChannels.get("ui")!(action, data));
    if (!options?.generateText) expect(generateText).not.toHaveBeenCalled();
  } finally {
    await ctx.dispose(); await chatPlugin.unregister?.(); vi.useRealTimers();
    if (path.dirname(realpathSync(root)) !== parentReal || !path.basename(root).startsWith("life-journal-")) throw new Error("测试目录越界");
    rmSync(root, { recursive: true, force: true });
  }
}

describe("生活日记与目标实际插件入口", () => {
  it("目标需显式创建，支持修改、暂停恢复、手动完成和保留取消记录", async () => {
    await withPlugin(async (invoke) => {
      expect((await invoke("life-state")).data.journal.goals).toEqual([]);
      const created = await invoke("life-goal-save", { title: "继续阅读", activity: "读书", dueDate: "2026-09-28", remind: true });
      expect(created.ok).toBe(true);
      const goal = created.data.journal.goals[0];
      expect(goal).toMatchObject({ source: "user", status: "active", eventRefs: [] });
      expect(await invoke("life-goal-save", { id: goal.id, title: "阅读自己的故事书", activity: "读书", dueDate: "2026-09-29", remind: false }))
        .toMatchObject({ ok: true, data: { journal: { goals: [expect.objectContaining({ dueDate: "2026-09-29", remind: false })] } } });
      for (const status of ["paused", "active", "completed"]) {
        const result = await invoke("life-goal-status", { id: goal.id, status });
        expect(result.data.journal.goals[0].status).toBe(status);
      }
      const another = await invoke("life-goal-save", { title: "园艺", activity: "做园艺" });
      const anotherId = another.data.journal.goals.at(-1).id;
      const cancelled = await invoke("life-goal-status", { id: anotherId, status: "cancelled" });
      expect(cancelled.data.journal.goals).toHaveLength(2);
      expect(cancelled.data.journal.goals.at(-1).status).toBe("cancelled");
      for (let index = 0; index < 3; index++) expect((await invoke("life-goal-save", { title: `模拟目标${index}`, activity: "读书" })).ok).toBe(true);
      expect(await invoke("life-goal-save", { title: "超额目标", activity: "读书" })).toMatchObject({ ok: false });
      expect(await invoke("life-goal-status", { id: goal.id, status: "done" })).toMatchObject({ ok: false });
      expect(await invoke("life-goal-save", { title: "非法活动", activity: "操作真实设备" })).toMatchObject({ ok: false });
    });
  });

  it("日记重建保留事件引用，日期提醒关闭后可保存且非法参数不改变状态", async () => {
    await withPlugin(async (invoke) => {
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
      const rebuilt = await invoke("life-diary-rebuild", { date: "2026-09-26" });
      expect(rebuilt.ok).toBe(true);
      const diary = rebuilt.data.journal.diaries.find((item: any) => item.date === "2026-09-26");
      expect(diary.eventRefs.length).toBeGreaterThan(0);
      expect(diary.summary).toContain("模拟活动");
      expect((await invoke("life-diary-rebuild", { date: "2026-09-26" })).data.journal.diaries).toEqual(rebuilt.data.journal.diaries);
      await invoke("save-life-settings", { enabled: true, importantDatesText: "09-26 模拟纪念日" });
      const quiet = await invoke("life-date-reminder", { date: "09-26", label: "模拟纪念日", remind: false });
      expect(quiet).toMatchObject({ ok: true, data: { importantDates: [{ date: "09-26", label: "模拟纪念日", remind: false }] } });
      const repeated = await invoke("save-life-settings", { enabled: true, importantDatesText: "09-26 模拟纪念日" });
      expect(repeated.data.importantDates[0].remind).toBe(false);
      const before = (await invoke("life-state")).data;
      expect(await invoke("life-date-reminder", { date: "09-26", label: "模拟纪念日", remind: "false" })).toMatchObject({ ok: false });
      expect(await invoke("life-diary-rebuild", { date: "2026-02-30" })).toMatchObject({ ok: false });
      expect((await invoke("life-state")).data).toEqual(before);
    });
  });

  it("日记搜索通过实际插件入口按日期命中，并在事件撤销后重建索引", async () => {
    await withPlugin(async (invoke) => {
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
      const rebuilt = await invoke("life-diary-rebuild", { date: "2026-09-26" });
      const eventId = rebuilt.data.journal.diaries[0].eventRefs.at(-1).id;
      const before = await invoke("life-diary-search", { query: "2026-09-26" });
      expect(before.data).toMatchObject([{ date: "2026-09-26", diary: { source: "program" } }]);
      expect(before.data[0].events.some((event: { id: string }) => event.id === eventId)).toBe(true);
      expect((await invoke("life-event-revoke", { id: eventId })).ok).toBe(true);
      const after = await invoke("life-diary-search", { query: "2026-09-26" });
      expect(after.ok).toBe(true);
      expect(after.data.flatMap((hit: { events: Array<{ id: string }> }) => hit.events)
        .some((event: { id: string }) => event.id === eventId)).toBe(false);
    });
  });

  it("真实主动提示词过滤不提醒的目标与日期，同时保留允许提醒的项目", async () => {
    const generateText = vi.fn().mockResolvedValue('{"decision":"silent"}'), onDelivery = vi.fn();
    await withPlugin(async (invoke) => {
      await invoke("life-goal-save", { title: "静默目标甲", activity: "读书", remind: false });
      await invoke("life-goal-save", { title: "允许目标乙", activity: "读书", remind: true });
      await invoke("save-life-settings", { enabled: true, importantDatesText: "09-26 静默日期甲\n09-26 允许日期乙" });
      await invoke("life-date-reminder", { date: "09-26", label: "静默日期甲", remind: false });
      expect(await invoke("send-proactive-test")).toMatchObject({ ok: true, data: { kind: "silent" } });
      expect(generateText).toHaveBeenCalledOnce();
      const prompt = JSON.stringify(generateText.mock.calls[0][0]);
      expect(prompt.includes("静默目标甲")).toBe(false); expect(prompt.includes("静默日期甲")).toBe(false);
      expect(prompt.includes("允许目标乙")).toBe(true); expect(prompt.includes("允许日期乙")).toBe(true);
      expect(onDelivery).not.toHaveBeenCalled();
    }, { generateText, onDelivery, recentTopic: "最近目标进展" });
  });

  it.each(["life-date-reminder", "life-goal-save", "life-goal-status"])("%s 成功修改后中止旧主动生成，迟到 send 不投递", async (action) => {
    let finish: ((value: string) => void) | undefined;
    let signal: AbortSignal | undefined;
    const generateText = vi.fn().mockImplementation((_messages, options) => {
      signal = options.signal;
      return new Promise<string>((resolve) => { finish = resolve; });
    });
    const onDelivery = vi.fn();
    await withPlugin(async (invoke) => {
      const created = await invoke("life-goal-save", { title: "生成时的目标", activity: "读书", remind: true });
      const goalId = created.data.journal.goals[0].id;
      await invoke("save-life-settings", { enabled: true, importantDatesText: "09-26 生成时的日期" });
      const pending = invoke("send-proactive-test");
      await vi.waitFor(() => expect(generateText).toHaveBeenCalledOnce());
      expect(await invoke("life-date-reminder", { date: "09-26", label: "生成时的日期", remind: "invalid" })).toMatchObject({ ok: false });
      expect(signal?.aborted).toBe(false);
      const data = action === "life-date-reminder" ? { date: "09-26", label: "生成时的日期", remind: false }
        : action === "life-goal-save" ? { id: goalId, title: "生成时的目标", activity: "读书", remind: false }
          : { id: goalId, status: "cancelled" };
      expect(await invoke(action, data)).toMatchObject({ ok: true });
      expect(signal?.aborted).toBe(true);
      finish!('{"decision":"send","text":"旧提示词产生的模拟消息"}');
      expect(await pending).toMatchObject({ ok: true, data: { kind: "stale" } });
      expect(onDelivery).not.toHaveBeenCalled();
    }, { generateText, onDelivery });
  });
});

describe("生活日记与目标界面", () => {
  it("实际 preload 放行生活管理与检索动作", async () => {
    let bridge: any;
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    runInNewContext(readFileSync(path.resolve("plugins/companion-chat/static/preload.cjs"), "utf8"), {
      require: () => ({ contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => { bridge = value; } }, ipcRenderer: { invoke } }),
    });
    for (const action of ["life-goal-save", "life-goal-status", "life-diary-rebuild", "life-diary-search", "life-date-reminder"]) {
      await bridge.invoke(action, { synthetic: true });
      expect(invoke).toHaveBeenLastCalledWith("plugin:companion-chat:ui", action, { synthetic: true });
    }
    expect(invoke).toHaveBeenCalledTimes(5);
  });

  it("安全展示目标和日记，编辑与管理动作传递明确参数且不自动创建目标", async () => {
    const root = path.resolve("plugins/companion-chat/static"), calls: Array<{ action: string; data: any }> = [];
    const dom = new JSDOM(readFileSync(path.join(root, "ui.html"), "utf8"), { runScripts: "outside-only" });
    const w = dom.window;
    w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    w.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new w.Event("close")); };
    const life = { enabled: true, activities: ["读书", "做园艺"], planning: { enabled: false, busy: false, plans: [], attempts: [] },
      importantDates: [{ date: "09-26", label: "<img src=x>", remind: true }],
      continuity: { events: [{ id: "event-1", date: "2026-09-26", revision: 1, endAt: 1, text: "读书", source: "runtime_schedule", status: "materialized" }] },
      journal: { goals: [{ id: "goal-1", title: "<img src=x onerror=alert(1)>", activity: "读书", dueDate: "2026-09-29", remind: true, status: "active", eventRefs: [{ id: "event-1", revision: 1 }] }],
        diaries: Array.from({ length: 8 }, (_, index) => ({ date: `2026-09-${String(index + 1).padStart(2, "0")}`, summary: "<script>unsafe()</script>", eventRefs: [{ id: "event-1", revision: 1 }], status: "active" })) } };
    w.companion = { invoke: async (action: string, data: any) => {
      calls.push({ action, data });
      if (action === "state") return { ok: true, data: { chat: { sessions: [] }, life } };
      if (action === "life-goal-save") Object.assign(life.journal.goals[0], data);
      if (action === "life-goal-status") life.journal.goals[0].status = data.status;
      if (action === "life-date-reminder") life.importantDates[0].remind = data.remind;
      if (action === "life-diary-search") return { ok: true, data: [{ date: "2026-09-26",
        diary: { source: "model", summary: "<script>unsafe()</script>" }, events: [{ text: "散步", status: "inferred" }] }] };
      return { ok: true, data: life };
    } };
    try {
      w.eval(readFileSync(path.join(root, "ui.js"), "utf8"));
      const el = (id: string) => w.document.getElementById(id) as any;
      await el("life-open").onclick();
      expect(calls.every((call) => ["state", "life-state"].includes(call.action))).toBe(true);
      expect(el("life-goals").textContent).toContain("不表示目标完成");
      expect(el("life-goals").querySelector("img")).toBeNull();
      expect(el("life-dates").querySelector("img")).toBeNull();
      expect(el("life-diaries").querySelector("script")).toBeNull();
      expect(el("life-diaries").children).toHaveLength(7);
      expect(el("life-diaries").textContent).toContain("已发生模拟 1");
      const goalAction = (action: string) => el("life-goals").querySelector(`[data-goal-id="goal-1"][data-action="${action}"]`);
      goalAction("edit").onclick();
      expect(el("life-goal-title").value).toContain("<img");
      el("life-goal-title").value = "修改后的模拟目标"; el("life-goal-due").value = "2026-09-30"; el("life-goal-remind").checked = false;
      await el("life-goal-form").onsubmit({ preventDefault() {} });
      expect(calls).toContainEqual({ action: "life-goal-save", data: { id: "goal-1", title: "修改后的模拟目标", activity: "读书", dueDate: "2026-09-30", remind: false } });
      await goalAction("pause-resume").onclick();
      expect(calls.at(-1)).toEqual({ action: "life-goal-status", data: { id: "goal-1", status: "paused" } });
      await goalAction("pause-resume").onclick();
      expect(calls.at(-1)?.data.status).toBe("active");
      const dateCheckbox = el("life-dates").querySelector("input"); dateCheckbox.checked = false; await dateCheckbox.onchange();
      expect(calls.at(-1)).toEqual({ action: "life-date-reminder", data: { date: "09-26", label: "<img src=x>", remind: false } });
      el("life-diary-date").value = "2026-09-26"; await el("life-diary-rebuild").onclick();
      expect(calls.at(-1)).toEqual({ action: "life-diary-rebuild", data: { date: "2026-09-26" } });
      el("life-diary-search").value = "2026-09-26";
      await el("life-diary-search-form").onsubmit({ preventDefault() {} });
      expect(calls.at(-1)).toEqual({ action: "life-diary-search", data: { query: "2026-09-26" } });
      expect(el("life-diary-search-results").textContent).toContain("离线推演");
      expect(el("life-diary-search-results").querySelector("script")).toBeNull();
      await goalAction("cancel").onclick();
      expect(el("life-goals").textContent).toContain("已取消");
      expect(el("life-goals").children).toHaveLength(1);
      expect(calls.some((call) => call.action === "life-plan")).toBe(false);
      el("life-close").onclick();
    } finally { dom.window.close(); }
  });
});
