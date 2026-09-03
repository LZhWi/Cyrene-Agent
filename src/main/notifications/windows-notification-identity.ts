import * as path from "path";

export const WINDOWS_APP_USER_MODEL_ID = "com.cyrene.live2d.dev";
export const WINDOWS_TOAST_ACTIVATOR_CLSID = "{C6E04587-417D-4E0F-8D1B-9D9BD9051CEC}";

interface WindowsNotificationIdentityDeps {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  appPath: string;
  execPath: string;
  iconPath: string;
  startMenuProgramsDir: string;
  writeShortcut: (shortcutPath: string, operation: "create", options: {
    target: string;
    args: string;
    cwd: string;
    description: string;
    icon: string;
    iconIndex: number;
    appUserModelId: string;
    toastActivatorClsid: string;
  }) => boolean;
  readShortcut: (shortcutPath: string) => {
    target: string;
    appUserModelId?: string;
  } | null;
  removeShortcut: (shortcutPath: string) => void;
  warn?: (message: string, error?: unknown) => void;
}

function isSameWindowsPath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

/**
 * 开发版没有安装器预先创建的开始菜单身份，需要在任何消息通知产生前补齐。
 * 正式安装版继续使用安装器生成的快捷方式，避免覆盖发行配置。
 */
export function ensureWindowsNotificationIdentity(deps: WindowsNotificationIdentityDeps): boolean {
  if (deps.platform !== "win32" || deps.isPackaged) return true;
  const shortcutPath = path.join(deps.startMenuProgramsDir, "Cyrene.lnk");
  try {
    const staleElectronShortcutPath = path.join(deps.startMenuProgramsDir, "Electron.lnk");
    const staleElectronShortcut = deps.readShortcut(staleElectronShortcutPath);
    if (
      staleElectronShortcut?.appUserModelId === WINDOWS_APP_USER_MODEL_ID
      && isSameWindowsPath(staleElectronShortcut.target, deps.execPath)
    ) {
      deps.removeShortcut(staleElectronShortcutPath);
    }

    const ok = deps.writeShortcut(shortcutPath, "create", {
      target: deps.execPath,
      args: `"${deps.appPath}"`,
      cwd: deps.appPath,
      description: "昔涟 Cyrene",
      icon: deps.iconPath,
      iconIndex: 0,
      appUserModelId: WINDOWS_APP_USER_MODEL_ID,
      toastActivatorClsid: WINDOWS_TOAST_ACTIVATOR_CLSID,
    });
    if (!ok) deps.warn?.("创建 Windows 通知身份快捷方式失败");
    return ok;
  } catch (error) {
    deps.warn?.("创建 Windows 通知身份快捷方式失败", error);
    return false;
  }
}
