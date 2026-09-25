import * as fs from "node:fs";
import * as path from "node:path";

export interface UserDataSafetyInput {
  userDataPath: string;
  appDataPath: string;
  applicationDirectoryName?: string;
  supportedMemorySchemaVersion: number;
}

export interface UserDataSafetyResult {
  safe: boolean;
  reason?: string;
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function isLocalMemoryLayout(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const store = value as Record<string, unknown>;
  return ("l2DmaeStates" in store && !Array.isArray(store.l2DmaeStates))
    || "lastDecayAt" in store
    || "pendingTurns" in store
    || "l2DmaeRound" in store
    || "dreamNarratives" in store;
}

/**
 * 在任何子系统初始化前，只读检查本次 Electron userData。
 *
 * Cyrene-Agent-N 与旧版应用同名，Electron 默认会指向正式版用户目录；这里
 * 明确拒绝该路径。同时拒绝把新版 MemoryStore 直接挂到本地 schema 6 数据，
 * 避免加载时触发自动降级迁移和覆写。数据导入必须走隔离快照入口。
 */
export function inspectUserDataSafety(input: UserDataSafetyInput): UserDataSafetyResult {
  const legacyDirectory = path.join(
    input.appDataPath,
    input.applicationDirectoryName ?? "live2d-cyrene",
  );
  if (samePath(input.userDataPath, legacyDirectory)) {
    return {
      safe: false,
      reason: `拒绝使用正式版用户目录：${legacyDirectory}`,
    };
  }

  const memoryPath = path.join(input.userDataPath, "memory.json");
  if (!fs.existsSync(memoryPath)) return { safe: true };

  try {
    const parsed = JSON.parse(fs.readFileSync(memoryPath, "utf8")) as Record<string, unknown>;
    const schemaVersion = typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 0;
    if (schemaVersion > input.supportedMemorySchemaVersion || isLocalMemoryLayout(parsed)) {
      return {
        safe: false,
        reason: `拒绝原地迁移 memory.json（数据 schema=${schemaVersion}，宿主 schema=${input.supportedMemorySchemaVersion}）`,
      };
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { safe: false, reason: `memory.json 无法安全预检：${detail}` };
  }

  return { safe: true };
}
