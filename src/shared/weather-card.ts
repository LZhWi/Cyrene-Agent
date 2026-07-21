// 天气卡片结构化数据（主进程工具产出 → AG-UI CUSTOM 事件 → 渲染端渲染）。
// 与 src/main/orchestrator/built-in-tools.ts 的 WeatherCardData 保持字段一致，
// 放在 shared 避免渲染层反向依赖主进程模块。
export interface WeatherCardData {
  city: string;
  adm: string;
  temp: number;
  feelsLike: number;
  text: string;
  icon: string;
  hi?: number;
  lo?: number;
  humidity: number;
  windDir: string;
  windScale: string;
  precip: number;
  pressure: number;
  visibility?: number;
  uv?: string;
  aqi?: number;
  aqiText?: string;
  source: string;
  updateTime: string;
}

/** 容错解析：AG-UI CUSTOM 事件 value 可能是任意值，校验后返回结构化数据或 null。 */
export function normalizeWeatherCardData(value: unknown): WeatherCardData | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.city !== "string") return null;
  if (typeof raw.temp !== "number") return null;
  if (typeof raw.text !== "string") return null;
  return {
    city: raw.city,
    adm: typeof raw.adm === "string" ? raw.adm : "",
    temp: raw.temp,
    feelsLike: typeof raw.feelsLike === "number" ? raw.feelsLike : raw.temp,
    text: raw.text,
    icon: typeof raw.icon === "string" ? raw.icon : "🌤️",
    ...(typeof raw.hi === "number" ? { hi: raw.hi } : {}),
    ...(typeof raw.lo === "number" ? { lo: raw.lo } : {}),
    humidity: typeof raw.humidity === "number" ? raw.humidity : 0,
    windDir: typeof raw.windDir === "string" ? raw.windDir : "",
    windScale: typeof raw.windScale === "string" ? raw.windScale : "",
    precip: typeof raw.precip === "number" ? raw.precip : 0,
    pressure: typeof raw.pressure === "number" ? raw.pressure : 0,
    ...(typeof raw.visibility === "number" ? { visibility: raw.visibility } : {}),
    ...(typeof raw.uv === "string" ? { uv: raw.uv } : {}),
    ...(typeof raw.aqi === "number" ? { aqi: raw.aqi } : {}),
    ...(typeof raw.aqiText === "string" ? { aqiText: raw.aqiText } : {}),
    source: typeof raw.source === "string" ? raw.source : "",
    updateTime: typeof raw.updateTime === "string" ? raw.updateTime : "",
  };
}
