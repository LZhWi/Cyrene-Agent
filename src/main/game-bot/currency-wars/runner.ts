import type { ProgressCb } from "../bot-tools";
import { fuzzyContains, matchWords } from "../text-matcher";
import type { OcrResult, OcrTextItem } from "../vlm-locator";
import type { RatioPoint, RatioRegion, WindowCapture, WindowTarget } from "../window-target";
import { collectionMarkerScores, detectAutoBattleDisabled } from "./image-detectors";
import type { CurrencyWarsSettings } from "./types";

export interface CurrencyWarsRunTools {
  launch(exe: string): Promise<void>;
  findWindow(titleKeyword: string): Promise<WindowTarget | null>;
  findFullscreen(exe: string): Promise<WindowTarget | null>;
  capture(target: WindowTarget, region?: RatioRegion): Promise<WindowCapture>;
  recognize(capture: WindowCapture): Promise<OcrResult | null>;
  click(x: number, y: number): Promise<void>;
  drag(start: { x: number; y: number }, end: { x: number; y: number }): Promise<void>;
  key(combo: string): Promise<void>;
  delay(ms: number): Promise<void>;
}

export interface CurrencyWarsRunContext {
  exe: string;
  settings: CurrencyWarsSettings;
  tools: CurrencyWarsRunTools;
  signal: { aborted: boolean };
  onProgress?: ProgressCb;
}

export interface CurrencyWarsRunResult {
  ok: boolean;
  rounds: number;
  matched?: string;
  error?: string;
}

export interface CombinedRoundDecision {
  shouldStopOnDebuff: boolean;
  roundCanContinue: boolean;
}

export function evaluateCombinedRound(
  settings: CurrencyWarsSettings,
  targetSatisfied: boolean,
  blockedHit: boolean,
): CombinedRoundDecision {
  const mainTargetEmpty = !settings.debuffEnabled || settings.targetWords.length === 0;
  const mainMatched = settings.combinedMainRule === "ignore" || mainTargetEmpty || targetSatisfied;
  const blockedRejectsRound = settings.blockedEnabled
    && settings.combinedBlockedRule === "restart"
    && blockedHit;
  return {
    shouldStopOnDebuff: settings.combinedMainRule === "stop" && targetSatisfied && !blockedHit,
    roundCanContinue: !blockedRejectsRound
      && (settings.combinedMainRule !== "require" || mainMatched),
  };
}

const FULL: RatioRegion = { x: 0, y: 0, width: 1, height: 1 };
const TOP_HALF: RatioRegion = { x: 0, y: 0, width: 1, height: 0.5 };
const BOTTOM_HALF: RatioRegion = { x: 0, y: 0.5, width: 1, height: 0.5 };
const OPENING_ADVANCE: RatioPoint = { x: 1660 / 1920, y: 965 / 1080 };
const OPENING_ADVANCE_DURATION_MS = 3500;
const OPENING_ADVANCE_INTERVAL_MS = 300;
const DEBUFF_CHECK_DELAY_MS = 4000;
const DEBUFF_RECHECK_ATTEMPTS = 11;
const DEBUFF_RECHECK_INTERVAL_MS = 300;
const DEBUFF_SCREEN_HINTS = ["敌人难度", "下一步", "随从强化", "沉重脚步", "变宝为废"];
const SPECIAL_INVESTMENT_BLACKLIST = [
  "蓝海", "蓝嗨", "蓝烸", "蓝嵰",
  "特邀专家：银狼", "专家研讨会", "特邀专家：加拉赫", "特邀专家：停云",
];
const INVESTMENT_FALLBACK_POINTS: RatioPoint[] = [
  { x: 0.23, y: 0.38 }, { x: 0.5, y: 0.38 }, { x: 0.77, y: 0.38 },
];
const PREPARE_SLOTS: RatioPoint[] = [
  { x: 0.229, y: 0.846 }, { x: 0.294, y: 0.845 },
  { x: 0.359, y: 0.846 }, { x: 0.425, y: 0.843 },
  { x: 0.489, y: 0.844 },
];
const FORWARD_SLOTS: RatioPoint[] = [
  { x: 0.388, y: 0.367 }, { x: 0.462, y: 0.368 },
  { x: 0.537, y: 0.368 }, { x: 0.609, y: 0.37 },
];
const DIALOG: RatioRegion = { x: 0.2, y: 0.04, width: 0.7, height: 0.65 };
const ROLE_TITLE: RatioRegion = { x: 0.34, y: 0.03, width: 0.42, height: 0.12 };
const BATTLE_BUTTON_REGION: RatioRegion = { x: 0.84, y: 0.62, width: 0.16, height: 0.22 };
const AUTO_BATTLE_REGION: RatioRegion = { x: 0, y: 903 / 1080, width: 144 / 1920, height: 120 / 1080 };
const STRATEGY_REGION: RatioRegion = { x: 0, y: 0.08, width: 1, height: 0.66 };
const STRATEGY_SCREEN_ALIASES = ["请选择投资策略", "刷新次数", "返回备战界面"];
const CONTINUE_ALIASES = ["点击空白处继续", "下一步", "下一页", "继续挑战", "前往结算", "确认"];
export const STRATEGY_REFRESH_POINTS: readonly RatioPoint[] = [
  { x: 0.203, y: 0.756 }, { x: 0.462, y: 0.756 }, { x: 0.724, y: 0.756 },
];
const STRATEGY_CARDS: RatioPoint[] = [
  { x: 0.24, y: 0.455 }, { x: 0.5, y: 0.455 }, { x: 0.76, y: 0.455 },
];
const CARD_REGIONS: RatioRegion[] = [
  { x: 202 / 1920, y: 195 / 1080, width: 470 / 1920, height: 672 / 1080 },
  { x: 725 / 1920, y: 196 / 1080, width: 468 / 1920, height: 670 / 1080 },
  { x: 1247 / 1920, y: 198 / 1080, width: 465 / 1920, height: 668 / 1080 },
];
const STRATEGY_BLACKLIST = ["远见", "黄金投资", "白银投资", "轮回不止"];

