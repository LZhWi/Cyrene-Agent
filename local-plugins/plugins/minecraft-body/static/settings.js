"use strict";
const element = (id) => document.getElementById(id);
const invoke = async (channel, value) => {
  try {
    const result = await window.CyrenePanel.invoke(channel, value);
    element("notice").textContent = channel === "body-action" ? `已提交：${result.id}，请查看实际结果。` : "请求已发送。";
    await refresh();
  } catch (error) { element("notice").textContent = error.message; }
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
let alive = true;
let timer;
async function refresh() {
  if (!alive) return;
  const status = await window.CyrenePanel.invoke("body-status");
  if (!alive) return;
  element("state").textContent = JSON.stringify(status, null, 2);
  const task = await window.CyrenePanel.invoke("task-status");
  element("task-state").textContent = task ? JSON.stringify(task, null, 2) : "尚无高层任务";
  element("task-ack").disabled = !task?.effectsUncertain || task.state === "running";
  const state = status.state;
  element("summary").textContent = state.connected ? `生命 ${state.health}/20 · 饥饿 ${state.food}/20 · ${state.dimension} · ${state.sleeping ? "睡眠中" : state.activeAction ? `动作 ${state.activeAction.action}${state.activeAction.draining ? " 正在停止" : " 运行中"}` : "空闲"}` : "未连接";
  const last = status.results.at(-1);
  const labels = { submitted: "已提交", active: "运行中", completed: "已完成", partial: "部分完成", failed: "失败", cancelled: "已停止", timed_out: "超时停止", disconnected: "连接中断", rejected: "拒绝执行" };
  const title = last && [...element("action").options].find((option) => option.value === last.action)?.textContent;
  element("result").textContent = last ? `最近动作：${title || last.action || "请求"} · ${labels[last.status] || last.status}${last.reason ? ` · ${last.reason}` : ""}${last.effectsUncertain ? " · 已发生的变化需查看实际状态" : ""}` : "尚未执行动作。";
  element("connect").disabled = status.running || status.starting;
  element("execute").disabled = !status.state.connected || !!status.state.activeAction || status.results.some((result) => result.status === "submitted");
  if (status.login) element("notice").textContent = `微软登录：打开 ${status.login.url}，输入 ${status.login.code}。`;
}
async function poll() {
  try { await refresh(); } catch (error) { if (alive) element("notice").textContent = error.message; }
  if (alive) timer = setTimeout(poll, 1000);
}
window.addEventListener("pagehide", () => { alive = false; clearTimeout(timer); });
void poll();
