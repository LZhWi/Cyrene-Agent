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
import { captureScreen } from "./screenshot";
import * as input from "./input";
import * as vlm from "./vlm-locator";
import { OcrClient } from "./ocr-client";
import { captureWindowTarget, findFullscreenTarget, findWindowTarget } from "./window-target";
import { runCurrencyWars } from "./currency-wars/runner";
import { launchDetached } from "./process-tools";
import { resolveOcrLaunchConfig } from "./ocr-runtime";
import { ElevatedInputClient } from "./elevated-input";
import { MinecraftBotManager, type MinecraftManagerEvent } from "./minecraft/manager";
import { loadMinecraftSessionEvents } from "./minecraft/session-store";
import type { MinecraftSessionEvent } from "./minecraft/types";

const LOG = "[GameBot]";
const MINECRAFT_RECIPE = { id: "minecraft-player", name: "Minecraft 联机玩家" };
const minecraftManager = new MinecraftBotManager();

/** 扫描内置 game-recipes/ 目录，返回脚本元数据列表。 */
export function listRecipes(): { id: string; name: string }[] {
  const dir = path.join(app.getAppPath(), "game-recipes");
  const result: { id: string; name: string }[] = [];
  try {
    if (!fs.existsSync(dir)) return [MINECRAFT_RECIPE];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
      const id = f.replace(/\.(ya?ml)$/, "");
      const r = parseRecipe(fs.readFileSync(path.join(dir, f), "utf8"));
      result.push({ id, name: r.ok ? r.recipe.name : id });
    }
  } catch (err) {
    console.warn(LOG, "listRecipes 失败:", err);
  }
  result.push(MINECRAFT_RECIPE);
  return result;
}

