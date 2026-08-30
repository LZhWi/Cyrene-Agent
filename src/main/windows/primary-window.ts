import type { WindowActivationRequest } from "../application/window-activation";

export interface PrimaryWindowActions {
  /** 主窗口激活统一走 activation request，不再直接创建窗口。 */
  requestActivation(request: WindowActivationRequest): void;
}

/**
 * The chat window is Cyrene's primary user-facing window.
 * 发出 chat 激活请求；桌宠不接收通用主窗口激活请求，
 * 其可见性由 settings / togglePetWindow 路径管理。
 */
export function openPrimaryWindow(actions: PrimaryWindowActions): void {
  actions.requestActivation({ kind: "chat" });
}