class StopError extends Error {}

function pointIn(target: WindowTarget, point: RatioPoint): { x: number; y: number } {
  return {
    x: target.left + Math.round(target.width * point.x),
    y: target.top + Math.round(target.height * point.y),
  };
}

function findItem(items: OcrTextItem[], aliases: string[], fuzzyScore: number): OcrTextItem | null {
  for (const alias of aliases) {
    const match = items.find((item) => fuzzyContains(item.text, alias, fuzzyScore));
    if (match) return match;
  }
  return null;
}

function findItemWithAlias(items: OcrTextItem[], aliases: string[], fuzzyScore: number): { item: OcrTextItem; alias: string } | null {
  for (const alias of aliases) {
    const item = items.find((candidate) => fuzzyContains(candidate.text, alias, fuzzyScore));
    if (item) return { item, alias };
  }
  return null;
}

function chooseSafeInvestment(items: OcrTextItem[], fuzzyScore: number): RatioPoint {
  const blocked = new Set<number>();
  for (const item of items) {
    if (!SPECIAL_INVESTMENT_BLACKLIST.some((word) => fuzzyContains(item.text, word, Math.max(76, fuzzyScore - 10)))) continue;
    const centerX = item.bounds.x + item.bounds.width / 2;
    blocked.add(Math.max(0, Math.min(2, Math.floor(centerX / (1000 / 3)))));
  }
  const chosen = [1, 0, 2].find((index) => !blocked.has(index)) ?? 1;
  return INVESTMENT_FALLBACK_POINTS[chosen];
}

