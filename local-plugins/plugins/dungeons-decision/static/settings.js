(() => {
  const $ = id => document.getElementById(id);
  const call = (channel, ...args) => window.CyrenePanel.invoke(channel, ...args);
  const names = { release: "停止并释放", wait: "等待观察", follow: "跟随队友", melee: "近战协助", ranged: "远程协助", heal: "使用药水", dodge: "闪避危险", retreat: "撤离危险", revive: "救援队友" };
  let busy = false, pending;
  async function refresh() {
    const state = await call("decision-status"); pending = state.pending;
    $("complete").disabled = $("fail").disabled = !pending;
    $("history").textContent = JSON.stringify(state, null, 2);
    const last = state.reports.at(-1);
    $("decision").textContent = state.stopped ? "已停止；重置后才能继续预演" : last ? `模拟提案：${names[last.action]}。${last.reason}。${last.durationMs ? `建议短动作 ${last.durationMs} 毫秒。` : ""}未发送游戏输入。` : "尚未预演";
  }
  async function run(task) {
    if (busy) return; busy = true; $("notice").textContent = "";
    try { await task(); }
    catch (error) { $("notice").textContent = String(error.message || error); }
    finally { try { await refresh(); } catch (error) { $("notice").textContent = String(error.message || error); } busy = false; }
  }
  async function load() {
    const observation = await call("decision-example", $("scenario").value);
    $("observation").value = JSON.stringify(observation, null, 2); return observation;
  }
  $("load").onclick = () => run(load);
  $("run-example").onclick = () => run(async () => {
    // Scenario changes start a separate simulation, not an execution retry.
    await call("decision-reset"); await call("decision-preview", await load());
  });
  $("preview").onclick = () => run(async () => {
    const text = $("observation").value;
    if (text.length > 16000) throw Error("观察 JSON 过长");
    let observation;
    try { observation = JSON.parse(text); }
    catch { await call("decision-stop"); throw Error("观察 JSON 无效，已停止预演"); }
    await call("decision-preview", observation);
  });
  $("complete").onclick = () => run(() => call("decision-feedback", pending.id, "simulated-complete"));
  $("fail").onclick = () => run(() => call("decision-feedback", pending.id, "simulated-failed"));
  $("stop").onclick = () => run(() => call("decision-stop"));
  $("reset").onclick = () => run(() => call("decision-reset"));
  // Wait for the host to register this iframe and send its initial theme.
  // A pre-load invoke can be dropped and leave the preview permanently busy.
  let initialized = false;
  window.CyrenePanel.onTheme(() => {
    if (initialized) return;
    initialized = true;
    for (const id of ["load", "run-example", "preview", "stop", "reset"]) $(id).disabled = false;
    void run(async () => {
      for (const scenario of await call("decision-examples")) {
        const option = document.createElement("option"); option.value = scenario.id; option.textContent = scenario.name; $("scenario").append(option);
      }
      await load();
    });
  });
  window.CyrenePanel.ready();
})();
