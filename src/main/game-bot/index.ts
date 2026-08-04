// game-bot 启动入口 + IPC + agent 触发工具。
// 汇总点：组装 BotTools（screenshot/input/vlm-locator/refs-store）→ 注册 IPC → 注册 game_bot_start 工具。
// 唯一碰 electron 的汇总模块（ipcMain/BrowserWindow/app）；引擎本身不碰。

import * as fs from "fs";
import * as path from "path";
import { app, ipcMain, BrowserWindow } from "electron";
import { toolRegistry } from "../orchestrator/tool-registry";
import { IPC } from "../../shared/ipc-channels";
import { parseRecipe } from "./script-parser";
import { runRecipe } from "./engine";
import type { BotTools } from "./bot-tools";
import type { GameRecipe } from "./types";
import { loadGameBotSettings, saveGameBotSettings, type GameBotSettings } from "./settings-store";
import { listRefs, readRef, refsDirPath } from "./refs-store";
import { logger, LogTag } from "../logger";
import { captureScreen } from "./screenshot";
import * as input from "./input";
import * as vlm from "./vlm-locator";

const LOG = "[GameBot]";

/** 扫描内置 game-recipes/ 目录，返回脚本元数据列表。 */
export function listRecipes(): { id: string; name: string }[] {
  const dir = path.join(app.getAppPath(), "game-recipes");
  const result: { id: string; name: string }[] = [];
  try {
    if (!fs.existsSync(dir)) return result;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
      const id = f.replace(/\.(ya?ml)$/, "");
      const r = parseRecipe(fs.readFileSync(path.join(dir, f), "utf8"));
      result.push({ id, name: r.ok ? r.recipe.name : id });
    }
  } catch (err) {
    console.warn(LOG, "listRecipes 失败:", err);
  }
  return result;
}

/** 读脚本文件 → GameRecipe。 */
function loadRecipe(id: string): GameRecipe | null {
  const dir = path.join(app.getAppPath(), "game-recipes");
  for (const ext of [".yaml", ".yml"]) {
    const p = path.join(dir, id + ext);
    if (fs.existsSync(p)) {
      const r = parseRecipe(fs.readFileSync(p, "utf8"));
      return r.ok ? r.recipe : null;
    }
  }
  return null;
}

// ── 运行时状态 ──
let runSignal: { aborted: boolean } | null = null;
let runningRecipe: string | null = null;

/** 组装 BotTools 实现（注入引擎）。 */
function buildTools(settings: GameBotSettings): BotTools {
  const vlmConfig = { baseUrl: settings.vlm.baseUrl, apiKey: settings.vlm.apiKey, model: settings.vlm.model };
  const curRecipe = () => runningRecipe ?? settings.activeRecipe;
  return {
    launch: async (exe) => {
      const { spawn } = await import("child_process");
      spawn(exe, [], { detached: true, shell: false, stdio: "ignore" }).unref();
    },
    screenshot: captureScreen,
    click: input.click,
    clickCenter: async () => {
      const s = await captureScreen();
      if (s) await input.clickCenter(s.width, s.height);
    },
    key: input.keyPress,
    locate: async (refName, targetDesc) => {
      const ref = readRef(curRecipe(), refName);
      const screen = await captureScreen();
      if (!screen || !ref) return null;
      return vlm.locate(vlmConfig, screen, [ref], targetDesc ?? "", screen.width, screen.height);
    },
    select: async (desc) => {
      const screen = await captureScreen();
      if (!screen) return null;
      return vlm.locate(vlmConfig, screen, [], desc, screen.width, screen.height);
    },
    check: async (ask, refName) => {
      const ref = refName ? (readRef(curRecipe(), refName) ?? undefined) : undefined;
      const screen = await captureScreen();
      if (!screen) return null;
      return vlm.check(vlmConfig, screen, ask, ref);
    },
    compare: async (refNames, ask) => {
      const refs = refNames
        .map((n) => readRef(curRecipe(), n))
        .filter((x): x is { base64: string; mime: string } => x !== null);
      const screen = await captureScreen();
      if (!screen) return null;
      return vlm.compare(vlmConfig, screen, refs, ask);
    },
  };
}

function broadcastProgress(info: { index: number; total: number; desc: string }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try { win.webContents.send(IPC.GAME_BOT_PROGRESS, info); } catch { /* ignore */ }
    }
  }
}

