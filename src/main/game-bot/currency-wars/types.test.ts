import { describe, expect, it } from "vitest";
import { normalizeCurrencyWarsSettings } from "./types";

describe("currency wars settings", () => {
  it("去重词条并约束数值", () => {
    const value = normalizeCurrencyWarsSettings({
      targetWords: [" 彩虹时代 ", "彩虹时代", ""],
      fuzzyScore: 200,
      maxRounds: -2,
    });
    expect(value.targetWords).toEqual(["彩虹时代"]);
    expect(value.fuzzyScore).toBe(100);
    expect(value.maxRounds).toBe(0);
    expect(value.targetMode).toBe("fullscreen");
    expect(value.autoLaunch).toBe(false);
    expect(value.elevatedInput).toBe(false);
    expect(value.autoDetectOcr).toBe(true);
  });

  it("支持云游戏窗口定位和显式自动启动", () => {
    const value = normalizeCurrencyWarsSettings({ targetMode: "window", autoLaunch: true });
    expect(value.targetMode).toBe("window");
    expect(value.autoLaunch).toBe(true);
  });

  it("支持管理员输入助手和关闭 OCR 自动检测", () => {
    const value = normalizeCurrencyWarsSettings({ elevatedInput: true, autoDetectOcr: false });
    expect(value.elevatedInput).toBe(true);
    expect(value.autoDetectOcr).toBe(false);
  });

  it("对齐 Better V13 的组合规则和独立识别阈值", () => {
    const value = normalizeCurrencyWarsSettings({
      flowMode: "combined",
      combinedMainRule: "require",
      combinedBlockedRule: "continue",
      combinedOuterInvestmentRule: "optional",
      combinedInGameInvestmentRule: "require",
      buttonFuzzyScore: 10,
      investmentFuzzyScore: 120,
      inGameInvestmentTargets: ["银·金·彩"],
    });
    expect(value).toMatchObject({
      flowMode: "combined",
      combinedMainRule: "require",
      combinedBlockedRule: "continue",
      combinedOuterInvestmentRule: "optional",
      combinedInGameInvestmentRule: "require",
      buttonFuzzyScore: 60,
      investmentFuzzyScore: 100,
      inGameInvestmentTargets: ["银·金·彩"],
    });
  });
});
