import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as { JSDOM: new (html: string, options: { runScripts: string }) => { window: Window & typeof globalThis } };
const { createUpstreamNavigation } = require("../plugins/cyrene-hud/navigation-upstream.cjs");
const modes = ["chat", "work", "code", "learn"];
function fixture() {
  const rows = modes.map(mode => ({ id: mode, title: mode, mode, messages: ["private"] }));
  const invoke = vi.fn(async (channel: string, input: any): Promise<unknown> => channel === "chats:list" ? rows : channel === "chats:create" ? { id: `new-${input.mode}`, mode: input.mode, messages: [] } : true);
  return { rows, invoke, navigation: createUpstreamNavigation(invoke) };
}
describe("Upstream HUD navigation adapter", () => {
  it.each(modes)("uses only metadata and fixed IPC to open an existing %s session", async mode => {
    const f = fixture();
    expect(await f.navigation.listSessions(mode)).toEqual([{ id: mode, title: mode, mode }]);
    expect(await f.navigation.open({ avatarTarget: mode, avatarSession: "existing", avatarSessionId: mode })).toEqual({ sessionId: mode });
    expect(f.invoke).toHaveBeenLastCalledWith("chats:open-in-react-window", mode);
    expect(f.invoke.mock.calls.some(([channel]) => channel === "chats:create")).toBe(false);
  });
  it.each(modes)("creates a %s session only when explicitly selected", async mode => {
    const f = fixture();
    expect(await f.navigation.open({ avatarTarget: mode, avatarSession: "new" })).toEqual({ sessionId: `new-${mode}` });
    expect(f.invoke.mock.calls).toEqual([["chats:create", { mode }], ["chats:open-in-react-window", `new-${mode}`]]);
  });
  it("keeps no-action disabled and reuses settings IPC without conversations", async () => {
    const f = fixture(); await f.navigation.open({ avatarTarget: "none" });
    expect(f.invoke).not.toHaveBeenCalled();
    await f.navigation.open({ avatarTarget: "settings" }); expect(f.invoke).toHaveBeenCalledExactlyOnceWith("settings:request-switch-section");
  });
  it("includes and opens the proactive Chat session without exposing its messages", async () => {
    const f = fixture(); Object.assign(f.rows[0], { purpose: "proactive-chat" });
    expect(await f.navigation.listSessions("chat")).toEqual([{ id: "chat", title: "chat", mode: "chat" }]);
    expect(await f.navigation.open({ avatarTarget: "chat", avatarSession: "existing", avatarSessionId: "chat" })).toEqual({ sessionId: "chat" });
    expect(f.invoke).toHaveBeenLastCalledWith("chats:open-in-react-window", "chat");
    expect(f.invoke.mock.calls.some(([channel]) => channel === "chats:create")).toBe(false);
  });
  it("falls back to the local fixed settings event only when the upstream handler is absent", async () => {
    const invoke = vi.fn(async () => { throw Error("Error invoking remote method 'settings:request-switch-section': Error: No handler registered for 'settings:request-switch-section'"); });
    const send = vi.fn();
    const navigation = createUpstreamNavigation(invoke, send);
    await expect(navigation.open({ avatarTarget: "settings" })).resolves.toEqual({ sessionId: null });
    expect(send).toHaveBeenCalledExactlyOnceWith("sidebar:open-settings");
    send.mockClear();
    invoke.mockImplementation(async () => { throw Error("Settings failed to load"); });
    await expect(navigation.open({ avatarTarget: "settings" })).rejects.toThrow("Settings failed to load");
    expect(send).not.toHaveBeenCalled();
    invoke.mockImplementation(async () => false as never);
    await expect(navigation.open({ avatarTarget: "settings" })).rejects.toThrow("未接受");
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects arbitrary targets, wrong modes and deleted sessions without replacement", async () => {
    const f = fixture();
    await expect(f.navigation.open({ avatarTarget: "shell" })).rejects.toThrow();
    for (const avatarSessionId of ["work", "missing"]) await expect(f.navigation.open({ avatarTarget: "chat", avatarSession: "existing", avatarSessionId })).rejects.toThrow("所选会话");
    expect(f.invoke.mock.calls.every(([channel]) => channel === "chats:list")).toBe(true);
  });
  it("reports unsupported IPC and refused open requests", async () => {
    const f = fixture(); f.invoke.mockImplementation(async () => { throw Error("No handler"); });
    await expect(f.navigation.open({ avatarTarget: "code", avatarSession: "new" })).rejects.toThrow("No handler");
    f.invoke.mockImplementation(async (channel, input) => channel === "chats:create" ? { id: "new", mode: input.mode } : false);
    await expect(f.navigation.open({ avatarTarget: "code", avatarSession: "new" })).rejects.toThrow("未接受");
  });
});

it("keeps an unsaved session selection when background sampling publishes state", async () => {
  const { normalizeSettings } = require("../plugins/cyrene-hud/settings.cjs");
  const dom = new JSDOM(readFileSync(new URL("../plugins/cyrene-hud/settings.html", import.meta.url), "utf8"), { runScripts: "outside-only" });
  const state = { config: normalizeSettings({}), displays: [], materialSupported: true, glassStatus: "off", powerPaused: false, edition: "local" };
  let onChange: (state: any) => void = () => {};
  const save = vi.fn(async config => ({ ...state, config }));
  (dom.window as any).cyreneHud = { state: async () => state, onChange: (fn: typeof onChange) => { onChange = fn; }, listSessions: async () => [{ id: "selected", title: "Selected", mode: "work" }], save };
  try {
    dom.window.eval(readFileSync(new URL("../plugins/cyrene-hud/metrics.js", import.meta.url), "utf8"));
    dom.window.eval(readFileSync(new URL("../plugins/cyrene-hud/settings.js", import.meta.url), "utf8"));
    const byId = (id: string) => dom.window.document.getElementById(id) as HTMLSelectElement;
    await vi.waitFor(() => expect(byId("avatarTarget").value).toBe("none"));
    byId("avatarSession").value = "existing";
    byId("avatarTarget").value = "work";
    byId("avatarTarget").dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(Array.from(byId("avatarSessionId").options).some(option => option.value === "selected")).toBe(true));
    byId("avatarSessionId").value = "selected";
    onChange(state);
    expect(byId("avatarTarget").value).toBe("work");
    expect(byId("avatarSessionId").value).toBe("selected");
    byId("form").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(byId("feedback").textContent).toBe("已保存"));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ avatarTarget: "work", avatarSession: "existing", avatarSessionId: "selected" }));
    onChange(state);
    expect(byId("avatarTarget").value).toBe("none");
  } finally { dom.window.close(); }
});
