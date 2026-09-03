import { nativeImage, type BrowserWindow, type NativeImage } from "electron";

export interface WindowIconLifecycleDependencies {
  createNativeImage: (iconPath: string) => NativeImage;
  warn: (message: string) => void;
}

const defaultDependencies: WindowIconLifecycleDependencies = {
  createNativeImage: (iconPath) => nativeImage.createFromPath(iconPath),
  warn: (message) => console.warn(message),
};

/**
 * Electron 开发版窗口可能在原生窗口初始化时丢失构造参数中的图标。
 * 创建后立即设置一次，并在 ready-to-show 后再次设置，避免任务栏回退到 electron.exe。
 */
export function attachWindowIconLifecycle(
  window: BrowserWindow,
  getIconPath: () => string,
  dependencies: WindowIconLifecycleDependencies = defaultDependencies,
): void {
  const applyIcon = (): void => {
    if (window.isDestroyed()) return;
    const iconPath = getIconPath();
    const icon = dependencies.createNativeImage(iconPath);
    if (icon.isEmpty()) {
      dependencies.warn(`[Cyrene] failed to load window icon: ${iconPath}`);
      return;
    }
    window.setIcon(icon);
  };

  applyIcon();
  window.once("ready-to-show", applyIcon);
}
