import type {
  PluginWeatherContextService,
  PluginWeatherContextSnapshot,
} from "../../plugins/api";

export type WeatherContextObservation = Omit<PluginWeatherContextSnapshot, "observedAt" | "expiresAt">;

const SUCCESS_TTL_MS = 30 * 60 * 1000;
const FAILURE_RETRY_MS = 5 * 60 * 1000;

/**
 * 复用宿主已经配置的天气查询，但只向插件公开主动场景所需的非定位字段。
 * 成功快照带明确有效期；失败也短暂缓存，避免插件周期检查造成重复网络请求。
 */
export function createWeatherContextService(
  read: () => Promise<WeatherContextObservation | null>,
  now: () => number = Date.now,
): PluginWeatherContextService {
  let cached: PluginWeatherContextSnapshot | null = null;
  let refreshAfter = 0;

  return {
    async snapshot() {
      const at = now();
      if (at < refreshAfter) return cached ? structuredClone(cached) : null;
      let observation: WeatherContextObservation | null;
      try {
        observation = await read();
      } catch {
        observation = null;
      }
      if (!observation) {
        cached = null;
        refreshAfter = at + FAILURE_RETRY_MS;
        return null;
      }
      cached = {
        ...observation,
        observedAt: new Date(at).toISOString(),
        expiresAt: new Date(at + SUCCESS_TTL_MS).toISOString(),
      };
      refreshAfter = at + SUCCESS_TTL_MS;
      return structuredClone(cached);
    },
  };
}
