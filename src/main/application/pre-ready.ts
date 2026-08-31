/**
 * Electron `ready` 之前的同步预配置阶段。
 * 必须保持小、同步、无业务服务构造：相关 API 只允许在 app ready 前调用。
 * 单实例锁获取失败时返回 isPrimaryProcess=false，由入口直接退出，不继续启动。
 */

import type { WindowActivationBroker } from "./window-activation";

export interface PreReadyDependencies {
  configureDocumentIndex(): void;
  installSingleInstance(onSecondInstance: () => void): boolean;
  registerPrivilegedSchemes(): void;
  configureGpuSwitches(): void;
  ensureGpuSandboxAcl(): void;
  /** 第二实例唤起统一形成 chat 激活请求，由激活代理决定何时打开窗口。 */
  activation: Pick<WindowActivationBroker, "request">;
}

export interface PreReadyResult {
  isPrimaryProcess: boolean;
}

export function prepareBeforeReady(deps: PreReadyDependencies): PreReadyResult {
  deps.configureDocumentIndex();

  const isPrimary = deps.installSingleInstance(() => {
    deps.activation.request({ kind: "chat" });
  });
  if (!isPrimary) {
    return { isPrimaryProcess: false };
  }

  deps.registerPrivilegedSchemes();
  deps.configureGpuSwitches();
  deps.ensureGpuSandboxAcl();
  return { isPrimaryProcess: true };
}
