import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfiguredWeatherObservation, setWeatherConfig } from "./weather-tool";

afterEach(() => vi.unstubAllGlobals());

describe("插件天气观察投影", () => {
  it("复用宿主默认城市查询，但不触发卡片且不返回位置", async () => {
    const card = vi.fn();
    setWeatherConfig(() => "上海", () => "open-meteo", () => "", card, () => true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        results: [{ name: "上海", latitude: 31.2, longitude: 121.4, country: "中国", admin1: "上海" }],
      }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        current: {
          temperature_2m: 21, relative_humidity_2m: 80, apparent_temperature: 20,
          precipitation: 2, weather_code: 61, wind_speed_10m: 8,
          wind_direction_10m: 90, surface_pressure: 1010, uv_index: 1, visibility: 8000,
        },
        daily: {
          time: ["2026-09-19", "2026-09-20"], temperature_2m_max: [30, 22],
          temperature_2m_min: [20, 18], weather_code: [0, 61],
          wind_speed_10m_max: [10, 12], wind_direction_10m_dominant: [90, 100],
        },
      }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await readConfiguredWeatherObservation();
    expect(result).toEqual({
      category: "rain",
      temperatureC: 21,
      precipitationMm: 2,
      todayHighC: 22,
      previousDayHighC: 30,
    });
    expect(card).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("city");
  });

  it("自动定位可在未设置默认城市时直接按坐标查询", async () => {
    setWeatherConfig(
      () => "",
      () => "amap",
      () => "",
      undefined,
      () => true,
      () => ({ latitude: 31.23, longitude: 121.47 }),
    );
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({
      current: {
        temperature_2m: 21, relative_humidity_2m: 80, apparent_temperature: 20,
        precipitation: 0, weather_code: 1, wind_speed_10m: 8,
        wind_direction_10m: 90, surface_pressure: 1010, uv_index: 1, visibility: 8000,
      },
      daily: {
        time: ["2026-09-19", "2026-09-20"], temperature_2m_max: [30, 22],
        temperature_2m_min: [20, 18], weather_code: [0, 1],
        wind_speed_10m_max: [10, 12], wind_direction_10m_dominant: [90, 100],
      },
    }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await readConfiguredWeatherObservation();

    expect(result?.category).toBe("clear");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("latitude=31.23&longitude=121.47");
  });
});
