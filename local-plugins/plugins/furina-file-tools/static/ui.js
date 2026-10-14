"use strict";
const el = (id) => document.getElementById(id);
let state;
let pending = false;
let polling;
const terminal = (job) => !job || ["completed", "failed", "cancelled"].includes(job.status);
const invoke = async (action, data) => {
  const result = await window.furina.invoke(action, data);
  if (!result.ok) throw new Error(result.error);
  return result.data;
};
function fields() {
  const tool = el("tool").value;
  for (const name of ["compress", "resize", "convert", "split"]) el(name + "-fields").hidden = tool !== (name === "split" ? "pdf-split" : "image-" + name);
  el("html-fields").hidden = !tool.startsWith("html-");
  el("html-render-fields").hidden = el("html-method").value === "extract";
  el("html-image-fields").hidden = tool !== "html-to-image";
  el("html-landscape-field").hidden = tool !== "html-to-pdf";
  el("operation-hint").textContent = tool === "image-compress" ? "压缩输出 JPEG，透明区域会铺白底。" : tool === "pdf-merge" ? "按下面的文件顺序合并，可使用上移、下移调整。" : tool === "image-resize" ? "至少填写宽度或高度；保持比例时，两项作为尺寸上限。" : "";
}
function request() {
  const tool = el("tool").value;
  const parameters = {};
  const integer = (id, key) => { if (el(id).value.trim()) parameters[key] = Number(el(id).value); };
  if (tool === "image-compress") { integer("quality", "quality"); integer("max-width", "max_width"); }
  if (tool === "image-resize") { integer("width", "width"); integer("height", "height"); parameters.keep_ratio = el("keep-ratio").checked; }
  if (tool === "image-convert") parameters.format = el("format").value;
  if (tool === "pdf-split") parameters.ranges = el("ranges").value.replace(/\s/g, "");
  if (tool.startsWith("html-")) {
    parameters.method = el("html-method").value;
    if (parameters.method === "render") {
      integer("html-wait", "wait_ms");
      if (tool === "html-to-image") { integer("html-width", "width"); integer("html-height", "height"); }
      else parameters.landscape = el("html-landscape").checked;
    }
  }
  return { tool, parameters };
}
function render(value) {
  state = value;
  const busy = pending || state.model.running || !terminal(state.job);
  el("workspace").textContent = state.workspace || "尚未选择工作区";
  el("files").replaceChildren();
  if (!state.inputs.length) { const li = document.createElement("li"); li.textContent = "尚未选择文件"; li.className = "hint"; el("files").append(li); }
  state.inputs.forEach((file, index) => {
    const li = document.createElement("li"); const span = document.createElement("span"); span.textContent = file; li.append(span);
    if (state.inputs.length > 1) for (const [label, direction] of [["上移", -1], ["下移", 1]]) {
      const button = document.createElement("button"); button.textContent = label; button.className = "secondary";
      button.disabled = busy || index + direction < 0 || index + direction >= state.inputs.length;
      button.addEventListener("click", () => perform("move-file", { index, direction })); li.append(button);
    }
    el("files").append(li);
  });
  for (const id of ["workspace-pick", "tool"]) el(id).disabled = busy;
  el("files-pick").disabled = busy || !state.workspace;
  el("direct").disabled = busy || !state.inputs.length;
  el("model").disabled = busy || !state.inputs.length || !state.modelAvailable;
  for (const id of ["quality", "max-width", "width", "height", "keep-ratio", "format", "ranges", "html-method", "html-width", "html-height", "html-landscape", "html-wait"]) el(id).disabled = busy;
  el("cancel").disabled = pending || (!state.model.running && terminal(state.job));
  el("model-unavailable").hidden = state.modelAvailable;
  const labels = { queued: "等待处理", processing: "正在处理", completed: "处理完成", failed: "处理失败", cancelled: "已取消" };
  el("status").textContent = state.model.running ? state.model.event || "模型正在处理" : state.job ? labels[state.job.status] : "准备就绪";
  el("error").textContent = state.model.error || (state.job && state.job.error) || "";
  el("model-text").hidden = !state.model.text;
  el("model-text").textContent = state.model.text;
  el("artifacts").replaceChildren();
  if (state.job && state.job.status === "completed") for (const artifact of state.job.artifacts) {
    const li = document.createElement("li"); const name = document.createElement("span"); name.textContent = artifact.path; li.append(name);
    const button = document.createElement("button"); button.textContent = "在文件夹中显示"; button.className = "secondary";
    button.addEventListener("click", () => perform("show-file", artifact.path)); li.append(button); el("artifacts").append(li);
  }
  clearTimeout(polling);
  if (!pending && (state.model.running || !terminal(state.job))) polling = setTimeout(refresh, 800);
}
async function refresh() {
  try { render(await invoke("state")); }
  catch (error) { el("error").textContent = error.message; }
}
async function perform(action, data) {
  if (pending) return;
  pending = true;
  if (state) render(state);
  try { const value = await invoke(action, data); pending = false; render(value); }
  catch (error) { pending = false; if (state) render(state); el("error").textContent = error.message; }
}
el("workspace-pick").addEventListener("click", () => perform("choose-workspace"));
el("files-pick").addEventListener("click", () => perform("choose-files", el("tool").value));
el("tool").addEventListener("change", fields);
el("html-method").addEventListener("change", fields);
el("direct").addEventListener("click", () => perform("submit", request()));
el("model").addEventListener("click", () => perform("model-start", request()));
el("cancel").addEventListener("click", () => perform("cancel"));
window.addEventListener("beforeunload", () => clearTimeout(polling));
fields();
refresh();
