/**
 * 应用完整运行上下文：只在 application.ts（编排器）组装成功后生成并持有。
 * 各启动模块不得接收或导入本类型 —— 它们只拿自身的窄依赖与阶段结果，
 * 避免退化成 Service Locator。
 */

import type { StartupReadiness } from "./readiness";
import type { ShutdownCoordinator } from "./shutdown";
import type { WindowActivationBroker } from "./window-activation";
import type { ShellResult } from "./shell-bootstrap";
import type { CoreResult } from "./core-bootstrap";
import type { BackgroundHandle } from "./background";

export interface ApplicationContext {
  readiness: StartupReadiness;
  activation: WindowActivationBroker;
  shutdown: ShutdownCoordinator;
  shell: ShellResult;
  core: CoreResult;
  background: BackgroundHandle;
}
