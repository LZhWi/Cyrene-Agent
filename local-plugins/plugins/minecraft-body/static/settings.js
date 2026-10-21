"use strict";
const element = (id) => document.getElementById(id);
// The host registers this iframe only on load, then sends cyrene-panel/1 init.
// CyrenePanel.ready() only reports height; it is NOT a readiness promise.
const PROTOCOL = "cyrene-panel/1";
const REQUEST_TIMEOUT_MS = 5000;
let alive = true;
let ready = false;
let generation = 0;
let timer;
let initTimer;
let refreshing = null;
let mutationBusy = false;
let mutationUncertain = false;
let knownStatus = null;
let knownTask = null;
let hostOrigin;
// Negative IDs avoid the official bridge's positive sequence. Per-document
// randomness makes collisions with late replies to replacement iframes negligible.
let sequence = -Math.floor(Math.random() * (Number.MAX_SAFE_INTEGER / 2)) - 1;
const pending = new Map();
const stopChannels = new Set(["body-stop", "body-cancel", "task-cancel"]);
function buttons() {
  const usable = alive && ready;
  const known = usable && knownStatus !== null && !mutationBusy && !mutationUncertain;
  element("connect").disabled = !known || knownStatus.running || knownStatus.starting;
  element("execute").disabled = !known || !knownStatus.state.connected || !!knownStatus.state.activeAction
    || knownStatus.results.some((result) => result.status === "submitted")
    || knownTask?.state === "running" || !!knownTask?.effectsUncertain;
  element("task-ack").disabled = !known || !knownTask?.effectsUncertain || knownTask.state === "running";
  // Keep explicit stop/disconnect available when status reads fail. Never send them automatically.
  for (const id of ["disconnect", "cancel", "task-cancel"]) element(id).disabled = !usable || mutationBusy;
  element("refresh").disabled = !usable || refreshing !== null;
}
function unavailable(message) {
  knownStatus = null;
  knownTask = null;
  element("summary").textContent = message;
  buttons();
}
function request(channel, ...args) {
  if (!alive || !ready) return Promise.reject(new Error("面板通信尚未就绪，请稍候。"));
  return new Promise((resolve, reject) => {
    const seq = --sequence;
    const timeout = setTimeout(() => {
      pending.delete(seq);
      reject(new Error(`${channel} 请求超时；只读状态将重试，操作不会自动重发。`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(seq, { resolve, reject, timeout });
    window.parent.postMessage({ protocol: PROTOCOL, kind: "invoke", seq, channel, args }, hostOrigin === "null" ? "*" : hostOrigin);
  });
}
window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || data.protocol !== PROTOCOL) return;
  if (data.kind === "init") {
    if (!alive || (hostOrigin !== undefined && event.origin !== hostOrigin)) return;
    hostOrigin = event.origin;
    ready = true;
    clearTimeout(initTimer);
    buttons();
    void poll();
  } else if (data.kind === "invoke-result" && ready && event.origin === hostOrigin) {
    const entry = pending.get(data.seq);
    if (!entry) return;
    pending.delete(data.seq);
    clearTimeout(entry.timeout);
    if (data.ok) entry.resolve(data.data);
    else entry.reject(new Error(typeof data.error === "string" ? data.error : "面板调用失败"));
  }
});
const invoke = async (channel, value) => {
  if (mutationBusy || !ready || !alive) return;
  if (!stopChannels.has(channel) && (!knownStatus || mutationUncertain)) return;
  const token = generation;
  mutationBusy = true;
  buttons();
  try {
    const result = await request(channel, ...(value === undefined ? [] : [value]));
    if (!alive || token !== generation) return;
    if (channel === "body-stop") mutationUncertain = false;
    element("notice").textContent = channel === "body-action" ? `已提交：${result.id}，请查看实际结果。` : "请求已完成。";
  } catch (error) {
    if (!alive || token !== generation) return;
    // A failed response is not proof that an operation did not run. Never replay.
    mutationUncertain = true;
    element("notice").textContent = `${error.message} 请核对现场；可显式停止或断开，不要重复提交动作。`;
  } finally {
    if (alive && token === generation) {
      mutationBusy = false;
      buttons();
      void poll();
    }
  }
};
element("connect").addEventListener("click", () => invoke("body-start", {
  host: element("host").value.trim(), port: Number(element("port").value),
  username: element("username").value.trim(), owner: element("owner").value.trim(),
  auth: element("auth").value, version: element("version").value.trim(),
  autoSurvival: element("survival").checked,
}));
element("disconnect").addEventListener("click", () => invoke("body-stop"));
element("task-cancel").addEventListener("click", () => invoke("task-cancel"));
element("task-ack").addEventListener("click", () => { if(window.confirm("我已查看实际世界和背包，知道旧任务不会恢复。确认解除不确定状态？")) void invoke("task-acknowledge-effects"); });
element("cancel").addEventListener("click", () => invoke("body-cancel"));
element("execute").addEventListener("click", () => invoke("body-action", {
  action: element("action").value, material: element("material").value.trim(),
  count: Number(element("count").value), timeoutMs: Number(element("timeout").value) * 1000,
  position: { x: Number(element("x").value), y: Number(element("y").value), z: Number(element("z").value) },
  open: element("door-open").checked,
}));
function actionFields() {
  const action = element("action").value;
  element("material").disabled = !["collect", "craft", "give", "equip", "place", "deposit", "withdraw", "plant", "harvest", "smelt"].includes(action);
  element("count").disabled = !["collect", "craft", "give", "pickup", "deposit", "withdraw", "till", "plant", "harvest", "smelt"].includes(action);
  element("coordinates").hidden = !["goto", "place"].includes(action);
  element("door-field").hidden = action !== "door";
  const help = {
    goto: "32格内的安全位置。家点、箱子和床在当前连接内保留，重生保留，断开后重设。",
    set_home: "记录当前安全位置；不自动设置床的重生点。", home: "返回当前连接记录的同维度家点，须在32格内。",
    collect: "木头、石头、圆石、泥土、沙子、煤矿、铁矿、铜矿。仅采可安全触及的表面方块。",
    equip: "填写中文合成别名（例如铁剑）或物品 ID（例如 bread）。", equip_armor: "按材质等级换装，不评价附魔；保留已有同级或更高护甲。",
    place: "整数方块坐标，8格内。支持泥土、圆石、石头、木板、火把、工作台、熔炉、普通箱子，须空格有支撑。",
    smelt: "填写铁/铜/金/玻璃/石头/牛肉/猪肉/鸡肉/羊肉/马铃薯/木炭。原料和煤/木炭须在背包，附近熔炉须空闲；每件约10秒，请给足期限。停止后熔炉可能继续烧炼。",
    bind_chest: "显式绑定8格内最近普通箱子；不会自动操作其他箱子。", deposit: "物品名或中文别名，单堆须足量；保留三块逃生材料。", withdraw: "物品名或中文别名，核对背包与箱子两侧变化。",
    bind_bed: "只支持主世界床，避免其他维度床爆炸。", sleep: "夜间在已绑定床睡觉；服务器须允许，睡到早晨或选择起床。",
    till: "8格内临水、无人站立的空闲土地，需要耐久足够的锄。", plant: "填写小麦/胡萝卜/马铃薯/甜菜，需要种子与空耕地。",
    harvest: "填写小麦/胡萝卜/马铃薯/甜菜，仅收割成熟作物；拾取与补种分开操作。",
    defend: "持剑处理6格内一个白名单敌对生物；不攻击玩家、宠物或中立生物，低血量停止，不能保证战斗安全。",
    escape: "仅支持头顶空闲、有安全出口的一格浅坑；消耗一块普通垫脚材料，不适用于深坑或岩浆。",
  };
  element("action-help").textContent = help[action] || "动作有期限，可用“停止动作”取消；结果以状态核验为准。";
}
element("action").addEventListener("change", actionFields);
actionFields();
function validateStatus(status, task) {
  if (!status || typeof status.running !== "boolean" || !status.state
    || typeof status.state.connected !== "boolean" || !Array.isArray(status.results)
    || (task !== null && (typeof task !== "object" || typeof task.state !== "string"))) {
    throw new Error("状态返回格式异常，已禁用动作；只读查询将重试。");
  }
}
async function refresh(token) {
  const status = await request("body-status");
  if (!alive || token !== generation) return;
  const task = await request("task-status");
  if (!alive || token !== generation) return;
  validateStatus(status, task);
  knownStatus = status;
  knownTask = task;
  element("state").textContent = JSON.stringify(status, null, 2);
  element("task-state").textContent = task ? JSON.stringify(task, null, 2) : "尚无高层任务";
  const state = status.state;
  element("summary").textContent = state.connected ? `生命 ${state.health}/20 · 饥饿 ${state.food}/20 · ${state.dimension} · ${state.sleeping ? "睡眠中" : state.activeAction ? `动作 ${state.activeAction.action}${state.activeAction.draining ? " 正在停止" : " 运行中"}` : "空闲"}` : "未连接";
  const last = status.results.at(-1);
  const labels = { submitted: "已提交", active: "运行中", completed: "已完成", partial: "部分完成", failed: "失败", cancelled: "已停止", timed_out: "超时停止", disconnected: "连接中断", rejected: "拒绝执行" };
  const title = last && [...element("action").options].find((option) => option.value === last.action)?.textContent;
  element("result").textContent = last ? `最近动作：${title || last.action || "请求"} · ${labels[last.status] || last.status}${last.reason ? ` · ${last.reason}` : ""}${last.effectsUncertain ? " · 已发生的变化需查看实际状态" : ""}` : "尚未执行动作。";
  if (status.login) element("notice").textContent = `微软登录：打开 ${status.login.url}，输入 ${status.login.code}。`;
}
function poll() {
  if (!alive || !ready) return Promise.resolve();
  if (refreshing) return refreshing;
  clearTimeout(timer);
  const token = generation;
  refreshing = refresh(token).catch((error) => {
    if (alive && token === generation) {
      unavailable(`状态读取失败：${error.message}`);
      element("state").textContent = "当前状态未知。旧快照不可作为操作依据。";
      element("task-state").textContent = "任务状态未知。";
    }
  }).finally(() => {
    if (alive && token === generation) {
      refreshing = null;
      buttons();
      timer = setTimeout(poll, 1000);
    }
  });
  buttons();
  return refreshing;
}
function waitForInit() {
  clearTimeout(initTimer);
  initTimer = setTimeout(() => {
    if (alive && !ready) unavailable("未收到主程序就绪通知。请关闭并重新打开此面板；未发送任何操作。");
  }, REQUEST_TIMEOUT_MS);
}
element("refresh").addEventListener("click", () => { void poll(); });
window.addEventListener("pagehide", () => {
  alive = false;
  generation += 1;
  clearTimeout(timer);
  clearTimeout(initTimer);
  for (const entry of pending.values()) {
    clearTimeout(entry.timeout);
    entry.reject(new Error("面板已关闭。"));
  }
  pending.clear();
  refreshing = null;
  if (mutationBusy) mutationUncertain = true;
  mutationBusy = false;
  unavailable("面板已暂停，恢复后重新读取状态。");
});
window.addEventListener("pageshow", () => {
  if (alive) return;
  alive = true;
  unavailable("正在重新读取状态…");
  if (ready) void poll(); else waitForInit();
});
unavailable("等待主程序通信就绪…");
waitForInit();
