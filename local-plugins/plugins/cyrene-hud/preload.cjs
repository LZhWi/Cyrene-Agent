"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const { createUpstreamNavigation } = require("./navigation-upstream.cjs");
const { readStatus } = require("./status.cjs");
const { readProactive } = require("./notifications.cjs");
const edition = "local";
const upstream = createUpstreamNavigation((channel, ...args) => ipcRenderer.invoke(channel, ...args), channel => ipcRenderer.send(channel));
let opening;
const listen = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld("cyreneHud", {
  // Fixed endpoints only; no generic IPC, shell or model access.
  snapshot: () => ipcRenderer.invoke("plugin:cyrene-hud:snapshot"),
  status: () => readStatus(channel => ipcRenderer.invoke(channel)),
  state: () => ipcRenderer.invoke("plugin:cyrene-hud:state"),
  save: value => ipcRenderer.invoke("plugin:cyrene-hud:save", value),
  preview: () => ipcRenderer.invoke("plugin:cyrene-hud:preview"),
  testUi: action => ipcRenderer.invoke("plugin:cyrene-hud:ui-test", action),
  listSessions: mode => edition === "local" ? ipcRenderer.invoke("plugin:cyrene-hud:list-sessions", mode) : upstream.listSessions(mode),
  openTarget: () => {
    if (opening) return opening;
    opening = ipcRenderer.invoke("plugin:cyrene-hud:state").then(state => state.testing ? undefined : edition === "local" ? ipcRenderer.invoke("plugin:cyrene-hud:open-target") : upstream.open(state.config))
      .finally(() => { opening = undefined; });
    return opening;
  },
  openNotification: async () => {
    const target = await ipcRenderer.invoke("plugin:cyrene-hud:notification-target");
    if (!target) return;
    if (edition === "local") return ipcRenderer.invoke("plugin:cyrene-hud:notification-open", target);
    await upstream.open({ avatarTarget: "chat", avatarSession: "existing", avatarSessionId: target.sessionId });
    await ipcRenderer.invoke("plugin:cyrene-hud:notification-read", target);
  },
  avatarHover: value => ipcRenderer.invoke("plugin:cyrene-hud:avatar-hover", value),
  reducedMotion: value => ipcRenderer.invoke("plugin:cyrene-hud:reduced-motion", value),
  detailWidths: value => ipcRenderer.invoke("plugin:cyrene-hud:detail-widths", value),
  onLayout: callback => listen("plugin:cyrene-hud:layout", callback),
  onChange: callback => listen("plugin:cyrene-hud:changed", callback),
  onVisibility: callback => listen("plugin:cyrene-hud:visibility", callback),
  onSnapshot: callback => listen("plugin:cyrene-hud:snapshot", callback),
});
// Only the overlay watches deliveries. The settings window never reads messages.
if (location.pathname.endsWith("/hud.html")) {
  let running = false, dirty = false, disposed = false;
  async function refresh() {
    dirty = true;
    if (running || disposed) return;
    running = true;
    try {
      do {
        dirty = false;
        const cursor = await ipcRenderer.invoke("plugin:cyrene-hud:notification-checkpoint");
        const batch = await readProactive((channel, payload) => ipcRenderer.invoke(channel, payload), cursor);
        if (!disposed) await ipcRenderer.invoke("plugin:cyrene-hud:notification-batch", batch);
      } while (dirty && !disposed);
    } catch { /* Host unavailable: keep the last unread state and retry later. */ }
    finally { running = false; }
  }
  const remove = listen("chats:changed", refresh), timer = setInterval(refresh, 5000);
  window.addEventListener("DOMContentLoaded", refresh, { once: true });
  window.addEventListener("unload", () => { disposed = true; remove(); clearInterval(timer); }, { once: true });
}
