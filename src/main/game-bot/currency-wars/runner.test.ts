import { describe, expect, it, vi } from "vitest";
import {
  evaluateCombinedRound,
  runCurrencyWars,
  STRATEGY_REFRESH_POINTS,
  type CurrencyWarsRunTools,
} from "./runner";
import { normalizeCurrencyWarsSettings } from "./types";

const windowTarget = { title: "崩坏：星穹铁道", left: 100, top: 50, width: 1920, height: 1080 };

function tools(rawText: string, onDelay?: () => void): CurrencyWarsRunTools {
  return {
    launch: vi.fn().mockResolvedValue(undefined),
    findWindow: vi.fn().mockResolvedValue(windowTarget),
    findFullscreen: vi.fn().mockResolvedValue(windowTarget),
    capture: vi.fn().mockResolvedValue({
      base64: "eA==", mime: "image/png", width: 1920, height: 1080, screenRegion: windowTarget,
    }),
    recognize: vi.fn().mockResolvedValue({ rawText, items: [] }),
    click: vi.fn().mockResolvedValue(undefined),
    drag: vi.fn().mockResolvedValue(undefined),
    key: vi.fn().mockResolvedValue(undefined),
    delay: vi.fn().mockImplementation(async () => { onDelay?.(); }),
  };
}

describe("currency wars runner", () => {
  it("策略刷新坐标命中三列按钮中心", () => {
    const points = STRATEGY_REFRESH_POINTS.map((point) => ({
      x: Math.round(1998 * point.x),
      y: Math.round(1260 * point.y),
    }));
    expect(points).toEqual([
      { x: 406, y: 953 },
      { x: 923, y: 953 },
      { x: 1447, y: 953 },
    ]);
  });

  it("按 Better 组合规则决定停止或进入局内", () => {
    const stopSettings = normalizeCurrencyWarsSettings({
      flowMode: "combined", combinedMainRule: "stop", combinedBlockedRule: "ignore",
      targetWords: ["忍无可忍"], blockedWords: ["能量逃逸"],
    });
    expect(evaluateCombinedRound(stopSettings, true, false)).toEqual({
      shouldStopOnDebuff: true,
      roundCanContinue: true,
    });

    const restartSettings = normalizeCurrencyWarsSettings({
      flowMode: "combined", combinedMainRule: "require", combinedBlockedRule: "restart",
      targetWords: ["忍无可忍"], blockedWords: ["能量逃逸"],
    });
    expect(evaluateCombinedRound(restartSettings, true, true)).toEqual({
      shouldStopOnDebuff: false,
      roundCanContinue: false,
    });
    expect(evaluateCombinedRound(restartSettings, false, false).roundCanContinue).toBe(false);
  });

  it("局外目标命中后停止", async () => {
    const bot = tools("忍无可忍");
    const result = await runCurrencyWars({
      exe: "D:/Star Rail Game/StarRail.exe",
      settings: normalizeCurrencyWarsSettings({
        targetWords: ["忍无可忍"], blockedWords: [], stopOnTargetMatch: true, maxRounds: 1,
        recognitionOnly: false,
      }),
      tools: bot,
      signal: { aborted: false },
    });
    expect(result).toMatchObject({ ok: true, rounds: 1, matched: "局外词条：忍无可忍" });
    expect(bot.click).toHaveBeenCalledTimes(12);
    expect(bot.delay).toHaveBeenCalledWith(4000);
    expect(bot.capture).toHaveBeenCalledWith(windowTarget, { x: 0, y: 0.5, width: 1, height: 0.5 });
  });

  it("命中禁止词会退出结算", async () => {
    const bot = tools("忍无可忍 能量逃逸 出战");
    const result = await runCurrencyWars({
      exe: "game.exe",
      settings: normalizeCurrencyWarsSettings({
        flowMode: "outer", targetWords: ["忍无可忍"], blockedWords: ["能量逃逸"],
        maxRounds: 1, recognitionOnly: false,
      }),
      tools: bot,
      signal: { aborted: false },
    });
    expect(result.ok).toBe(false);
    expect(bot.key).not.toHaveBeenCalled();
    expect(bot.click).toHaveBeenCalledWith(167, 109);
  });

  it("停止信号会终止当前轮", async () => {
    const signal = { aborted: false };
    const bot = tools("", () => { signal.aborted = true; });
    const result = await runCurrencyWars({
      exe: "game.exe",
      settings: normalizeCurrencyWarsSettings({ maxRounds: 1, recognitionOnly: false }),
      tools: bot,
      signal,
    });
    expect(result).toMatchObject({ ok: false, error: "已中止" });
  });

  it("只识别模式不发送游戏输入", async () => {
    const bot = tools("忍无可忍");
    const result = await runCurrencyWars({
      exe: "game.exe",
      settings: normalizeCurrencyWarsSettings({ recognitionOnly: true, targetWords: ["忍无可忍"] }),
      tools: bot,
      signal: { aborted: false },
    });
    expect(result.ok).toBe(true);
    expect(result.matched).toContain("识别测试");
    expect(bot.click).not.toHaveBeenCalled();
    expect(bot.drag).not.toHaveBeenCalled();
    expect(bot.key).not.toHaveBeenCalled();
  });

  it("未找到手动启动的本地游戏时不尝试 spawn", async () => {
    const bot = tools("");
    vi.mocked(bot.findFullscreen).mockResolvedValue(null);
    const result = await runCurrencyWars({
      exe: "D:/Star Rail Game/StarRail.exe",
      settings: normalizeCurrencyWarsSettings({ targetMode: "fullscreen", autoLaunch: false }),
      tools: bot,
      signal: { aborted: false },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("请先手动启动");
    expect(bot.launch).not.toHaveBeenCalled();
  });

  it("自动启动错误转换为正常运行结果", async () => {
    const bot = tools("");
    vi.mocked(bot.findWindow).mockResolvedValue(null);
    vi.mocked(bot.launch).mockRejectedValue(new Error("spawn EACCES"));
    const result = await runCurrencyWars({
      exe: "D:/Star Rail Game/StarRail.exe",
      settings: normalizeCurrencyWarsSettings({ targetMode: "window", autoLaunch: true }),
      tools: bot,
      signal: { aborted: false },
    });
    expect(result).toMatchObject({ ok: false, error: "spawn EACCES" });
  });
});
