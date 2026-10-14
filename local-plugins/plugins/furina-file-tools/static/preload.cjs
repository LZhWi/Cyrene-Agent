const { contextBridge, ipcRenderer } = require("electron");
const actions = new Set(["state", "choose-workspace", "choose-files", "move-file", "submit", "model-start", "cancel", "show-file"]);
contextBridge.exposeInMainWorld("furina", {
  invoke(action, data) {
    if (!actions.has(action)) return Promise.reject(new Error("操作未授权"));
    return ipcRenderer.invoke("plugin:furina-file-tools:ui", action, data);
  },
});