export async function runCurrencyWars(ctx: CurrencyWarsRunContext): Promise<CurrencyWarsRunResult> {
  const { settings, tools, signal } = ctx;
  let rounds = 0;

  const findTarget = () => settings.targetMode === "fullscreen"
    ? tools.findFullscreen(ctx.exe)
    : tools.findWindow(settings.windowTitle);
  const targetDescription = settings.targetMode === "fullscreen"
    ? `本地游戏进程 ${ctx.exe.split(/[\\/]/).pop() ?? ctx.exe}`
    : `标题包含“${settings.windowTitle}”的云游戏窗口`;

  const checkStopped = () => {
    if (signal.aborted) throw new StopError("已中止");
  };
  const delay = async (ms: number) => { checkStopped(); await tools.delay(ms); checkStopped(); };
  const progress = (desc: string) => ctx.onProgress?.({
    index: Math.max(0, rounds - 1),
    total: settings.maxRounds || Math.max(1, rounds),
    desc: `货币战争 · 第 ${Math.max(1, rounds)} 轮 · ${desc}`,
  });
  const getWindow = async (): Promise<WindowTarget> => {
    checkStopped();
    const target = await findTarget();
    if (!target) throw new Error(`找不到${targetDescription}`);
    return target;
  };
  const clickRatio = async (point: RatioPoint) => {
    const target = await getWindow();
    const resolved = pointIn(target, point);
    await tools.click(resolved.x, resolved.y);
  };
  const scan = async (region: RatioRegion = FULL): Promise<{ capture: WindowCapture; result: OcrResult }> => {
    const capture = await tools.capture(await getWindow(), region);
    const result = await tools.recognize(capture);
    if (!result) throw new Error("OCR/VLM 没有返回可解析结果");
    return { capture, result };
  };
  const clickText = async (
    aliases: string[],
    fallback?: RatioPoint,
    region: RatioRegion = FULL,
    timeoutMs = 8000,
  ): Promise<boolean> => {
    const attempts = Math.max(1, Math.ceil(timeoutMs / 600));
    for (let attempt = 0; attempt < attempts; attempt++) {
      checkStopped();
      const { capture, result } = await scan(region);
      const item = findItem(result.items, aliases, settings.buttonFuzzyScore);
      if (item) {
        const x = capture.screenRegion.left + Math.round(capture.width * (item.bounds.x + item.bounds.width / 2) / 1000);
        const y = capture.screenRegion.top + Math.round(capture.height * (item.bounds.y + item.bounds.height / 2) / 1000);
        await tools.click(x, y);
        return true;
      }
      if (attempt + 1 < attempts) await delay(600);
    }
    if (fallback) await clickRatio(fallback);
    return false;
  };
  const clickRecognized = async (capture: WindowCapture, item: OcrTextItem) => {
    const x = capture.screenRegion.left
      + Math.round(capture.width * (item.bounds.x + item.bounds.width / 2) / 1000);
    const y = capture.screenRegion.top
      + Math.round(capture.height * (item.bounds.y + item.bounds.height / 2) / 1000);
    await tools.click(x, y);
  };
  const captureOnly = async (region: RatioRegion = FULL) => tools.capture(await getWindow(), region);
  const handleRoleChoice = async (current: Awaited<ReturnType<typeof scan>>): Promise<boolean> => {
    const target = await getWindow();
    const inTitle = (item: OcrTextItem) => {
      const x = current.capture.screenRegion.left + current.capture.width * (item.bounds.x + item.bounds.width / 2) / 1000;
      const y = current.capture.screenRegion.top + current.capture.height * (item.bounds.y + item.bounds.height / 2) / 1000;
      const rx = (x - target.left) / target.width;
      const ry = (y - target.top) / target.height;
      return rx >= ROLE_TITLE.x && rx <= ROLE_TITLE.x + ROLE_TITLE.width
        && ry >= ROLE_TITLE.y && ry <= ROLE_TITLE.y + ROLE_TITLE.height;
    };
    const hasTitle = (aliases: string[]) => {
      const found = findItem(current.result.items, aliases, settings.buttonFuzzyScore);
      return found && inTitle(found);
    };
    if (hasTitle(["选择伙伴"])) {
      await clickRatio({ x: 0.545, y: 0.277 }); await delay(200);
      await clickRatio({ x: 0.777, y: 0.551 }); await delay(500);
      return true;
    }
    if (hasTitle(["祈愿试炼"])) {
      await clickRatio(Math.random() < 0.5 ? { x: 0.357, y: 0.33 } : { x: 0.734, y: 0.33 }); await delay(200);
      await clickRatio({ x: 0.78, y: 0.593 }); await delay(500);
      return true;
    }
    if (hasTitle(["盛会之星"])) {
      await clickRatio(Math.random() < 0.5 ? { x: 0.485, y: 0.255 } : { x: 0.61, y: 0.255 }); await delay(200);
      await clickRatio({ x: 0.775, y: 0.523 }); await delay(500);
      return true;
    }
    return false;
  };
  const handleUnderfilledTeam = async () => {
    await delay(500);
    const current = await scan(DIALOG);
    if (!findItem(current.result.items, ["可出战角色人数未达上限", "是否确认出战", "本局不再提示"], settings.buttonFuzzyScore)) return;
    await clickRatio({ x: 0.463, y: 0.56 }); await delay(200);
    await clickRatio({ x: 0.612, y: 0.622 }); await delay(500);
  };
  const ensureAutoBattle = async (single = false) => {
    let switches = 0;
    const attempts = single ? 1 : 10;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const capture = await captureOnly(AUTO_BATTLE_REGION);
      const detection = await detectAutoBattleDisabled(capture.base64);
      if (detection.disabled && switches < 3) {
        switches++;
        await tools.key("V");
        if (!single) await delay(1000);
      } else if (switches > 0 && !detection.disabled) {
        return;
      } else if (!single && attempt < attempts - 1) {
        await delay(1000);
      }
    }
  };
  const deployOpeningCharacters = async () => {
    const target = await getWindow();
    for (let index = 0; index < 4; index++) {
      await tools.drag(pointIn(target, PREPARE_SLOTS[index]), pointIn(target, FORWARD_SLOTS[index]));
      await delay(500);
    }
    await tools.drag(pointIn(target, PREPARE_SLOTS[4]), pointIn(target, FORWARD_SLOTS[0]));
    await delay(500);
  };
  const clickBattleButton = async (battleCount: number): Promise<boolean> => {
    const current = await scan(BATTLE_BUTTON_REGION);
    const item = findItem(current.result.items, ["出战", "跳过"], settings.buttonFuzzyScore);
    let point = pointIn(await getWindow(), { x: 0.952, y: 0.694 });
    if (item) {
      point = {
        x: current.capture.screenRegion.left + Math.round(current.capture.width * (item.bounds.x + item.bounds.width / 2) / 1000),
        y: current.capture.screenRegion.top + Math.round(current.capture.height * (item.bounds.y + item.bounds.height / 2) / 1000),
      };
    }
    for (let index = 0; index < 3; index++) {
      await tools.click(point.x, point.y);
      if (index < 2) await delay(400);
    }
    await handleUnderfilledTeam();
    await delay(800);
    const remaining = await scan(BATTLE_BUTTON_REGION);
    progress(`局内第 ${battleCount + 1} 次出战确认`);
    return !findItem(remaining.result.items, ["出战", "跳过"], settings.buttonFuzzyScore);
  };
  const runOpeningBattles = async () => {
    let battleCount = 0;
    let continueCount = 0;
    for (let cycle = 0; cycle < 300 && continueCount < 2; cycle++) {
      const current = await scan();
      if (battleCount > continueCount) await ensureAutoBattle(true);
      if (await handleRoleChoice(current)) continue;
      const continued = findItemWithAlias(current.result.items, CONTINUE_ALIASES, settings.buttonFuzzyScore);
      if (continued) {
        await clickRecognized(current.capture, continued.item);
        if (fuzzyContains(continued.alias, "继续挑战", 100)) continueCount++;
        await delay(200);
        continue;
      }
      if (findItem(current.result.items, ["出战", "跳过"], settings.buttonFuzzyScore)) {
        if (await clickBattleButton(battleCount)) {
          battleCount++;
          await ensureAutoBattle();
          await delay(10000);
        }
        continue;
      }
      await clickRatio({ x: 0.5, y: 0.58 });
      await delay(1000);
    }
  };
  const tryTargetStrategy = async (attempts: number): Promise<string | null> => {
    let best: { item: OcrTextItem; alias: string; capture: WindowCapture; priority: number } | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const current = await scan(STRATEGY_REGION);
      const found = findItemWithAlias(current.result.items, settings.strategyTargets, Math.max(85, settings.fuzzyScore));
      if (found) {
        const priority = settings.strategyTargets.indexOf(found.alias);
        if (!best || priority < best.priority) best = { ...found, capture: current.capture, priority };
        if (priority === 0) break;
      }
      if (attempt < attempts - 1) await delay(100);
    }
    if (!best) return null;
    await clickRecognized(best.capture, best.item);
    return best.alias;
  };
  const runStrategyRecognition = async (allowExtraRefresh: boolean): Promise<string | null> => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const current = await scan();
      if (findItem(current.result.items, STRATEGY_SCREEN_ALIASES, 85)) break;
      if (attempt === 29) return null;
      await delay(1000);
    }
    let hit = await tryTargetStrategy(2);
    if (hit) return hit;
    for (let index = 0; index < STRATEGY_REFRESH_POINTS.length; index++) {
      await clickRatio(STRATEGY_REFRESH_POINTS[index]);
      if (index < STRATEGY_REFRESH_POINTS.length - 1) await delay(200);
    }
    await delay(500);
    hit = await tryTargetStrategy(1);
    if (hit) return hit;
    for (let round = 0; allowExtraRefresh && round < 2; round++) {
      for (let index = 0; index < STRATEGY_REFRESH_POINTS.length; index++) {
        await clickRatio(STRATEGY_REFRESH_POINTS[index]);
        if (index < STRATEGY_REFRESH_POINTS.length - 1) await delay(200);
      }
      await delay(500);
      hit = await tryTargetStrategy(2);
      if (hit) return hit;
    }
    const current = await scan(STRATEGY_REGION);
    const blocked = new Set<number>();
    for (const item of current.result.items) {
      if (STRATEGY_BLACKLIST.some((word) => fuzzyContains(item.text, word, 85))) {
        blocked.add(Math.max(0, Math.min(2, Math.floor((item.bounds.x + item.bounds.width / 2) / (1000 / 3)))));
      }
    }
    const full = await captureOnly();
    const scores = await collectionMarkerScores(full.base64, CARD_REGIONS);
    const preferred = [1, 0, 2].find((column) => !blocked.has(column) && scores[column] >= 0.9);
    const candidates = [0, 1, 2].filter((column) => !blocked.has(column));
    const chosen = preferred ?? (candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : Math.floor(Math.random() * 3));
    await clickRatio(STRATEGY_CARDS[chosen]);
    await delay(100);
    await clickRatio({ x: 0.5, y: 0.91 });
    return null;
  };
  const scanDebuffPage = async () => {
    await delay(DEBUFF_CHECK_DELAY_MS);
    let latest: Awaited<ReturnType<typeof scan>> | null = null;
    for (let attempt = 0; attempt < DEBUFF_RECHECK_ATTEMPTS; attempt++) {
      latest = await scan(BOTTOM_HALF);
      const targets = matchWords(settings.debuffEnabled ? settings.targetWords : [], latest.result.rawText, settings.fuzzyScore);
      const blocked = matchWords(settings.blockedEnabled ? settings.blockedWords : [], latest.result.rawText, settings.blockedFuzzyScore);
      const targetSatisfied = settings.debuffEnabled && settings.targetWords.length > 0
        && (settings.targetMatchAny ? targets.hits.length > 0 : targets.missing.length === 0);
      const pageReady = DEBUFF_SCREEN_HINTS.some((hint) => fuzzyContains(latest!.result.rawText, hint, settings.buttonFuzzyScore));
      if (blocked.hits.length > 0 || targetSatisfied || pageReady) return latest;
      if (attempt + 1 < DEBUFF_RECHECK_ATTEMPTS) await delay(DEBUFF_RECHECK_INTERVAL_MS);
    }
    return latest!;
  };
  const waitForOpeningBoard = async () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const current = await scan();
      if (findItem(current.result.items, ["备战阶段", "出战"], settings.buttonFuzzyScore)
        || ["备战阶段", "出战"].some((word) => fuzzyContains(current.result.rawText, word, settings.buttonFuzzyScore))) {
        return;
      }
      if (attempt < 49) await delay(600);
    }
    throw new Error("等待局内备战页超时，已停止后续点击");
  };
  const returnToCurrencyWars = async () => {
    progress("退出结算并准备重开");
    let settlementClicked = false;
    for (let attempt = 0; attempt < 34; attempt++) {
      await clickRatio({ x: 0.035, y: 0.055 });
      await delay(600);
      const current = await scan();
      const settlement = findItem(current.result.items, ["放弃并结算", "放弃", "结算"], settings.buttonFuzzyScore);
      if (settlement) {
        await clickRecognized(current.capture, settlement);
        settlementClicked = true;
        break;
      }
    }
    if (!settlementClicked) {
      for (let index = 0; index < 7; index++) {
        await clickRatio({ x: 0.035, y: 0.055 });
        await delay(110);
        await clickRatio({ x: 0.39, y: 0.69 });
        await delay(110);
      }
    }
    await delay(400);
    for (let attempt = 0; attempt < 54; attempt++) {
      const current = await scan();
      if (findItem(current.result.items, ["下一步"], settings.buttonFuzzyScore)
        || fuzzyContains(current.result.rawText, "下一步", settings.buttonFuzzyScore)) break;
      if (attempt < 53) await delay(150);
    }
    for (let index = 0; index < 6; index++) {
      await clickRatio({ x: 0.5, y: 0.829 });
      await delay(110);
    }
    await delay(700);
    for (let attempt = 0; attempt < 14; attempt++) {
      const current = await scan();
      if (findItem(current.result.items, ["开始货币战争"], settings.buttonFuzzyScore)
        || fuzzyContains(current.result.rawText, "开始货币战争", settings.buttonFuzzyScore)) return;
      if (["当前进度", "继续进度", "结束并结算"]
        .some((word) => fuzzyContains(current.result.rawText, word, settings.buttonFuzzyScore))) {
        throw new Error("结算返回未完成，已阻止开始下一轮");
      }
      if (attempt < 13) await delay(300);
    }
    throw new Error("未能确认返回货币战争首页，已阻止开始下一轮");
  };

  try {
    let target = await findTarget();
    if (!target && settings.autoLaunch) {
      progress("启动游戏");
      await tools.launch(ctx.exe);
      for (let attempt = 0; attempt < 90 && !target; attempt++) {
        await delay(1000);
        target = await findTarget();
      }
    }
    if (!target) {
      const action = settings.autoLaunch ? "自动启动后 90 秒内仍未找到" : "请先手动启动，并确认目标模式选择正确：";
      return { ok: false, rounds, error: action + targetDescription };
    }

    if (settings.recognitionOnly) {
      rounds = 1;
      progress("只识别测试");
      const current = await scan();
      const targets = matchWords(settings.debuffEnabled ? settings.targetWords : [], current.result.rawText, settings.fuzzyScore).hits;
      const blocked = matchWords(settings.blockedEnabled ? settings.blockedWords : [], current.result.rawText, settings.blockedFuzzyScore).hits;
      const summary = [
        targets.length > 0 ? "目标=" + targets.join("、") : "目标=未命中",
        blocked.length > 0 ? "禁止=" + blocked.join("、") : "禁止=未命中",
        `OCR文本块=${current.result.items.length}`,
      ].join("；");
      return { ok: true, rounds, matched: "识别测试：" + summary };
    }

    await delay(1000);

    while (!settings.maxRounds || rounds < settings.maxRounds) {
      checkStopped();
      rounds++;
      progress("快速通过开局页面");
      const openingClicks = Math.ceil(OPENING_ADVANCE_DURATION_MS / OPENING_ADVANCE_INTERVAL_MS);
      for (let index = 0; index < openingClicks; index++) {
        await clickRatio(OPENING_ADVANCE);
        if (index + 1 < openingClicks) await delay(OPENING_ADVANCE_INTERVAL_MS);
      }
      const openingSpan = (openingClicks - 1) * OPENING_ADVANCE_INTERVAL_MS;
      if (openingSpan < OPENING_ADVANCE_DURATION_MS) await delay(OPENING_ADVANCE_DURATION_MS - openingSpan);

      progress("识别局外词条");
      const debuff = await scanDebuffPage();
      const blocked = matchWords(settings.blockedEnabled ? settings.blockedWords : [], debuff.result.rawText, settings.blockedFuzzyScore);
      const targets = matchWords(settings.debuffEnabled ? settings.targetWords : [], debuff.result.rawText, settings.fuzzyScore);
      const targetSatisfied = settings.debuffEnabled && settings.targetWords.length > 0
        && (settings.targetMatchAny ? targets.hits.length > 0 : targets.missing.length === 0);
      const blockedHit = settings.blockedEnabled && blocked.hits.length > 0;
      const debuffSuccess = targetSatisfied && !blockedHit;
      const combinedDecision = evaluateCombinedRound(settings, targetSatisfied, blockedHit);
      let roundCanContinue = settings.flowMode === "outer" || combinedDecision.roundCanContinue;
      if (blocked.hits.length > 0) {
        const action = settings.flowMode !== "combined" || settings.combinedBlockedRule === "ignore"
          ? "已忽略"
          : settings.combinedBlockedRule === "restart" ? "本轮将重开" : "规则允许继续";
        progress(`命中不想要词条（${action}）：${blocked.hits.join("、")}`);
      }
      if (settings.debuffEnabled && settings.targetWords.length > 0 && !targetSatisfied) {
        progress("主词条未满足，继续完成本轮开局");
      }
      const shouldStopOnDebuff = settings.flowMode === "combined"
        ? combinedDecision.shouldStopOnDebuff
        : settings.stopOnTargetMatch && debuffSuccess;
      if (shouldStopOnDebuff) {
        return { ok: true, rounds, matched: "局外词条：" + targets.hits.join("、") };
      }

      progress("进入投资选择");
      await clickText(["下一步"], { x: 0.88, y: 0.895 });
      await delay(800);
      await clickRatio({ x: 0.5, y: 0.58 });
      await delay(1800);
      const safeInvestmentScan = await scan(TOP_HALF);
      const safeInvestmentPoint = chooseSafeInvestment(safeInvestmentScan.result.items, settings.investmentFuzzyScore);
      await clickRatio(safeInvestmentPoint);
      await delay(2800);
      await clickRatio(safeInvestmentPoint);

      let investmentHit: string | null = null;
      const investmentAliases = settings.flowMode === "combined" && settings.combinedInGameInvestmentRule !== "ignore"
        ? Array.from(new Set([...settings.investmentTargets, ...settings.inGameInvestmentTargets]))
        : settings.investmentTargets;
      const investmentRuleActive = settings.flowMode === "outer"
        || settings.combinedOuterInvestmentRule !== "ignore"
        || settings.combinedInGameInvestmentRule !== "ignore";
      const canCheckInvestment = settings.investmentEnabled && investmentAliases.length > 0
        && (!blockedHit || settings.checkInvestmentWhenBlocked)
        && (settings.flowMode === "outer" || roundCanContinue)
        && investmentRuleActive;
      if (canCheckInvestment) {
        progress("识别投资词条");
        for (let attempt = 0; attempt < 3; attempt++) {
          const investment = await scan(TOP_HALF);
          const hits = matchWords(investmentAliases, investment.result.rawText, settings.investmentFuzzyScore).hits;
          if (hits.length > 0) {
            investmentHit = hits[0];
            const item = findItem(investment.result.items, hits, settings.investmentFuzzyScore);
            if (item) {
              const x = investment.capture.screenRegion.left
                + Math.round(investment.capture.width * (item.bounds.x + item.bounds.width / 2) / 1000);
              const y = investment.capture.screenRegion.top
                + Math.round(investment.capture.height * (item.bounds.y + item.bounds.height / 2) / 1000);
              await tools.click(x, y);
            }
            if (settings.flowMode === "outer" || settings.combinedOuterInvestmentRule === "stop") {
              return { ok: true, rounds, matched: "投资词条：" + hits.join("、") };
            }
            break;
          }
          if (attempt < 2) await delay(100);
        }
      }
      if (settings.flowMode === "combined" && settings.combinedOuterInvestmentRule === "require" && !investmentHit) {
        roundCanContinue = false;
      }
      if (settings.flowMode === "combined" && settings.combinedInGameInvestmentRule === "require" && !investmentHit) {
        roundCanContinue = false;
      }

      await clickRatio({ x: 0.565, y: 0.91 });
      await delay(300);
      for (let index = 0; index < 2; index++) {
        await clickRatio({ x: 0.52, y: 0.49 });
        await delay(100);
        await clickRatio({ x: 0.565, y: 0.91 });
        await delay(100);
      }
      const enterInGame = settings.flowMode === "combined" && roundCanContinue && settings.strategyTargets.length > 0;
      if (!enterInGame) {
        progress("等待局内备战页后退出本轮");
        await waitForOpeningBoard();
        await returnToCurrencyWars();
        continue;
      }

      progress("部署角色并进入局内");
      await waitForOpeningBoard();
      await delay(2000);
      await deployOpeningCharacters();
      for (let attempt = 0; attempt < 4; attempt++) {
        if (await handleRoleChoice(await scan(DIALOG))) break;
        if (attempt < 3) await delay(300);
      }
      await runOpeningBattles();
      progress("等待局内策略页");
      const extraRefresh = investmentHit !== null
        && ["银·金·彩", "银金彩", "银 金 彩"].some((word) => fuzzyContains(investmentHit!, word, 100));
      const strategyHit = await runStrategyRecognition(extraRefresh);
      if (strategyHit) return { ok: true, rounds, matched: "局内策略：" + strategyHit };
      await returnToCurrencyWars();
    }
    return { ok: false, rounds, error: `达到最大轮数 ${settings.maxRounds}，未命中目标` };
  } catch (err) {
    if (err instanceof StopError) return { ok: false, rounds, error: "已中止" };
    return { ok: false, rounds, error: err instanceof Error ? err.message : String(err) };
  }
}
