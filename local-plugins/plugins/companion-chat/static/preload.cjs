const { contextBridge, ipcRenderer } = require("electron");
const allowed = new Set(["state", "save-model", "save-memory-link", "save-proactive-settings", "save-screen-monitor-settings", "save-life-settings", "life-state", "life-event-revoke", "life-planning-settings", "life-plan", "life-plan-cancel", "life-goal-save", "life-goal-status", "life-diary-rebuild", "life-date-reminder", "new", "send", "cancel", "sync", "memory", "extract", "send-proactive-test"]);
contextBridge.exposeInMainWorld("companion", {
  invoke: (action, data) => {
    if (!allowed.has(action)) return Promise.reject(new Error("操作未授权"));
    return ipcRenderer.invoke("plugin:companion-chat:ui", action, data);
  },
});
