import { app, Menu, nativeImage, Tray } from "electron";
import { getCurrentAppIconPath } from "./windows/window-state";

export interface CreateTrayDependencies {
  toggleMainWindow: () => void;
  createSidebarWindow: () => void;
  createSettingsWindow: () => void;
}

export function createTray(deps: CreateTrayDependencies): Tray {
  const icon = nativeImage.createFromPath(getCurrentAppIconPath());
  const tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "打开状态面板",
      click: () => { deps.createSidebarWindow(); },
    },
    {
      label: "设置",
      click: () => { deps.createSettingsWindow(); },
    },
    {
      label: "显示/隐藏桌宠",
      click: () => { deps.toggleMainWindow(); },
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => { app.quit(); },
    },
  ]);

  tray.setToolTip("Cyrene");
  tray.setContextMenu(contextMenu);

  return tray;
}
