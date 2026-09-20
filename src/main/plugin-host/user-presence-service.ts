import type { PluginUserPresenceService } from "../../plugins/api";

export interface PowerMonitorReader {
  getSystemIdleTime(): number;
  getSystemIdleState(threshold: number): "active" | "idle" | "locked" | "unknown";
}

/**
 * 只公开主动消息策略真正需要的最小在场信息。
 * 不采集窗口标题、输入内容、鼠标位置，也不保存历史轨迹。
 */
export function createUserPresenceService(
  powerMonitor: PowerMonitorReader,
  now: () => number = Date.now,
): PluginUserPresenceService {
  return {
    async snapshot() {
      const idleSeconds = Math.max(0, Math.floor(powerMonitor.getSystemIdleTime()));
      return {
        at: new Date(now()).toISOString(),
        idleSeconds,
        screenLocked: powerMonitor.getSystemIdleState(60) === "locked",
      };
    },
  };
}
