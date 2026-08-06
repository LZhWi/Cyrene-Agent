// 游戏代肝插件卡：VLM 配置、配方选择、参考图管理、启动/停止、进度日志
// 从 settings.ts 抽离。完全自含（window.gameBot IPC + IIFE 闭包）。
// 副作用导入：模块加载时执行 initGameBotPluginCard()。

// ===== 游戏代肝插件卡（在 plugins 面板里，MCP 下、生活工具上）=====
function initGameBotPluginCard(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gb = (window as any).gameBot as {
    getConfig: () => Promise<{ enabled: boolean; exePath: string; activeRecipe: string; vlm: { baseUrl: string; apiKey: string; model: string } }>;
    saveConfig: (c: unknown) => Promise<unknown>;
    listRecipes: () => Promise<{ id: string; name: string }[]>;
    listRefs: (r: string) => Promise<string[]>;
    refsDir: (r: string) => Promise<string>;
    start: () => Promise<{ ok: boolean; error?: string }>;
    stop: () => Promise<unknown>;
    onProgress: (cb: (i: unknown) => void) => (() => void) | void;
  } | undefined;
  if (!gb) return;

  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
  const enabledCb = $<HTMLInputElement>("plugin-gamebot-enabled");
  const configEl = $("plugin-gamebot-config");
  const exe = $<HTMLInputElement>("gamebot-exe");
  const url = $<HTMLInputElement>("gamebot-vlm-url");
  const key = $<HTMLInputElement>("gamebot-vlm-key");
  const model = $<HTMLInputElement>("gamebot-vlm-model");
  const recipeSel = $<HTMLSelectElement>("gamebot-recipe");
  const refsDirEl = $("gamebot-refs-dir");
  const refsListEl = $("gamebot-refs-list");
  const startBtn = $<HTMLButtonElement>("gamebot-start-btn");
  const stopBtn = $<HTMLButtonElement>("gamebot-stop-btn");
  const logEl = $("gamebot-log");
  if (!enabledCb || !configEl || !exe || !url || !key || !model || !recipeSel) return;

  let currentRecipe = "star-rail-daily";

  function appendLog(line: string): void {
    if (!logEl) return;
    logEl.textContent = new Date().toLocaleTimeString() + " " + line + "\n" + (logEl.textContent ?? "");
  }

  async function refreshRefs(): Promise<void> {
    if (refsDirEl) refsDirEl.textContent = await gb!.refsDir(currentRecipe);
    const refs = await gb!.listRefs(currentRecipe);
    if (refsListEl) {
      refsListEl.innerHTML = refs.length
        ? "已就位参考图：" + refs.map((r) => "<code>" + r + "</code>").join(" ")
        : "（目录还没有参考图，把裁好的小图按命名放进上方目录）";
    }
  }

  async function refresh(): Promise<void> {
    const cfg = await gb!.getConfig();
    enabledCb!.checked = cfg.enabled;
    configEl!.style.display = cfg.enabled ? "block" : "none";
    exe.value = cfg.exePath;
    url.value = cfg.vlm.baseUrl;
    key.value = cfg.vlm.apiKey;
    model.value = cfg.vlm.model;
    currentRecipe = cfg.activeRecipe;
    const recipes = await gb!.listRecipes();
    recipeSel.innerHTML = "";
    for (const r of recipes) {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = r.name + " (" + r.id + ")";
      if (r.id === currentRecipe) opt.selected = true;
      recipeSel.appendChild(opt);
    }
    await refreshRefs();
  }

  // 胶囊开关：开/关时保存 enabled 并显隐配置区
  enabledCb.addEventListener("change", async () => {
    configEl.style.display = enabledCb.checked ? "block" : "none";
    await gb.saveConfig({ enabled: enabledCb.checked });
  });

  // 配置项失焦即存
  const saveFields = () => gb.saveConfig({
    exePath: exe.value.trim(),
    activeRecipe: recipeSel.value,
    vlm: { baseUrl: url.value.trim(), apiKey: key.value.trim(), model: model.value.trim() },
  });
  for (const el of [exe, url, key, model]) el.addEventListener("change", () => void saveFields());
  recipeSel.addEventListener("change", () => { currentRecipe = recipeSel.value; void saveFields().then(refreshRefs); });

  startBtn?.addEventListener("click", async () => {
    const r = await gb.start();
    appendLog(r.ok ? "代肝已启动" : "启动失败: " + (r.error ?? ""));
  });
  stopBtn?.addEventListener("click", () => { void gb.stop(); appendLog("已请求停止"); });

  gb.onProgress((info) => {
    const i = info as { index: number; total: number; desc: string };
    appendLog(i.desc + (i.index >= 0 ? " (" + (i.index + 1) + "/" + i.total + ")" : ""));
  });

  void refresh();
}

initGameBotPluginCard();