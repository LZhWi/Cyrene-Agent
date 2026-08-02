// 天气卡片结构化数据（主进程工具产出 → AG-UI CUSTOM 事件 → 渲染端渲染）。
// 与 src/main/orchestrator/built-in-tools.ts 的 WeatherCardData 保持字段一致，
// 放在 shared 避免渲染层反向依赖主进程模块。

/** 单日预报（今天 + 未来 2 天）。 */
export interface WeatherForecastDay {
  date: string;       // "7月29日"
  weekDay: string;    // "周二" / "今天"
  textDay: string;    // "多云"
  textNight: string;  // "晴"
  hi: number;         // 最高温
  lo: number;         // 最低温
  windDir: string;    // 风向
  windScale: string;  // 风力
}

export interface WeatherCardData {
  city: string;
  adm: string;
  temp: number;
  feelsLike?: number;
  text: string;
  icon: string;
  hi?: number;
  lo?: number;
  humidity: number;
  windDir: string;
  windScale: string;
  precip?: number;
  pressure?: number;
  visibility?: number;
  uv?: number;
  aqi?: number;
  aqiText?: string;
  source: string;
  updateTime: string;
  forecast?: WeatherForecastDay[];
}

/** 容错解析：AG-UI CUSTOM 事件 value 可能是任意值，校验后返回结构化数据或 null。 */
export function normalizeWeatherCardData(value: unknown): WeatherCardData | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.city !== "string") return null;
  if (typeof raw.temp !== "number") return null;
  if (typeof raw.text !== "string") return null;
  const forecast = Array.isArray(raw.forecast)
    ? raw.forecast.filter((d): d is Record<string, unknown> => Boolean(d) && typeof d === "object")
      .map((d): WeatherForecastDay => ({
        date: typeof d.date === "string" ? d.date : "",
        weekDay: typeof d.weekDay === "string" ? d.weekDay : "",
        textDay: typeof d.textDay === "string" ? d.textDay : "",
        textNight: typeof d.textNight === "string" ? d.textNight : "",
        hi: typeof d.hi === "number" ? d.hi : 0,
        lo: typeof d.lo === "number" ? d.lo : 0,
        windDir: typeof d.windDir === "string" ? d.windDir : "",
        windScale: typeof d.windScale === "string" ? d.windScale : "",
      }))
    : [];
  return {
    city: raw.city,
    adm: typeof raw.adm === "string" ? raw.adm : "",
    temp: raw.temp,
    ...(typeof raw.feelsLike === "number" ? { feelsLike: raw.feelsLike } : {}),
    text: raw.text,
    icon: typeof raw.icon === "string" ? raw.icon : "🌤️",
    ...(typeof raw.hi === "number" ? { hi: raw.hi } : {}),
    ...(typeof raw.lo === "number" ? { lo: raw.lo } : {}),
    humidity: typeof raw.humidity === "number" ? raw.humidity : 0,
    windDir: typeof raw.windDir === "string" ? raw.windDir : "",
    windScale: typeof raw.windScale === "string" ? raw.windScale : "",
    ...(typeof raw.precip === "number" ? { precip: raw.precip } : {}),
    ...(typeof raw.pressure === "number" ? { pressure: raw.pressure } : {}),
    ...(typeof raw.visibility === "number" ? { visibility: raw.visibility } : {}),
    ...(typeof raw.uv === "number" ? { uv: raw.uv } : {}),
    ...(typeof raw.aqi === "number" ? { aqi: raw.aqi } : {}),
    ...(typeof raw.aqiText === "string" ? { aqiText: raw.aqiText } : {}),
    source: typeof raw.source === "string" ? raw.source : "",
    updateTime: typeof raw.updateTime === "string" ? raw.updateTime : "",
    ...(forecast.length > 0 ? { forecast } : {}),
  };
}
