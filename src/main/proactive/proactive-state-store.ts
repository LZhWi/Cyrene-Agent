// ProactiveChat 状态持久化（从原 opener/desire-engine 搬出 + 剃除 opener 专属字段）
// 原生状态独立保存，不与 companion 主动消息状态合并。
import { getServiceState } from "../storage/service-state";
import { app } from "electron";
import type { ProactiveState } from "./proactive-types";

export function defaultProactiveState(): ProactiveState {
  return {
    proactiveEpoch: 0,
    unansweredCount: 0,
    lastProactiveAt: null,
    lastProactiveScene: null,
    lastNormalConversationEndedAt: null,
    globalDesire: 0,
    affinity: {},
    lastFiredAt: {},
  };
}

export function loadProactiveState(): ProactiveState {
    const raw = getServiceState(app.getPath("userData"), "native-proactive").get("state") as Partial<ProactiveState>;
    const base = defaultProactiveState();
    return {
      ...base,
      ...raw,
      affinity: { ...base.affinity, ...(raw.affinity ?? {}) },
      lastFiredAt: { ...(raw.lastFiredAt ?? {}) },
    };
}

export function saveProactiveState(state: ProactiveState): void {
  getServiceState(app.getPath("userData"), "native-proactive").set("state", state);
}
