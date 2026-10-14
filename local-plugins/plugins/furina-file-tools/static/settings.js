"use strict";
const source = document.getElementById("source");
const python = document.getElementById("python");
const status = document.getElementById("status");
window.CyrenePanel.invoke("connection-get").then((value) => {
  source.value = value.sourceRoot;
  python.value = value.python;
}).catch((error) => { status.textContent = error.message; });
document.getElementById("save").addEventListener("click", async () => {
  try {
    await window.CyrenePanel.invoke("connection-save", { sourceRoot: source.value.trim(), python: python.value.trim() });
    status.textContent = "已保存。首次调用文件工具时自动启动本机服务。";
  } catch (error) { status.textContent = error.message; }
});
document.getElementById("open-panel").addEventListener("click", async () => {
  try { await window.CyrenePanel.invoke("open-panel"); }
  catch (error) { status.textContent = error.message; }
});
