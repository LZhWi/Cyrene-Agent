/**
 * Electron `ready` 之前的同步预配置阶段。
 * 必须保持小、同步、无业务服务构造：相关 API 只允许在 app ready 前调用。
 * 单实例锁获取失败时返回 isPrimaryProcess=false，由入口直接退出，不继续启动。
 */

import type { WindowActivationBroker } from "./window-activation";
import type { LegacyUserDataMigrationResult } from "../user-data-migration";

export interface PreReadyDependencies {
  installSingleInstance(onSecondInstance: () => void): boolean;
  /** 旧 userData 目录（live2d-cyrene）数据迁移到当前目录（Cyrene）。 */
  migrateLegacyUserData(): LegacyUserDataMigrationResult;
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

  const isPrimary = deps.installSingleInstance(() => {
    deps.activation.request({ kind: "chat" });
  });
  if (!isPrimary) {
    return { isPrimaryProcess: false };
  }

  // 数据迁移必须在单实例锁之后（防并发搬运）、
  // 下方 GPU 开关读取设置之前（那是 userData 的第一处读取点）
  const migration = deps.migrateLegacyUserData();
  if (migration.status === "failed" || migration.status === "partial") {
    throw new Error("用户数据迁移未完成，已停止启动以避免使用不完整的数据目录。请关闭其他 Cyrene 实例及占用数据文件的程序后重试；不要删除旧数据目录。");
  }

  deps.registerPrivilegedSchemes();
  deps.configureGpuSwitches();
  deps.ensureGpuSandboxAcl();
  return { isPrimaryProcess: true };
}
