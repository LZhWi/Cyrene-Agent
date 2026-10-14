(() => {
  const $ = id => document.getElementById(id);
  const call = (channel, ...args) => window.CyrenePanel.invoke(channel, ...args);
  const labels = { scheduled: "已排队：请切回初代游戏", active: "正在发送输入", sent: "已发送并释放，请核对游戏结果", expired: "已过期，未发送", cancelled: "已停止", rejected: "请求被拒绝", disconnected: "输入进程已退出" };
  const phases = { idle: "尚未启动", requested: "正在请求", countdown: "切回游戏倒计时", right: "校准右移", up: "校准上移", following: "跟随中", complete: "本轮结束", stopped: "已停止", rejected: "请求被拒绝" };
  let polling = false, busy = false, initialized = false, previewPng;
  const invoke = async (channel, ...args) => {
    if (busy) return;
    busy = true;
    try {
      const value = await call(channel, ...args);
      const messages = {
        "input-start": "已请求创建手柄；请等待显示设备 ID 和 XInput 槽位。这一步不会发送 LS。",
        "input-stop": "测试手柄已断开并移除。",
        "input-cancel": "已请求停止动作；这一步不会发送 LS。",
        "input-pulse": `动作已排队：${value?.control || ""}，${(value?.delayMs || 0) / 1000} 秒后尝试发送；请切回游戏并核对下方最终结果。`,
        "follow-observe": "已请求只观察，请在倒计时结束前切回初代；完成后回来核对角色标记。",
        "follow-start": "已请求一轮校准与短距离跟随，请切回营地；校准时保持 P1 静止。",
      };
      $("notice").textContent = channel === "input-probe" ? (value.available ? "驱动可用，尚未创建手柄" : value.error) : messages[channel];
      await refresh();
    }
    catch (error) { $("notice").textContent = String(error.message || error); }
    finally { busy = false; }
  };
  async function refresh() {
    if (polling) return;
    polling = true;
    try {
      const status = await call("input-status");
      $("summary").textContent = status.state.ready ? `两只手柄已创建；设备 ID：${status.state.pads.join("、")}；Windows 新增 XInput 槽：${status.state.xinputSlots.join("、")}。设备 ID、槽位和游戏角色的对应需现场确认。` : status.running ? "输入进程正在启动/退出…" : "测试手柄未连接";
      $("start").disabled = status.running;
      $("stop").disabled = !status.running;
      $("cancel").disabled = !status.state.ready;
      $("connection-hint").hidden = !!status.state.ready;
      $("connection-hint").textContent = status.running ? "正在创建或退出，暂不能发送动作；请等待显示设备 ID 和 XInput 槽位。" : "尚未连接：先在上方检查驱动、创建两只测试手柄；看到设备 ID 和 XInput 槽位后才能发送。";
      const last = status.results.at(-1);
      const following = ["requested", "countdown", "baseline", "right", "up", "following"].includes(status.follow?.phase);
      const pending = ["scheduled", "active"].includes(last?.status);
      $("pulse").disabled = !status.state.ready || pending || following;
      for (const button of document.querySelectorAll("[data-menu-control]")) button.disabled = $("pulse").disabled;
      $("observe").disabled = !status.state.ready || pending || following;
      $("follow").disabled = $("observe").disabled || !$("confirm-camp").checked;
      $("follow-cancel").disabled = !following;
      $("follow-result").textContent = status.follow ? `${phases[status.follow.phase] || status.follow.phase}：${status.follow.reason || ""}` : "尚未启动观察／跟随。";
      const frame = status.follow?.frame;
      if (frame?.png && previewPng !== frame.png) {
        previewPng = frame.png;
        const image = new Image(); image.onload = () => {
          const canvas = $("preview"); canvas.width = frame.width; canvas.height = frame.height; canvas.style.display = "block";
          const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
          for (const [name, marker, colour] of [["P1", frame.p1, "orange"], ["P2", frame.p2, "cyan"]]) if (marker) {
            context.strokeStyle = colour; context.lineWidth = 3; context.strokeRect(marker.x - marker.width / 2 - 4, marker.y - marker.height / 2 - 4, marker.width + 8, marker.height + 8);
            context.fillStyle = colour; context.font = "bold 18px sans-serif"; context.fillText(name, marker.x + marker.width / 2 + 8, marker.y);
          }
        }; image.src = `data:image/png;base64,${frame.png}`;
      }
      $("result").textContent = last ? `${labels[last.status] || last.status}${last.reason ? "：" + last.reason : ""}` : "尚未发送任何动作。";
      if (status.notices.length) $("notice").textContent = status.notices.at(-1);
      $("state").textContent = JSON.stringify(status, null, 2);
    } catch (error) { $("notice").textContent = String(error.message || error); }
    finally { polling = false; }
  }
  $("probe").onclick = () => invoke("input-probe");
  $("start").onclick = () => invoke("input-start");
  $("stop").onclick = () => invoke("input-stop");
  $("cancel").onclick = () => invoke("input-cancel");
  $("follow-cancel").onclick = () => invoke("input-cancel");
  $("observe").onclick = () => invoke("follow-observe", { delayMs: Number($("delay").value) * 1000 });
  $("follow").onclick = () => invoke("follow-start", { delayMs: Number($("delay").value) * 1000, confirmCamp: $("confirm-camp").checked });
  $("confirm-camp").onchange = () => { if (initialized) void refresh(); };
  $("pad").onchange = () => { $("confirm-p1").checked = false; };
  const pulse = control => {
    $("control").value = control;
    return invoke("input-pulse", { pad: Number($("pad").value), control, durationMs: Number($("duration").value), delayMs: Number($("delay").value) * 1000, confirmP1: $("confirm-p1").checked });
  };
  $("pulse").onclick = () => pulse($("control").value);
  for (const button of document.querySelectorAll("[data-menu-control]")) button.onclick = () => pulse(button.dataset.menuControl);
  // The host registers our iframe only at its load event, then sends init.
  // Invoking before init can lose the first request and leave polling stuck.
  window.CyrenePanel.onTheme(() => {
    if (initialized) return;
    initialized = true; $("probe").disabled = false; $("start").disabled = false;
    void refresh();
  });
  window.CyrenePanel.ready();
  setInterval(() => { if (initialized) void refresh(); }, 500);
})();
