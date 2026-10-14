import { describe, expect, it, vi } from "vitest";
import { createPluginWindowNavigationService } from "./window-navigation-service";

const modes = ["chat", "work", "code", "learn"] as const;
function fixture() {
  const rows = modes.map(mode => ({ id: mode, title: `${mode} session`, mode }));
  const windows = { openReactChatWindow: vi.fn(async () => null as never), openReactWorkspaceWindow: vi.fn(async () => null as never), createSettingsWindow: vi.fn() };
  const createSession = vi.fn((mode: typeof modes[number]) => ({ id: `new-${mode}`, title: "新对话", mode }));
  const controller = new AbortController();
  const service = createPluginWindowNavigationService({ listSessions: () => rows, createSession, windows, signal: controller.signal });
  return { rows, windows, createSession, controller, service };
}
describe("Plugin window navigation", () => {
  it.each(modes)("lists only %s metadata without messages", async mode => {
    const f = fixture();
    Object.assign(f.rows.find(row => row.mode === mode)!, { messages: ["private"], modelProfileId: "private-profile" });
    expect(await f.service.listSessions(mode)).toEqual([{ id: mode, title: `${mode} session`, mode }]);
  });
  it.each(modes)("routes an existing %s session to the matching window", async mode => {
    const f = fixture();
    expect(await f.service.open({ target: mode, session: "existing", sessionId: mode })).toEqual({ sessionId: mode });
    expect(mode === "chat" ? f.windows.openReactChatWindow : f.windows.openReactWorkspaceWindow).toHaveBeenCalledWith(mode);
    expect(mode === "chat" ? f.windows.openReactWorkspaceWindow : f.windows.openReactChatWindow).not.toHaveBeenCalled();
    expect(f.createSession).not.toHaveBeenCalled();
  });
  it.each(modes)("creates and opens an empty %s session through the host", async mode => {
    const f = fixture();
    expect(await f.service.open({ target: mode, session: "new" })).toEqual({ sessionId: `new-${mode}` });
    expect(f.createSession).toHaveBeenCalledExactlyOnceWith(mode);
    expect(mode === "chat" ? f.windows.openReactChatWindow : f.windows.openReactWorkspaceWindow).toHaveBeenCalledWith(`new-${mode}`);
  });
  it("opens settings without reading or creating sessions", async () => {
    const f = fixture();
    expect(await f.service.open({ target: "settings" })).toEqual({ sessionId: null });
    expect(f.windows.createSettingsWindow).toHaveBeenCalledOnce(); expect(f.createSession).not.toHaveBeenCalled();
  });
  it("lists and opens the existing proactive Chat session without creating or sending messages", async () => {
    const f = fixture(); Object.assign(f.rows[0], { purpose: "proactive-chat", messages: ["private"] });
    expect(await f.service.listSessions("chat")).toEqual([{ id: "chat", title: "chat session", mode: "chat" }]);
    expect(await f.service.open({ target: "chat", session: "existing", sessionId: "chat" })).toEqual({ sessionId: "chat" });
    expect(f.windows.openReactChatWindow).toHaveBeenCalledExactlyOnceWith("chat");
    expect(f.createSession).not.toHaveBeenCalled();
  });
  it("rejects missing and mismatched sessions without creating replacements", async () => {
    const f = fixture(); Object.assign(f.rows[0], { purpose: "proactive-chat" });
    for (const sessionId of ["missing", "work"]) await expect(f.service.open({ target: "chat", session: "existing", sessionId })).rejects.toMatchObject({ code: "E_NOT_FOUND" });
    expect(f.createSession).not.toHaveBeenCalled(); expect(f.windows.openReactChatWindow).not.toHaveBeenCalled();
  });
  it("rejects arbitrary targets and stopped calls before side effects", async () => {
    const f = fixture();
    await expect(f.service.open({ target: "shell", session: "new" } as never)).rejects.toMatchObject({ code: "E_INVALID_ARGUMENT" });
    await expect(f.service.open({ target: "code" })).rejects.toMatchObject({ code: "E_INVALID_ARGUMENT" });
    f.controller.abort();
    await expect(f.service.listSessions("chat")).rejects.toMatchObject({ code: "E_PLUGIN_STOPPING" });
    await expect(f.service.open({ target: "settings" })).rejects.toMatchObject({ code: "E_PLUGIN_STOPPING" });
    expect(f.createSession).not.toHaveBeenCalled(); expect(f.windows.createSettingsWindow).not.toHaveBeenCalled();
  });
  it("does not open a window when the plugin stops during session creation", async () => {
    const f = fixture(); f.createSession.mockImplementation(mode => { f.controller.abort(); return { id: "new", title: "new", mode }; });
    await expect(f.service.open({ target: "work", session: "new" })).rejects.toMatchObject({ code: "E_PLUGIN_STOPPING" });
    expect(f.windows.openReactWorkspaceWindow).not.toHaveBeenCalled();
  });
});