/** 启动代肝（设置面板 / agent 都调这个）。异步运行，不阻塞调用方。 */
export async function startGameBot(): Promise<{ ok: boolean; error?: string }> {
  if (runSignal) return { ok: false, error: "已有代肝任务在运行" };
  const settings = loadGameBotSettings();
  if (!settings.enabled) return { ok: false, error: "代肝未启用（设置→插件→游戏代肝 开启开关）" };
  if (!settings.exePath) return { ok: false, error: "未配置游戏 exe 路径" };
  if (!settings.vlm.baseUrl || !settings.vlm.apiKey || !settings.vlm.model)
    return { ok: false, error: "未配置 VLM（baseUrl/apiKey/model）" };
  const recipe = loadRecipe(settings.activeRecipe);
  if (!recipe) return { ok: false, error: "找不到脚本: " + settings.activeRecipe };

  runningRecipe = settings.activeRecipe;
  runSignal = { aborted: false };
  const tools = buildTools(settings);

  void runRecipe(recipe, {
    tools,
    vars: { exe_path: settings.exePath, vlm_config: settings.vlm.model },
    onProgress: broadcastProgress,
    signal: runSignal,
  }).then((res) => {
    console.log(LOG, "代肝结束:", res.ok ? "成功" : "失败(" + res.error + ")", res.completed + "/" + res.total);
    broadcastProgress({ index: -1, total: res.total, desc: res.ok ? "完成" : "失败: " + (res.error ?? "") });
  }).catch((err) => {
    console.error(LOG, "代肝异常:", err);
    broadcastProgress({ index: -1, total: 0, desc: "异常: " + (err instanceof Error ? err.message : String(err)) });
  }).finally(() => {
    runSignal = null;
    runningRecipe = null;
  });
  return { ok: true };
}

/** 停止代肝。 */
export function stopGameBot(): { ok: boolean } {
  if (runSignal) runSignal.aborted = true;
  return { ok: true };
}

/** 注册 IPC + game_bot_start 工具。app.whenReady 后调一次。 */
export function initGameBot(): void {
  ipcMain.handle(IPC.GAME_BOT_GET_CONFIG, () => loadGameBotSettings());
  ipcMain.handle(IPC.GAME_BOT_SAVE_CONFIG, (_e, patch: unknown) => {
    const saved = saveGameBotSettings(patch as Partial<GameBotSettings>);
    // enabled 开关同步到 agent 工具，关了 agent 就看不到/调不到
    toolRegistry.setEnabled("game_bot_start", saved.enabled);
    return saved;
  });
  ipcMain.handle(IPC.GAME_BOT_LIST_RECIPES, () => listRecipes());
  ipcMain.handle(IPC.GAME_BOT_LIST_REFS, (_e, recipeId: string) => listRefs(recipeId));
  ipcMain.handle(IPC.GAME_BOT_REFS_DIR, (_e, recipeId: string) => refsDirPath(recipeId));
  ipcMain.handle(IPC.GAME_BOT_START, () => startGameBot());
  ipcMain.handle(IPC.GAME_BOT_STOP, () => stopGameBot());

  // agent 触发工具：用户在聊天里要代肝时调用。enabled 跟随配置开关。
  const initialSettings = loadGameBotSettings();
  toolRegistry.register({
    id: "game_bot_start",
    name: "游戏代肝",
    description:
      "启动游戏代肝，按预设脚本自动跑每日任务（如星穹铁道）。\n\n" +
      "何时用：\n- 用户说“帮我代肝”“跑一下日常”“清体力”“开始代肝”等\n\n" +
      "不要用于：\n- 用户只是问代肝功能怎么配置（引导去 设置 → 插件 → 游戏代肝）\n\n" +
      "无需参数。调用后引擎独立运行，进度实时回传。返回启动结果。",
    enabled: initialSettings.enabled,
    risk: "input-control",
    effectKind: "external_side_effect" as const,
    inputSchema: { type: "object", properties: {}, required: [] },
    execute: async () => {
      const r = await startGameBot();
      if (r.ok) return "✅ 代肝已启动，正在后台运行，进度会实时更新。";
      return "[错误·配置] 代肝启动失败: " + (r.error ?? "未知错误");
    },
  });

  logger.info(LogTag.GameBot, "initialized: IPC + game_bot_start tool, scripts:", listRecipes().map((r) => r.id).join(", ") || "(none)");
}