/** 读脚本文件 → GameRecipe。 */
function loadRecipe(id: string): GameRecipe | null {
  if (id === MINECRAFT_RECIPE.id) {
    return { name: MINECRAFT_RECIPE.name, exe: "minecraft-sidecar", runner: "minecraft-player", steps: [] };
  }
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
      await launchDetached(exe);
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

function broadcastProgress(info: { index: number; total: number; desc: string; minecraftSummary?: MinecraftManagerEvent }): void {
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
  const recipe = loadRecipe(settings.activeRecipe);
  if (!recipe) return { ok: false, error: "找不到脚本: " + settings.activeRecipe };
  if (recipe.runner === "minecraft-player") {
    if (!settings.minecraft.username) return { ok: false, error: "请配置 Minecraft 机器人账号" };
    if (!settings.minecraft.owner) return { ok: false, error: "请配置允许控制昔涟的玩家名" };
    if (settings.minecraft.auth === "offline" && !/^[A-Za-z0-9_]{1,16}$/.test(settings.minecraft.username)) {
      return { ok: false, error: "Minecraft 离线账号名只能包含字母、数字、下划线，且最多 16 个字符" };
    }
    if (!/^[A-Za-z0-9_]{1,16}$/.test(settings.minecraft.owner)) {
      return { ok: false, error: "绑定玩家名只能包含字母、数字、下划线，且最多 16 个字符" };
    }
    if (settings.minecraft.llm.enabled && (!settings.minecraft.llm.baseUrl || !settings.minecraft.llm.model)) {
      return { ok: false, error: "已启用 Minecraft LLM，但尚未填写 Base URL 和模型" };
    }
    if (settings.minecraft.llm.enabled && !/^https?:\/\//i.test(settings.minecraft.llm.baseUrl)) {
      return { ok: false, error: "Minecraft LLM Base URL 必须使用 http 或 https" };
    }
    if (settings.minecraft.soul.enabled && (!settings.minecraft.soul.baseUrl || !settings.minecraft.soul.model)) {
      return { ok: false, error: "已启用 Minecraft 高性能 Soul LLM，但尚未填写 Base URL 和模型" };
    }
    if (settings.minecraft.soul.enabled && !/^https?:\/\//i.test(settings.minecraft.soul.baseUrl)) {
      return { ok: false, error: "Minecraft Soul LLM Base URL 必须使用 http 或 https" };
    }
    if (settings.minecraft.soul.enabled && !settings.minecraft.llm.enabled) {
      return { ok: false, error: "两阶段模式需要同时启用高性能 Soul LLM 和低成本执行 LLM" };
    }
    runningRecipe = settings.activeRecipe;
    runSignal = { aborted: false };
    try {
      const minecraftVision = settings.minecraft.autonomy.visionEnabled && settings.vlm.baseUrl && settings.vlm.model
        ? { baseUrl: settings.vlm.baseUrl, apiKey: settings.vlm.apiKey, model: settings.vlm.model }
        : null;
      minecraftManager.start(app.getAppPath(), app.getPath("userData"), settings.minecraft, minecraftVision, (event) => {
        const desc = event.type === "progress"
          ? event.description
          : event.stage === "offer"
            ? "联机已结束：是否生成本次 Minecraft 联机记录？"
            : "联机记录草稿已生成，请确认是否保存";
        broadcastProgress({ index: 0, total: 1, desc, minecraftSummary: event });
      }, () => {
        runSignal = null;
        runningRecipe = null;
      });
      return { ok: true };
    } catch (error) {
      runSignal = null;
      runningRecipe = null;
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const resolvedExe = recipe.exe.replace(/\$\{exe_path\}/g, settings.exePath).trim();
  if (!resolvedExe) return { ok: false, error: "未配置游戏 exe 路径" };
  const hasVlm = Boolean(settings.vlm.baseUrl && settings.vlm.apiKey && settings.vlm.model);
  const ocrLaunch = recipe.runner === "currency-wars"
    ? resolveOcrLaunchConfig({
        command: settings.currencyWars.ocrCommand,
        args: settings.currencyWars.ocrArgs,
        autoDetect: settings.currencyWars.autoDetectOcr,
        appPath: app.getAppPath(),
      })
    : null;
  const hasLocalOcr = Boolean(ocrLaunch);
  if (recipe.runner === "currency-wars" ? !hasVlm && !hasLocalOcr : !hasVlm)
    return { ok: false, error: "未配置可用识别器（VLM 或本地 OCR）" };

  runningRecipe = settings.activeRecipe;
  runSignal = { aborted: false };
  let elevatedInput: ElevatedInputClient | null = null;
  if (recipe.runner === "currency-wars" && settings.currencyWars.elevatedInput && !settings.currencyWars.recognitionOnly) {
    try {
      broadcastProgress({ index: 0, total: settings.currencyWars.maxRounds || 1, desc: "等待管理员输入助手连接" });
      elevatedInput = await ElevatedInputClient.connect(app.getPath("userData"), path.parse(resolvedExe).name);
      broadcastProgress({ index: 0, total: settings.currencyWars.maxRounds || 1, desc: "管理员输入助手已连接" });
    } catch (err) {
      runSignal = null;
      runningRecipe = null;
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  const tools = buildTools(settings);
  const signal = runSignal;
  const ocrClient = hasLocalOcr
    ? new OcrClient(ocrLaunch!.command, ocrLaunch!.args)
    : null;
  if (ocrLaunch?.source === "better-hsrcw") {
    console.log(LOG, "已自动使用 Better-HSRCW 本地 RapidOCR:", ocrLaunch.command);
    broadcastProgress({ index: 0, total: settings.currencyWars.maxRounds || 1, desc: "已启用本地 RapidOCR" });
  }
  const task = recipe.runner === "currency-wars"
    ? runCurrencyWars({
        exe: resolvedExe,
        settings: settings.currencyWars,
        signal,
        onProgress: broadcastProgress,
        tools: {
          launch: tools.launch,
          findWindow: findWindowTarget,
          findFullscreen: findFullscreenTarget,
          capture: captureWindowTarget,
          click: elevatedInput ? elevatedInput.click.bind(elevatedInput) : input.click,
          drag: elevatedInput ? elevatedInput.drag.bind(elevatedInput) : input.drag,
          key: elevatedInput ? elevatedInput.key.bind(elevatedInput) : input.keyPress,
          delay: async (ms) => {
            let remaining = ms;
            while (remaining > 0) {
              if (signal.aborted) return;
              const chunk = Math.min(remaining, 100);
              await new Promise<void>((resolve) => setTimeout(resolve, chunk));
              remaining -= chunk;
            }
          },
          recognize: async (capture) => {
            if (ocrClient) {
              return ocrClient.recognize(Buffer.from(capture.base64, "base64"), capture.width, capture.height);
            }
            return vlm.recognizeText(
              { baseUrl: settings.vlm.baseUrl, apiKey: settings.vlm.apiKey, model: settings.vlm.model },
              capture,
            );
          },
        },
      }).then((res) => ({
        ok: res.ok,
        error: res.error,
        completed: res.rounds,
        total: settings.currencyWars.maxRounds || res.rounds,
        detail: res.matched,
      }))
    : runRecipe(recipe, {
        tools,
        vars: { exe_path: settings.exePath, vlm_config: settings.vlm.model },
        onProgress: broadcastProgress,
        signal,
      });

  void task.then((res) => {
    console.log(LOG, "代肝结束:", res.ok ? "成功" : "失败(" + res.error + ")", res.completed + "/" + res.total);
    const detail = "detail" in res && res.detail ? ": " + res.detail : "";
    broadcastProgress({ index: -1, total: res.total, desc: res.ok ? "完成" + detail : "失败: " + (res.error ?? "") });
  }).catch((err) => {
    console.error(LOG, "代肝异常:", err);
    broadcastProgress({ index: -1, total: 0, desc: "异常: " + (err instanceof Error ? err.message : String(err)) });
  }).finally(() => {
    ocrClient?.dispose();
    elevatedInput?.dispose();
    runSignal = null;
    runningRecipe = null;
  });
  return { ok: true };
}

/** 停止代肝。 */
export function stopGameBot(): { ok: boolean } {
  if (runSignal) runSignal.aborted = true;
  if (minecraftManager.running) minecraftManager.stop();
  return { ok: true };
}

/** 联机记录确认保存后的回调接线（主 app 用它往聊天会话插联机气泡）。 */
export function setMinecraftSessionSavedCallback(callback: (event: MinecraftSessionEvent) => void): void {
  minecraftManager.setSessionSavedCallback(callback);
}

/** minecraft-sessions.json 档案的只读读路径（build-options 上下文注入用）。 */
export function loadMinecraftContextEvents(): MinecraftSessionEvent[] {
  return loadMinecraftSessionEvents(path.join(app.getPath("userData"), "game-bot", "minecraft-sessions.json"));
}

/** 注册 IPC + game_bot_start 工具。app.whenReady 后调一次。 */
export function initGameBot(): void {
  ipcMain.handle(IPC.GAME_BOT_GET_CONFIG, () => ({
    ...loadGameBotSettings(),
    minecraftSummaryReview: minecraftManager.getPendingSummaryReview(),
  }));
  ipcMain.handle(IPC.GAME_BOT_SAVE_CONFIG, async (_e, patch: unknown) => {
    const summaryAction = (patch && typeof patch === "object" ? patch : {}) as {
      minecraftSummaryAction?: { id?: unknown; action?: unknown };
    };
    if (summaryAction.minecraftSummaryAction) {
      const id = typeof summaryAction.minecraftSummaryAction.id === "string" ? summaryAction.minecraftSummaryAction.id : "";
      const action = summaryAction.minecraftSummaryAction.action;
      if (action !== "generate" && action !== "save" && action !== "discard") {
        return { ok: false, error: "无效的联机记录操作" };
      }
      return minecraftManager.handleSummaryAction(id, action);
    }
    const configPatch = patch as Partial<GameBotSettings>;
    const previous = loadGameBotSettings();
    const saved = saveGameBotSettings(configPatch);
    if (configPatch.minecraft?.autonomy?.mode && previous.minecraft.autonomy.mode !== saved.minecraft.autonomy.mode) {
      minecraftManager.updateAutonomy(saved.minecraft.autonomy);
    }
    // enabled 开关同步到 agent 工具，关了 agent 就看不到/调不到
    toolRegistry.setEnabled("game_bot_start", saved.enabled);
    return saved;
  });
  ipcMain.handle(IPC.GAME_BOT_LIST_RECIPES, () => listRecipes());
  ipcMain.handle(IPC.GAME_BOT_LIST_REFS, (_e, recipeId: string) => listRefs(recipeId));
  ipcMain.handle(IPC.GAME_BOT_REFS_DIR, (_e, recipeId: string) => refsDirPath(recipeId));
  ipcMain.handle(IPC.GAME_BOT_START, async (event) => {
    const settings = loadGameBotSettings();
    const result = await startGameBot();
    if (result.ok && settings.activeRecipe === "star-rail-currency-wars" && settings.currencyWars.targetMode === "fullscreen") {
      BrowserWindow.fromWebContents(event.sender)?.minimize();
    }
    return result;
  });
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
    inputSchema: { type: "object", properties: {}, required: [] },
    execute: async () => {
      const r = await startGameBot();
      if (r.ok) return "✅ 代肝已启动，正在后台运行，进度会实时更新。";
      return "[错误·配置] 代肝启动失败: " + (r.error ?? "未知错误");
    },
  });

  console.log(LOG, "已初始化：IPC + game_bot_start 工具，可用脚本:", listRecipes().map((r) => r.id).join(", ") || "(无)");
}
