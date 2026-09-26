const $ = (id) => document.getElementById(id);
let selected;
let busy = false;
let memoryEnabled = false;
let proactiveEnabled = false;
let feedbackLearningEnabled = false;
let screenMonitorEnabled = false;
let lifeSettings = { enabled: true, importantDatesText: "" };
let lifeActionPending = false;
let lifeSettingsPending = false;
let lifeRefreshTimer;
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
  if ($("life-dialog").open) renderLife();
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
    for (const [id, key] of [["mode","mode"],["reuse","reuse"],["source-path","sourcePath"],["base-url","baseUrl"],["model","model"],["system-prompt","systemPrompt"]]) $(id).value = model[key];
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
    await invoke("save-model", { mode: $("mode").value, reuse: $("reuse").value, sourcePath: $("source-path").value, baseUrl: $("base-url").value, model: $("model").value, apiKey: $("api-key").value, systemPrompt: $("system-prompt").value });
    $("api-key").value = ""; $("model-dialog").close();
    await refresh();
    status("模型来源已保存；原主程序配置未修改。");
  } catch (e) { $("model-status").textContent = e.message; }
};
function lifeDate() {
  const date = new Date();
  if (date.getHours() < 4) date.setDate(date.getDate() - 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function renderLife() {
  const self = lifeSettings.self ?? {};
  const planning = lifeSettings.planning ?? {};
  const planningBusy = lifeActionPending || Boolean(planning.busy);
  const today = lifeDate();
  const attempts = (planning.attempts ?? []).filter((attempt) => attempt.date === today);
  const daily = attempts.filter((attempt) => attempt.kind === "daily").length;
  const refine = attempts.filter((attempt) => attempt.kind === "refine").length;
  $("life-current").textContent = lifeSettings.enabled ? `当前：${self.activity ?? "休息中"}` : "生活系统已关闭，可在主程序偏好设置中开启。";
  $("life-metrics").textContent = `精力 ${self.energy ?? "—"} / 100 · 专注 ${self.focus ?? "—"} / 100 · 休息需要 ${self.restNeed ?? "—"} / 100`;
  $("life-planning-enabled").checked = Boolean(planning.enabled);
  $("life-planning-enabled").disabled = !lifeSettings.enabled || lifeSettingsPending;
  $("life-budget").textContent = `今日已调用：日程 ${daily}/1 · 细化 ${refine}/2${planningBusy ? " · 正在生成" : ""}`;
  $("life-plan-daily").disabled = !lifeSettings.enabled || planningBusy || lifeSettingsPending || busy || daily >= 1;
  $("life-plan-refine").disabled = !lifeSettings.enabled || planningBusy || lifeSettingsPending || busy || refine >= 2;
  $("life-plan-cancel").disabled = !planningBusy;
  $("life-result").textContent = planning.lastResult?.message ?? "尚未请求模型规划，当前使用本地生活日程。";
  $("life-plans").replaceChildren();
  for (const plan of (planning.plans ?? []).filter((item) => item.date === today)) {
    const row = document.createElement("p");
    row.textContent = `${plan.kind === "refine" ? "临近细化" : "日程规划"}：${plan.windows.map((window) => {
      const time = (at) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      return `${time(window.startAt)}–${time(window.endAt)} ${window.activities.join("、")}`;
    }).join("；")}`;
    $("life-plans").append(row);
  }
  if (!$("life-plans").childElementCount) $("life-plans").textContent = "今日尚无模型计划，继续使用本地日程。";
  $("life-events").replaceChildren();
  for (const event of [...(lifeSettings.continuity?.events ?? [])].sort((a, b) => b.endAt - a.endAt).slice(0, 6)) {
    const row = document.createElement("p");
    const source = event.status === "revoked" ? "已撤销" : event.status === "inferred" ? "离线推演"
      : event.source === "legacy_schedule" ? "旧版模拟记录" : "已发生的模拟活动";
    row.textContent = `${event.date} · ${source} · ${event.text}`;
    $("life-events").append(row);
  }
  if (!$("life-events").childElementCount) $("life-events").textContent = "还没有生活记录。";
}
async function refreshLife() { lifeSettings = await invoke("life-state"); renderLife(); }
$("life-open").onclick = async () => {
  try {
    await refreshLife(); $("life-dialog").showModal();
    clearInterval(lifeRefreshTimer);
    lifeRefreshTimer = setInterval(() => { refreshLife().catch((e) => { $("life-result").textContent = e.message; }); }, 5000);
  } catch (e) { status(e.message); }
};
$("life-close").onclick = () => $("life-dialog").close();
$("life-dialog").addEventListener("close", () => { clearInterval(lifeRefreshTimer); lifeRefreshTimer = undefined; });
$("life-planning-enabled").onchange = async () => {
  const enabled = $("life-planning-enabled").checked;
  lifeSettingsPending = true; renderLife();
  let message;
  try { lifeSettings = await invoke("life-planning-settings", { enabled }); }
  catch (e) { message = e.message; }
  finally { lifeSettingsPending = false; renderLife(); if (message) $("life-result").textContent = message; }
};
async function requestLifePlan(kind) {
  if (lifeActionPending || lifeSettings.planning?.busy) return;
  lifeActionPending = true; renderLife();
  let message;
  try { const result = await invoke("life-plan", { kind }); message = result.message; }
  catch (e) { message = e.message; }
  finally {
    lifeActionPending = false;
    await refreshLife().catch((e) => { message = e.message; });
    if (message) $("life-result").textContent = message;
  }
}
$("life-plan-daily").onclick = () => requestLifePlan("daily");
$("life-plan-refine").onclick = () => requestLifePlan("refine");
$("life-plan-cancel").onclick = async () => {
  try { lifeSettings = await invoke("life-plan-cancel"); renderLife(); }
  catch (e) { $("life-result").textContent = e.message; }
};
refresh().catch((e) => status(e.message));
