import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getAppPath: () => process.cwd() }, screen: {},
  BrowserWindow: class extends EventEmitter {
    webContents = new EventEmitter();
    isDestroyed() { return false; }
  },
}));
vi.mock("../env", () => ({ isDev: false }));
vi.mock("../window-layout", () => ({ computeLayout: () => ({ chat: { x: 0, y: 0 } }) }));
vi.mock("../call/call-manager", () => ({ stopCall: vi.fn(), setCallWindow: vi.fn() }));
vi.mock("../plugin-host/active-chat-target", () => ({ activeChatTargetRegistry: { focusSender: vi.fn() } }));
vi.mock("./external-link", () => ({ attachExternalLinkHandler: vi.fn() }));

import { createReactChatWindowShell, createReactWorkspaceWindowShell } from "./create-aux-windows";
import { reactChatSession, reactWorkspaceSession, setReactChatWindow, setReactWorkspaceWindow } from "./window-state";

afterEach(() => { setReactChatWindow(null); setReactWorkspaceWindow(null); reactChatSession.reset(); reactWorkspaceSession.reset(); });

describe("React window navigation readiness", () => {
  it.each(["chat", "workspace"] as const)("keeps %s ready on same-document and subframe navigation", (kind) => {
    const window = kind === "chat" ? createReactChatWindowShell() : createReactWorkspaceWindowShell();
    const dispatcher = kind === "chat" ? reactChatSession : reactWorkspaceSession;
    dispatcher.markReady();
    window.webContents.emit("did-start-loading");
    window.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    expect(dispatcher.queueOrTake("next")).toBe("next");
    window.webContents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    expect(dispatcher.isReady()).toBe(true);
    window.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(dispatcher.queueOrTake("reload-target")).toBeNull();
    expect(dispatcher.markReady()).toBe("reload-target");
  });
});
