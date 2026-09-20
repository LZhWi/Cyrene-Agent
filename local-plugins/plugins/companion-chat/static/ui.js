const $ = (id) => document.getElementById(id);
let selected;
let busy = false;
let memoryEnabled = false;
let proactiveEnabled = false;
let feedbackLearningEnabled = false;
let screenMonitorEnabled = false;
let lifeSettings = { enabled: true, importantDatesText: "" };
async function invoke(action, data) {
  const result = await window.companion.invoke(action, data);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
function status(text) { $("status").textContent = text; }
function controls() { $("send").disabled = busy; $("new").disabled = busy; $("extract").disabled = busy || !memoryEnabled; $("sync").disabled = busy || !memoryEnabled; $("proactive-test").disabled = busy; $("cancel").disabled = !busy; }
function render(state) {
  if (!state.sessions.some((s) => s.id === selected)) selected = state.sessions.at(-1)?.id;
  $("sessions").replaceChildren(); $("messages").replaceChildren();
  for (const s of state.sessions) {
    const button = document.createElement("button"); button.textContent = s.title;
    button.className = s.id === selected ? "selected" : "";
    button.onclick = () => { selected = s.id; render(state); };
    $("sessions").append(button);
  }
  for (const m of state.sessions.find((s) => s.id === selected)?.messages ?? []) {
    const article = document.createElement("article"); article.className = `message ${m.role}`;
    const time = document.createElement("time"); time.textContent = `${m.role === "user" ? "你" : "助手"} · ${new Date(m.at).toLocaleString()}${m.status && m.status !== "complete" ? " · " + ({ pending: "未完成（不作为成功对话）", failed: "生成失败", cancelled: "已取消" }[m.status]) : ""}`;
    const body = document.createElement("div"); body.textContent = m.text;
    article.append(time, body); $("messages").append(article);
  }
  $("messages").scrollTop = $("messages").scrollHeight;
  controls();
}
async function refresh() {
  const result = await invoke("state");
  memoryEnabled = Boolean(result.memoryEnabled); proactiveEnabled = Boolean(result.proactive?.enabled);
  feedbackLearningEnabled = Boolean(result.proactive?.feedbackLearningEnabled);
  screenMonitorEnabled = Boolean(result.screenMonitor?.enabled);
  lifeSettings = result.life ?? lifeSettings;
  $("proactive-state").textContent = `${proactiveEnabled ? "自动主动消息已开启" : "自动主动消息已关闭"} · 连续未回复 ${result.proactive?.unansweredCount ?? 0}/2${result.proactive?.busy ? " · 正在生成" : ""}`;
  render(result.chat); return result;
}
$("new").onclick = async () => { try { selected = await invoke("new"); await refresh(); } catch (e) { status(e.message); } };
$("composer").onsubmit = async (event) => {
  event.preventDefault(); if (busy || !$("input").value.trim()) return;
  const text = $("input").value; busy = true; controls(); status("正在检索记忆并生成回复…");
  try {
    if (!selected) selected = await invoke("new");
    const result = await invoke("send", { sessionId: selected, text });
    $("input").value = ""; status(result.warning || "回复与记忆档案已保存。");
  } catch (e) { status(e.message); }
  finally { busy = false; await refresh().catch((e) => status(e.message)); controls(); }
};
$("cancel").onclick = async () => { await invoke("cancel"); status("正在取消…"); };
$("sync").onclick = async () => { try { await invoke("sync"); status("记忆同步完成。"); } catch (e) { status(e.message); } };
$("extract").onclick = async () => {
  if (!confirm("将本插件待处理对话发送给当前所选模型，提取长期记忆。继续吗？")) return;
  busy = true; controls(); status("正在提取记忆；失败批次会保留。");
  try { const result = await invoke("extract"); status(`已提取 ${result.batches} 批，剩余 ${result.pending} 轮（不足 10 轮留待后续）。`); }
  catch (e) { status(e.message); } finally { busy = false; controls(); }
};
$("proactive-test").onclick = async () => {
  if (!confirm("将调用当前所选模型生成一条消息，并写入原生主动消息会话。继续吗？")) return;
  busy = true; controls(); status("正在生成主动消息…");
  try {
    const result = await invoke("send-proactive-test");
    status(result.kind === "committed" ? `主动消息已写入原生会话（消息 ${result.messageId}）。` : "模型判断此刻不适合主动打扰，未发送消息。");
  } catch (e) { status(e.message); }
  finally { busy = false; controls(); }
};
function modelFields() { $("reuse-fields").hidden = $("mode").value !== "host"; $("custom-fields").hidden = $("mode").value !== "custom"; $("source-label").hidden = $("reuse").value !== "file"; }
$("mode").onchange = modelFields; $("reuse").onchange = modelFields;
$("settings").onclick = async () => {
  try {
    const { model, life } = await refresh();
    for (const [id, key] of [["mode","mode"],["reuse","reuse"],["source-path","sourcePath"],["base-url","baseUrl"],["model","model"],["persona-style","personaStyle"],["system-prompt","systemPrompt"]]) $(id).value = model[key];
    $("memory-enabled").checked = memoryEnabled;
    $("proactive-enabled").checked = proactiveEnabled;
    $("feedback-learning-enabled").checked = feedbackLearningEnabled;
    $("screen-monitor-enabled").checked = screenMonitorEnabled;
    $("life-enabled").checked = life.enabled;
    $("important-dates").value = life.importantDatesText;
    $("api-key").value = ""; $("key-state").textContent = model.hasCustomKey ? "已保存自定义密钥（不回显）" : "尚未保存自定义密钥";
    $("model-status").textContent = ""; modelFields(); $("model-dialog").showModal();
  } catch (e) { status(e.message); }
};
$("close-settings").onclick = () => { $("api-key").value = ""; $("model-dialog").close(); };
$("model-dialog").addEventListener("close", () => { $("api-key").value = ""; });
$("model-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await invoke("save-model", { mode: $("mode").value, reuse: $("reuse").value, sourcePath: $("source-path").value, baseUrl: $("base-url").value, model: $("model").value, personaStyle: $("persona-style").value, apiKey: $("api-key").value, systemPrompt: $("system-prompt").value });
    const link = await invoke("save-memory-link", { enabled: $("memory-enabled").checked }); memoryEnabled = link.enabled;
    const proactive = await invoke("save-proactive-settings", {
      enabled: $("proactive-enabled").checked,
      feedbackLearningEnabled: $("feedback-learning-enabled").checked,
    });
    proactiveEnabled = proactive.enabled; feedbackLearningEnabled = proactive.feedbackLearningEnabled;
    const screenMonitor = await invoke("save-screen-monitor-settings", { enabled: $("screen-monitor-enabled").checked }); screenMonitorEnabled = screenMonitor.enabled;
    lifeSettings = await invoke("save-life-settings", { enabled: $("life-enabled").checked, importantDatesText: $("important-dates").value });
    $("api-key").value = ""; $("model-dialog").close();
    await refresh();
    status("模型来源已保存；原主程序配置未修改。");
  } catch (e) { $("model-status").textContent = e.message; }
};
refresh().catch((e) => status(e.message));
