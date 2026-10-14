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
let lifeJournalPending = false;
let lifeEditingGoalId;
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
  const hour = new Date().getHours();
  const phase = hour >= 6 && hour < 12 ? "morning" : hour >= 12 && hour < 18 ? "afternoon" : hour >= 18 && hour < 23 ? "evening" : null;
  const used = (name) => attempts.some((attempt) => attempt.phase === name);
  $("life-current").textContent = lifeSettings.enabled ? `当前：${self.activity ?? "休息中"}` : "生活系统已关闭，可在主程序偏好设置中开启。";
  $("life-metrics").textContent = `精力 ${self.energy ?? "—"} / 100 · 专注 ${self.focus ?? "—"} / 100 · 休息需要 ${self.restNeed ?? "—"} / 100`;
  $("life-planning-enabled").checked = Boolean(planning.enabled);
  $("life-planning-enabled").disabled = !lifeSettings.enabled || lifeSettingsPending;
  $("life-budget").textContent = `固定更新：早计划 ${Number(used("morning"))}/1 · 晚日记 ${Number(used("evening"))}/1 · 中午仅手动或随对话调整${planningBusy ? " · 正在生成" : ""}`;
  $("life-plan-daily").disabled = !lifeSettings.enabled || planningBusy || lifeSettingsPending || busy || phase !== "morning" || used("morning");
  $("life-plan-refine").disabled = !lifeSettings.enabled || planningBusy || lifeSettingsPending || busy || !["afternoon", "evening"].includes(phase) || used(phase);
  $("life-plan-cancel").disabled = !planningBusy;
  $("life-result").textContent = planning.lastResult?.message ?? "尚未请求模型规划，当前使用本地生活日程。";
  $("life-plans").replaceChildren();
  for (const plan of (planning.plans ?? []).filter((item) => item.date === today)) {
    const row = document.createElement("p");
    row.textContent = `${plan.kind === "refine" ? "时段更新" : "全天规划"}：${plan.windows.map((window) => {
      const time = (at) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      return `${time(window.startAt)}–${time(window.endAt)} ${window.activities.map((activity, index) => window.durations?.[index] ? `${activity} ${window.durations[index]} 分钟` : activity).join("、")}`;
    }).join("；")}`;
    $("life-plans").append(row);
  }
  for (const plan of (planning.conversationPlans ?? []).filter((item) => item.endAt > Date.now())) {
    const row = document.createElement("p");
    const time = (at) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    row.textContent = `对话调整：${time(plan.startAt)}–${time(plan.endAt)} ${plan.activities.map((activity, index) =>
      `${activity} ${plan.durations[index]} 分钟`).join("、")}`;
    $("life-plans").append(row);
  }
  if (!$("life-plans").childElementCount) $("life-plans").textContent = "今日尚无模型计划，继续使用本地日程。";
  $("life-events").replaceChildren();
  for (const event of [...(lifeSettings.continuity?.events ?? [])].sort((a, b) => b.endAt - a.endAt).slice(0, 6)) {
    const row = document.createElement("div"); row.className = "life-record";
    const description = document.createElement("p");
    const source = event.status === "revoked" ? "已撤销" : event.status === "inferred" ? "离线推演"
      : event.source === "legacy_schedule" ? "旧版模拟记录" : "已发生的模拟活动";
    description.textContent = `${event.date} · ${source} · ${event.text}`;
    row.append(description);
    if (event.status !== "revoked" && event.modelDetail) {
      const detail = document.createElement("p");
      detail.textContent = `模型创作的角色世界细节：${event.modelDetail}`;
      row.append(detail);
    }
    if (event.status !== "revoked") {
      const revoke = document.createElement("button"); revoke.type = "button";
      revoke.textContent = "撤销记录"; revoke.dataset.eventId = event.id; revoke.disabled = lifeJournalPending;
      revoke.onclick = () => updateLifeJournal("life-event-revoke", { id: event.id }, "记录已撤销，相关日记与目标引用已更新。");
      row.append(revoke);
    }
    $("life-events").append(row);
  }
  if (!$("life-events").childElementCount) $("life-events").textContent = "还没有生活记录。";
  $("life-sharing").replaceChildren();
  for (const record of [...(lifeSettings.sharing?.records ?? [])].sort((a, b) => b.reservedAt - a.reservedAt).slice(0, 10)) {
    const row = document.createElement("div"); row.className = "life-record";
    const description = document.createElement("p");
    description.textContent = `${record.status === "delivered" ? "已分享" : "结果待确认，不自动重发"} · 事件 ${record.eventId} r${record.eventRevision}\n${record.text}`;
    row.append(description);
    if (record.receipt) {
      const receipt = document.createElement("small");
      receipt.textContent = `会话 ${record.receipt.conversationId} · 消息 ${record.receipt.messageId}`;
      row.append(receipt);
    }
    $("life-sharing").append(row);
  }
  if (!$("life-sharing").childElementCount) $("life-sharing").textContent = "还没有生活分享记录。";
  renderLifeJournal();
}
function renderLifeJournal() {
  const journal = lifeSettings.journal ?? { goals: [], diaries: [] };
  const activities = lifeSettings.activities ?? [];
  const select = $("life-goal-activity");
  if (JSON.stringify([...select.options].map((option) => option.value)) !== JSON.stringify(activities)) {
    const selectedActivity = select.value;
    select.replaceChildren();
    for (const activity of activities) {
      const option = document.createElement("option"); option.value = activity; option.textContent = activity; select.append(option);
    }
    if (activities.includes(selectedActivity)) select.value = selectedActivity;
  }
  for (const id of ["life-goal-title", "life-goal-activity", "life-goal-due", "life-goal-remind", "life-goal-reset", "life-diary-rebuild"]) $(id).disabled = lifeJournalPending;
  $("life-goal-save").textContent = lifeEditingGoalId ? "保存目标修改" : "创建目标";
  $("life-goal-save").disabled = lifeJournalPending || !activities.length || (!lifeEditingGoalId && journal.goals.filter((goal) => goal.source !== "model" && goal.status === "active").length >= 3);
  $("life-goals").replaceChildren();
  const goalStatuses = { active: "进行中", paused: "已暂停", completed: "手动确认完成", cancelled: "已取消" };
  for (const goal of journal.goals) {
    const row = document.createElement("section"), title = document.createElement("strong"), detail = document.createElement("p");
    row.className = "life-record";
    title.textContent = `${goal.source === "model" ? "昔涟的意向" : "你的目标"} · ${goal.title} · ${goalStatuses[goal.status] ?? goal.status}`;
    detail.textContent = `${goal.activity}${goal.dueDate ? ` · ${goal.source === "model" ? "计划日" : "期限"} ${goal.dueDate}` : ""}${goal.source !== "model" ? ` · ${goal.remind !== false ? "允许提醒" : "不提醒"}` : ""} · 关联已发生片段 ${goal.eventRefs?.length ?? 0} 条（不表示目标完成）`;
    row.append(title, detail);
    if (goal.source !== "model" && (goal.status === "active" || goal.status === "paused")) {
      const actions = document.createElement("div"); actions.className = "actions";
      const addButton = (label, action, handler) => {
        const button = document.createElement("button"); button.type = "button"; button.textContent = label;
        button.dataset.goalId = goal.id; button.dataset.action = action; button.disabled = lifeJournalPending;
        button.onclick = handler; actions.append(button);
      };
      addButton("编辑", "edit", () => {
        lifeEditingGoalId = goal.id;
        $("life-goal-title").value = goal.title; select.value = goal.activity;
        $("life-goal-due").value = goal.dueDate ?? ""; $("life-goal-remind").checked = goal.remind !== false;
        renderLifeJournal(); $("life-goal-title").focus();
      });
      const changeStatus = async (status) => {
        if (await updateLifeJournal("life-goal-status", { id: goal.id, status }, "目标状态已保存。") && lifeEditingGoalId === goal.id) resetLifeGoal();
      };
      addButton(goal.status === "active" ? "暂停" : "恢复", "pause-resume", () => changeStatus(goal.status === "active" ? "paused" : "active"));
      addButton("手动完成", "complete", () => changeStatus("completed"));
      addButton("取消目标", "cancel", () => changeStatus("cancelled"));
      row.append(actions);
    }
    $("life-goals").append(row);
  }
  if (!journal.goals.length) $("life-goals").textContent = "还没有目标或未来意向。";
  $("life-diaries").replaceChildren();
  const eventsById = new Map((lifeSettings.continuity?.events ?? []).map((event) => [event.id, event]));
  for (const diary of [...journal.diaries].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 7)) {
    const row = document.createElement("section"), title = document.createElement("strong"), source = document.createElement("p"), summary = document.createElement("p");
    row.className = "life-record"; title.textContent = diary.date;
    const sources = (diary.eventRefs ?? []).map((ref) => eventsById.get(ref.id));
    const runtime = sources.filter((event) => event?.status === "materialized" && event.source === "runtime_schedule").length;
    const inferred = sources.filter((event) => event?.status === "inferred").length;
    const legacy = sources.filter((event) => event?.source === "legacy_schedule").length;
    source.textContent = diary.status === "revoked" ? "已撤销：来源已失效。" : `${diary.source === "model" ? "模型撰写 · " : "程序整理 · "}来源 ${sources.length} 个片段：已发生模拟 ${runtime} · 离线推演 ${inferred} · 旧版记录 ${legacy}。`;
    summary.textContent = diary.status === "revoked" ? "这篇日记不再用于生活背景。" : diary.summary;
    row.append(title, source, summary); $("life-diaries").append(row);
  }
  if (!journal.diaries.length) $("life-diaries").textContent = "还没有可整理的生活日记。";
  if (!$("life-diary-date").value) $("life-diary-date").value = lifeDate();
  $("life-dates").replaceChildren();
  for (const date of lifeSettings.importantDates ?? []) {
    const label = document.createElement("label"), checkbox = document.createElement("input"), text = document.createElement("span");
    label.className = "life-toggle"; checkbox.type = "checkbox"; checkbox.checked = date.remind !== false; checkbox.disabled = lifeJournalPending;
    text.textContent = `${date.date} ${date.label}`;
    checkbox.onchange = () => updateLifeJournal("life-date-reminder", { date: date.date, label: date.label, remind: checkbox.checked }, "日期提醒已保存。");
    label.append(checkbox, text); $("life-dates").append(label);
  }
  if (!$("life-dates").childElementCount) $("life-dates").textContent = "尚未设置重要日期。";
}
function resetLifeGoal() {
  lifeEditingGoalId = undefined;
  $("life-goal-title").value = ""; $("life-goal-due").value = ""; $("life-goal-remind").checked = true;
  renderLifeJournal();
}
async function updateLifeJournal(action, data, successMessage) {
  if (lifeJournalPending) return false;
  lifeJournalPending = true; renderLife();
  let saved = false, message;
  try { lifeSettings = await invoke(action, data); saved = true; message = successMessage; }
  catch (e) { message = e.message; }
  finally {
    lifeJournalPending = false; renderLife(); $("life-journal-status").textContent = message;
    if (saved && (action === "life-diary-rebuild" || action === "life-event-revoke"))
      $("life-diary-search-results").textContent = "日记来源已更新，请重新搜索。";
  }
  return saved;
}
$("life-goal-form").onsubmit = async (event) => {
  event.preventDefault();
  const input = { ...(lifeEditingGoalId ? { id: lifeEditingGoalId } : {}), title: $("life-goal-title").value,
    activity: $("life-goal-activity").value, dueDate: $("life-goal-due").value || null, remind: $("life-goal-remind").checked };
  if (await updateLifeJournal("life-goal-save", input, "目标已保存，完成状态由你手动确认。")) resetLifeGoal();
};
$("life-goal-reset").onclick = resetLifeGoal;
$("life-diary-rebuild").onclick = () => updateLifeJournal("life-diary-rebuild", { date: $("life-diary-date").value }, "日记已按有效来源重建，未调用模型。");
$("life-diary-search-form").onsubmit = async (event) => {
  event.preventDefault();
  const results = $("life-diary-search-results"); results.textContent = "正在搜索…";
  try {
    const hits = await invoke("life-diary-search", { query: $("life-diary-search").value });
    results.replaceChildren();
    for (const hit of hits) {
      const row = document.createElement("section"), title = document.createElement("strong");
      row.className = "life-record"; title.textContent = hit.date; row.append(title);
      if (hit.diary) {
        const summary = document.createElement("p");
        summary.textContent = `${hit.diary.source === "model" ? "模型撰写" : "程序整理"}：${hit.diary.summary}`;
        row.append(summary);
      }
      for (const item of hit.events) {
        const detail = document.createElement("p");
        detail.textContent = `${item.status === "inferred" ? "离线推演" : item.source === "legacy_schedule"
          ? "旧版模拟记录" : "已发生的模拟活动"}：${item.text}${item.modelDetail ? `；模型创作细节：${item.modelDetail}` : ""}`;
        row.append(detail);
      }
      results.append(row);
    }
    if (!hits.length) results.textContent = "没有找到匹配的日记或活动。";
  } catch (error) { results.textContent = error.message; }
};
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
