import "../ui/theme";
import "./gamebot.css";

type CurrencyWarsConfig = {
  flowMode: "outer" | "combined";
  targetMode: "fullscreen" | "window";
  autoLaunch: boolean;
  windowTitle: string;
  targetWords: string[];
  debuffEnabled: boolean;
  targetMatchAny: boolean;
  blockedWords: string[];
  blockedEnabled: boolean;
  investmentTargets: string[];
  investmentEnabled: boolean;
  checkInvestmentWhenBlocked: boolean;
  strategyTargets: string[];
  inGameInvestmentTargets: string[];
  combinedMainRule: "ignore" | "require" | "stop" | "optional";
  combinedBlockedRule: "ignore" | "restart" | "continue";
  combinedOuterInvestmentRule: "ignore" | "require" | "optional" | "stop";
  combinedInGameInvestmentRule: "ignore" | "require" | "optional";
  fuzzyScore: number;
  blockedFuzzyScore: number;
  buttonFuzzyScore: number;
  investmentFuzzyScore: number;
  maxRounds: number;
  stopOnTargetMatch: boolean;
  recognitionOnly: boolean;
  elevatedInput: boolean;
  autoDetectOcr: boolean;
  ocrCommand: string;
  ocrArgs: string[];
};

type GameBotConfig = {
  enabled: boolean;
  exePath: string;
  activeRecipe: string;
  vlm: { baseUrl: string; apiKey: string; model: string };
  currencyWars: CurrencyWarsConfig;
};

interface GameBotApi {
  minimize: () => void;
  close: () => void;
  getConfig: () => Promise<GameBotConfig>;
  saveConfig: (config: Partial<GameBotConfig>) => Promise<GameBotConfig>;
  listRecipes: () => Promise<{ id: string; name: string }[]>;
  listRefs: (recipeId: string) => Promise<string[]>;
  refsDir: (recipeId: string) => Promise<string>;
  start: () => Promise<{ ok: boolean; error?: string }>;
  stop: () => Promise<unknown>;
  onProgress: (callback: (info: unknown) => void) => (() => void) | void;
}

declare global {
  interface Window { gameBot?: GameBotApi; }
}

const api = window.gameBot;
const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

byId<HTMLButtonElement>("gamebot-min-btn").addEventListener("click", () => api?.minimize());
byId<HTMLButtonElement>("gamebot-close-btn").addEventListener("click", () => api?.close());

