import { describe, expect, it } from "vitest";
import { normalizeWeatherData, stageForStep } from "./chat-page-normalizers";

describe("chat page normalizers", () => {
  it("normalizes a complete Open-Meteo weather card", () => {
    expect(normalizeWeatherData({
      source: "open-meteo",
      location: { province: "上海", city: "上海" },
      weatherCode: 1,
      temp: 28,
      humidity: 63,
      windDeg: 180,
      windSpeed: 12,
    })).toEqual({
      source: "open-meteo",
      location: { province: "上海", city: "上海" },
      weatherCode: 1,
      temp: 28,
      feelsLike: 28,
      humidity: 63,
      windDeg: 180,
      windSpeed: 12,
      precipitation: 0,
      pressure: 0,
    });
  });

  it("maps tool steps to an executing stage", () => {
    expect(stageForStep("agent-graph-tool-read_file")).toEqual({
      kind: "executing",
      detail: "read_file",
    });
  });
});
