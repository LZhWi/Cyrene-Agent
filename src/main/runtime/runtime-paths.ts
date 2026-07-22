// runtime-paths —— 运行时路径端口（PathPort）
//
// 目的：把"userData / 桌面 / 应用根目录在哪"这类依赖 Electron `app.getPath` 的查询，
// 从大脑数据层（memory / rag / history 等）里解耦出来，使这些纯逻辑模块不再
// 直接 `import { app } from "electron"`，从而可以在非 Electron 环境（如 React Native
// iOS 端）复用。
//
// 行为约定：
//   - PC（Electron）运行时：不注入 provider 时，默认惰性 require("electron")，
//     调用 app.getPath / app.getAppPath —— 与迁移前完全等价（含单测里的 electron mock）。
//   - RN / 其它宿主：启动时调用 setAppPathProvider() 注入自己的实现（如 SQLite/文件目录），
//     之后所有路径查询都走注入实现，不触碰 electron。
//
// 关于 electron 依赖：本模块静态 import electron 仅为在 PC/测试环境取默认 provider；
// 打包到 React Native（Metro）时，应在打包配置里把 "electron" 别名到空 stub，
// 并在启动时先 setAppPathProvider()，使默认分支永不执行。
import { app as electronApp } from "electron";

/** Electron `app.getPath(name)` 支持的目录名（仅列出本项目实际用到的）。 */
export type RuntimePathName =
  | "home"
  | "appData"
  | "userData"
  | "temp"
  | "desktop"
  | "documents"
  | "downloads"
  | "music"
  | "pictures"
  | "videos";

/** 路径解析端口：宿主环境各自实现。 */
export interface AppPathProvider {
  /** 对应 Electron `app.getPath(name)`。 */
  getPath(name: RuntimePathName): string;
  /** 对应 Electron `app.getAppPath()`（应用/包根目录，用于定位内置资源如 prompts、models）。 */
  getAppPath(): string;
}

let injected: AppPathProvider | null = null;

/**
 * 注入自定义路径 provider（RN / 测试用）。注入后即覆盖默认的 electron 解析。
 */
export function setAppPathProvider(provider: AppPathProvider | null): void {
  injected = provider;
}

/** 惰性从 electron 构造默认 provider；非 electron 环境（app 不可用）返回 null。 */
function tryElectronProvider(): AppPathProvider | null {
  try {
    const app = electronApp as
      | { getPath(name: string): string; getAppPath(): string }
      | undefined;
    if (!app || typeof app.getPath !== "function") return null;
    return {
      getPath: (name) => app.getPath(name),
      getAppPath: () => (typeof app.getAppPath === "function" ? app.getAppPath() : ""),
    };
  } catch {
    // 非 Electron 环境（RN / 纯 Node 脚本）——交由注入 provider 处理。
    return null;
  }
}

function resolveProvider(): AppPathProvider {
  if (injected) return injected;
  const electronProvider = tryElectronProvider();
  if (electronProvider) return electronProvider;
  throw new Error(
    "runtime-paths: 未注入 AppPathProvider 且当前环境无法访问 electron.app。" +
      "请在非 Electron 宿主启动时调用 setAppPathProvider()。",
  );
}

/** 通用：等价于 Electron `app.getPath(name)`。 */
export function getRuntimePath(name: RuntimePathName): string {
  return resolveProvider().getPath(name);
}

/** 便捷：等价于 `app.getPath("userData")`——绝大多数数据文件的根目录。 */
export function getUserDataDir(): string {
  return resolveProvider().getPath("userData");
}

/** 便捷：等价于 `app.getAppPath()`——应用/包根目录（定位内置 prompts、models 等）。 */
export function getAppRootDir(): string {
  return resolveProvider().getAppPath();
}
