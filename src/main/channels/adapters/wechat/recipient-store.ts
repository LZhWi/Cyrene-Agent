import * as fs from "fs";
import * as path from "path";
import { writeJsonAtomicSync } from "../../../runtime/atomic-file";
import { getUserDataDir } from "../../../runtime/runtime-paths";

export interface WechatRecipientRecord {
  botId?: string;
  targetId: string;
  contextToken?: string;
  sessionId?: string;
  updatedAt: number;
}

function defaultFilePath(): string {
  return path.join(getUserDataDir(), "channels", "wechat-recipient.json");
}

export function loadWechatRecipient(filePath = defaultFilePath()): WechatRecipientRecord | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<WechatRecipientRecord>;
    if (typeof value.targetId !== "string" || !value.targetId.trim()) return null;
    if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return null;
    return {
      targetId: value.targetId.trim(),
      updatedAt: value.updatedAt,
      ...(typeof value.botId === "string" && value.botId ? { botId: value.botId } : {}),
      ...(typeof value.contextToken === "string" && value.contextToken ? { contextToken: value.contextToken } : {}),
      ...(typeof value.sessionId === "string" && value.sessionId ? { sessionId: value.sessionId } : {}),
    };
  } catch (err) {
    console.warn("[WechatRecipient] 读取失败:", err instanceof Error ? err.message : err);
    return null;
  }
}

function updateWechatRecipient(
  targetId: string,
  patch: Partial<Omit<WechatRecipientRecord, "targetId">>,
  filePath = defaultFilePath(),
): WechatRecipientRecord | null {
  const normalizedTargetId = targetId.trim();
  if (!normalizedTargetId) return null;
  const previous = loadWechatRecipient(filePath);
  const sameTarget = previous?.targetId === normalizedTargetId;
  const next: WechatRecipientRecord = {
    ...(sameTarget && previous ? previous : { targetId: normalizedTargetId, updatedAt: Date.now() }),
    ...patch,
    targetId: normalizedTargetId,
    updatedAt: typeof patch.updatedAt === "number" ? patch.updatedAt : Date.now(),
  };
  try {
    writeJsonAtomicSync(filePath, next);
    return next;
  } catch (err) {
    console.warn("[WechatRecipient] 写入失败:", err instanceof Error ? err.message : err);
    return null;
  }
}

export function rememberWechatRecipientContext(
  input: { botId?: string; targetId: string; contextToken: string; updatedAt?: number },
  filePath?: string,
): WechatRecipientRecord | null {
  return updateWechatRecipient(input.targetId, {
    ...(input.botId ? { botId: input.botId } : {}),
    contextToken: input.contextToken,
    updatedAt: input.updatedAt ?? Date.now(),
  }, filePath);
}

export function rememberWechatRecipientSession(
  input: { targetId: string; sessionId: string; updatedAt?: number },
  filePath?: string,
): WechatRecipientRecord | null {
  return updateWechatRecipient(input.targetId, {
    sessionId: input.sessionId,
    updatedAt: input.updatedAt ?? Date.now(),
  }, filePath);
}

export function deleteWechatRecipient(filePath = defaultFilePath()): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch (err) {
    console.warn("[WechatRecipient] 删除失败:", err instanceof Error ? err.message : err);
  }
}
