const { contextBridge, ipcRenderer } = require("electron");
const actions = new Set(["state", "connect", "submit", "answer", "cancel", "sync", "explain"]);
contextBridge.exposeInMainWorld("codexBridge", {
  invoke(action, data) {
    if (!actions.has(action)) return Promise.reject(new Error("不支持的操作"));
    return ipcRenderer.invoke("plugin:codex-bridge:ui", action, data);
  },
});