if (!api) {
  byId("gamebot-status").textContent = "Game Bot API 不可用";
} else {
  const enabledBadge = byId("gamebot-enabled-badge");
  const exe = byId<HTMLInputElement>("gamebot-exe");
  const url = byId<HTMLInputElement>("gamebot-vlm-url");
  const key = byId<HTMLInputElement>("gamebot-vlm-key");
  const model = byId<HTMLInputElement>("gamebot-vlm-model");
  const recipeSelect = byId<HTMLSelectElement>("gamebot-recipe");
  const refsDir = byId("gamebot-refs-dir");
  const refsList = byId("gamebot-refs-list");
  const currencyPanel = byId("gamebot-currency-wars-config");
  const status = byId("gamebot-status");
  const log = byId("gamebot-log");
  const cwWindowTitle = byId<HTMLInputElement>("gamebot-cw-window-title");
  const cwFlowMode = byId<HTMLSelectElement>("gamebot-cw-flow-mode");
  const cwTargetMode = byId<HTMLSelectElement>("gamebot-cw-target-mode");
  const cwAutoLaunch = byId<HTMLInputElement>("gamebot-cw-auto-launch");
  const targetHint = byId("gamebot-target-hint");
  const cwFuzzyScore = byId<HTMLInputElement>("gamebot-cw-fuzzy-score");
  const cwMaxRounds = byId<HTMLInputElement>("gamebot-cw-max-rounds");
  const cwMatchAny = byId<HTMLInputElement>("gamebot-cw-match-any");
  const cwDebuffEnabled = byId<HTMLInputElement>("gamebot-cw-debuff-enabled");
  const cwBlockedEnabled = byId<HTMLInputElement>("gamebot-cw-blocked-enabled");
  const cwInvestmentEnabled = byId<HTMLInputElement>("gamebot-cw-investment-enabled");
  const cwCheckInvestmentBlocked = byId<HTMLInputElement>("gamebot-cw-check-investment-blocked");
  const cwStopTarget = byId<HTMLInputElement>("gamebot-cw-stop-target");
  const cwRecognitionOnly = byId<HTMLInputElement>("gamebot-cw-recognition-only");
  const cwElevatedInput = byId<HTMLInputElement>("gamebot-cw-elevated-input");
  const cwTargets = byId<HTMLTextAreaElement>("gamebot-cw-targets");
  const cwBlocked = byId<HTMLTextAreaElement>("gamebot-cw-blocked");
  const cwInvestments = byId<HTMLTextAreaElement>("gamebot-cw-investments");
  const cwStrategies = byId<HTMLTextAreaElement>("gamebot-cw-strategies");
  const cwInGameInvestments = byId<HTMLTextAreaElement>("gamebot-cw-ingame-investments");
  const cwMainRule = byId<HTMLSelectElement>("gamebot-cw-main-rule");
  const cwBlockedRule = byId<HTMLSelectElement>("gamebot-cw-blocked-rule");
  const cwOuterInvestmentRule = byId<HTMLSelectElement>("gamebot-cw-outer-investment-rule");
  const cwInGameInvestmentRule = byId<HTMLSelectElement>("gamebot-cw-ingame-investment-rule");
  const cwBlockedFuzzyScore = byId<HTMLInputElement>("gamebot-cw-blocked-fuzzy-score");
  const cwButtonFuzzyScore = byId<HTMLInputElement>("gamebot-cw-button-fuzzy-score");
  const cwInvestmentFuzzyScore = byId<HTMLInputElement>("gamebot-cw-investment-fuzzy-score");
  const cwOcrCommand = byId<HTMLInputElement>("gamebot-cw-ocr-command");
  const cwOcrArgs = byId<HTMLTextAreaElement>("gamebot-cw-ocr-args");
  const cwAutoDetectOcr = byId<HTMLInputElement>("gamebot-cw-auto-detect-ocr");
  let currentRecipe = "star-rail-daily";

  const readLines = (element: HTMLTextAreaElement): string[] => Array.from(new Set(
    element.value.split(/\r?\n|，|,/).map((line) => line.trim()).filter(Boolean),
  ));
  const appendLog = (line: string): void => {
    log.textContent = `${new Date().toLocaleTimeString()} ${line}\n${log.textContent ?? ""}`;
  };
  const updateRecipePanel = (): void => {
    currencyPanel.hidden = currentRecipe !== "star-rail-currency-wars";
  };
  const updateTargetMode = (): void => {
    const fullscreen = cwTargetMode.value === "fullscreen";
    cwWindowTitle.disabled = fullscreen;
    targetHint.textContent = fullscreen
      ? "本地全屏模式会检查 StarRail.exe，并在开始后自动最小化控制台。"
      : "云游戏模式按窗口标题定位；同时打开多个同名窗口时请只保留目标窗口。";
  };
  const refreshRefs = async (): Promise<void> => {
    refsDir.textContent = await api.refsDir(currentRecipe);
    const refs = await api.listRefs(currentRecipe);
    refsList.textContent = refs.length ? `已就位参考图：${refs.join(" · ")}` : "目录中暂无参考图";
  };
  const saveFields = async (): Promise<void> => {
    await api.saveConfig({
      exePath: exe.value.trim(),
      activeRecipe: recipeSelect.value,
      vlm: { baseUrl: url.value.trim(), apiKey: key.value.trim(), model: model.value.trim() },
      currencyWars: {
        flowMode: cwFlowMode.value === "outer" ? "outer" : "combined",
        targetMode: cwTargetMode.value === "window" ? "window" : "fullscreen",
        autoLaunch: cwAutoLaunch.checked,
        windowTitle: cwWindowTitle.value.trim() || "崩坏",
        targetWords: readLines(cwTargets),
        debuffEnabled: cwDebuffEnabled.checked,
        targetMatchAny: cwMatchAny.checked,
        blockedWords: readLines(cwBlocked),
        blockedEnabled: cwBlockedEnabled.checked,
        investmentTargets: readLines(cwInvestments),
        investmentEnabled: cwInvestmentEnabled.checked,
        checkInvestmentWhenBlocked: cwCheckInvestmentBlocked.checked,
        strategyTargets: readLines(cwStrategies),
        inGameInvestmentTargets: readLines(cwInGameInvestments),
        combinedMainRule: cwMainRule.value as CurrencyWarsConfig["combinedMainRule"],
        combinedBlockedRule: cwBlockedRule.value as CurrencyWarsConfig["combinedBlockedRule"],
        combinedOuterInvestmentRule: cwOuterInvestmentRule.value as CurrencyWarsConfig["combinedOuterInvestmentRule"],
        combinedInGameInvestmentRule: cwInGameInvestmentRule.value as CurrencyWarsConfig["combinedInGameInvestmentRule"],
        fuzzyScore: Number(cwFuzzyScore.value || 85),
        blockedFuzzyScore: Number(cwBlockedFuzzyScore.value || 85),
        buttonFuzzyScore: Number(cwButtonFuzzyScore.value || 78),
        investmentFuzzyScore: Number(cwInvestmentFuzzyScore.value || 88),
        maxRounds: Number(cwMaxRounds.value || 0),
        stopOnTargetMatch: cwStopTarget.checked,
        recognitionOnly: cwRecognitionOnly.checked,
        elevatedInput: cwElevatedInput.checked,
        autoDetectOcr: cwAutoDetectOcr.checked,
        ocrCommand: cwOcrCommand.value.trim(),
        ocrArgs: readLines(cwOcrArgs),
      },
    });
    status.textContent = "配置已保存";
  };

  const refresh = async (): Promise<void> => {
    const config = await api.getConfig();
    enabledBadge.textContent = config.enabled ? "Gamebot 已启用" : "请先在设置中启用";
    enabledBadge.classList.toggle("is-disabled", !config.enabled);
    exe.value = config.exePath;
    url.value = config.vlm.baseUrl;
    key.value = config.vlm.apiKey;
    model.value = config.vlm.model;
    currentRecipe = config.activeRecipe;
    cwFlowMode.value = config.currencyWars.flowMode;
    cwTargetMode.value = config.currencyWars.targetMode;
    cwAutoLaunch.checked = config.currencyWars.autoLaunch;
    cwWindowTitle.value = config.currencyWars.windowTitle;
    cwFuzzyScore.value = String(config.currencyWars.fuzzyScore);
    cwMaxRounds.value = String(config.currencyWars.maxRounds);
    cwMatchAny.checked = config.currencyWars.targetMatchAny;
    cwDebuffEnabled.checked = config.currencyWars.debuffEnabled;
    cwBlockedEnabled.checked = config.currencyWars.blockedEnabled;
    cwInvestmentEnabled.checked = config.currencyWars.investmentEnabled;
    cwCheckInvestmentBlocked.checked = config.currencyWars.checkInvestmentWhenBlocked;
    cwStopTarget.checked = config.currencyWars.stopOnTargetMatch;
    cwRecognitionOnly.checked = config.currencyWars.recognitionOnly;
    cwElevatedInput.checked = config.currencyWars.elevatedInput;
    cwTargets.value = config.currencyWars.targetWords.join("\n");
    cwBlocked.value = config.currencyWars.blockedWords.join("\n");
    cwInvestments.value = config.currencyWars.investmentTargets.join("\n");
    cwStrategies.value = config.currencyWars.strategyTargets.join("\n");
    cwInGameInvestments.value = config.currencyWars.inGameInvestmentTargets.join("\n");
    cwMainRule.value = config.currencyWars.combinedMainRule;
    cwBlockedRule.value = config.currencyWars.combinedBlockedRule;
    cwOuterInvestmentRule.value = config.currencyWars.combinedOuterInvestmentRule;
    cwInGameInvestmentRule.value = config.currencyWars.combinedInGameInvestmentRule;
    cwBlockedFuzzyScore.value = String(config.currencyWars.blockedFuzzyScore);
    cwButtonFuzzyScore.value = String(config.currencyWars.buttonFuzzyScore);
    cwInvestmentFuzzyScore.value = String(config.currencyWars.investmentFuzzyScore);
    cwOcrCommand.value = config.currencyWars.ocrCommand;
    cwOcrArgs.value = config.currencyWars.ocrArgs.join("\n");
    cwAutoDetectOcr.checked = config.currencyWars.autoDetectOcr;
    const recipes = await api.listRecipes();
    recipeSelect.replaceChildren(...recipes.map((recipe) => {
      const option = document.createElement("option");
      option.value = recipe.id;
      option.textContent = `${recipe.name} (${recipe.id})`;
      option.selected = recipe.id === currentRecipe;
      return option;
    }));
    updateRecipePanel();
    updateTargetMode();
    await refreshRefs();
  };

  for (const element of [exe, url, key, model, cwWindowTitle, cwFlowMode, cwTargetMode, cwAutoLaunch, cwFuzzyScore, cwBlockedFuzzyScore, cwButtonFuzzyScore, cwInvestmentFuzzyScore, cwMaxRounds, cwMatchAny, cwDebuffEnabled, cwBlockedEnabled, cwInvestmentEnabled, cwCheckInvestmentBlocked, cwStopTarget, cwRecognitionOnly, cwElevatedInput, cwTargets, cwBlocked, cwInvestments, cwStrategies, cwInGameInvestments, cwMainRule, cwBlockedRule, cwOuterInvestmentRule, cwInGameInvestmentRule, cwAutoDetectOcr, cwOcrCommand, cwOcrArgs]) {
    element.addEventListener("change", () => void saveFields());
  }
  cwTargetMode.addEventListener("change", updateTargetMode);
  recipeSelect.addEventListener("change", () => {
    currentRecipe = recipeSelect.value;
    updateRecipePanel();
    void saveFields().then(refreshRefs);
  });
  byId<HTMLButtonElement>("gamebot-start-btn").addEventListener("click", async () => {
    await saveFields();
    const result = await api.start();
    status.textContent = result.ok ? "正在启动…" : "启动失败";
    appendLog(result.ok ? "Gamebot 已启动" : `启动失败：${result.error ?? "未知错误"}`);
  });
  byId<HTMLButtonElement>("gamebot-stop-btn").addEventListener("click", () => {
    void api.stop();
    status.textContent = "正在停止…";
    appendLog("已请求停止");
  });
  api.onProgress((raw) => {
    const info = raw as { index: number; total: number; desc: string };
    status.textContent = info.desc;
    appendLog(info.desc + (info.index >= 0 ? ` (${info.index + 1}/${info.total})` : ""));
  });
  void refresh().catch((error) => {
    status.textContent = "配置加载失败";
    appendLog(error instanceof Error ? error.message : String(error));
  });
}

export {};
