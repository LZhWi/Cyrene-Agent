import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import {
  ensureWindowsNotificationIdentity,
  WINDOWS_APP_USER_MODEL_ID,
  WINDOWS_TOAST_ACTIVATOR_CLSID,
} from "./windows-notification-identity";

function setup(overrides: Partial<Parameters<typeof ensureWindowsNotificationIdentity>[0]> = {}) {
  const writeShortcut = vi.fn(() => true);
  const readShortcut = vi.fn(() => null);
  const removeShortcut = vi.fn();
  const deps = {
    platform: "win32" as NodeJS.Platform,
    isPackaged: false,
    appPath: "E:\\Cyrene-Agent",
    execPath: "E:\\Cyrene-Agent\\node_modules\\electron\\electron.exe",
    iconPath: "E:\\Cyrene-Agent\\assets\\tray-icon.ico",
    startMenuProgramsDir: "C:\\Users\\test\\Start Menu\\Programs",
    writeShortcut,
    readShortcut,
    removeShortcut,
    ...overrides,
  };
  return { result: ensureWindowsNotificationIdentity(deps), writeShortcut, readShortcut, removeShortcut };
}

describe("Windows notification identity", () => {
  it("uses a development-only identity instead of the stale legacy taskbar group", () => {
    expect(WINDOWS_APP_USER_MODEL_ID).toBe("com.cyrene.live2d.dev");
  });

  it("creates the development shortcut before notifications are used", () => {
    const ctx = setup();
    expect(ctx.result).toBe(true);
    expect(ctx.writeShortcut).toHaveBeenCalledWith(
      path.join("C:\\Users\\test\\Start Menu\\Programs", "Cyrene.lnk"),
      "create",
      expect.objectContaining({
        target: "E:\\Cyrene-Agent\\node_modules\\electron\\electron.exe",
        args: '"E:\\Cyrene-Agent"',
        icon: "E:\\Cyrene-Agent\\assets\\tray-icon.ico",
        appUserModelId: WINDOWS_APP_USER_MODEL_ID,
        toastActivatorClsid: WINDOWS_TOAST_ACTIVATOR_CLSID,
      }),
    );
  });

  it("leaves packaged and non-Windows shortcut management untouched", () => {
    expect(setup({ isPackaged: true }).writeShortcut).not.toHaveBeenCalled();
    expect(setup({ platform: "linux" }).writeShortcut).not.toHaveBeenCalled();
  });

  it("contains shortcut failures and reports them", () => {
    const warn = vi.fn();
    const ctx = setup({ writeShortcut: () => { throw new Error("failed"); }, warn });
    expect(ctx.result).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("reports a false result returned by Windows", () => {
    const warn = vi.fn();
    const ctx = setup({ writeShortcut: () => false, warn });
    expect(ctx.result).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("removes only the stale Electron shortcut that claims Cyrene's identity", () => {
    const ctx = setup({
      readShortcut: () => ({
        target: "e:\\cyrene-agent\\node_modules\\electron\\electron.exe",
        appUserModelId: WINDOWS_APP_USER_MODEL_ID,
      }),
    });
    expect(ctx.removeShortcut).toHaveBeenCalledWith(
      path.join("C:\\Users\\test\\Start Menu\\Programs", "Electron.lnk"),
    );
  });

  it("preserves unrelated Electron shortcuts", () => {
    const differentIdentity = setup({
      readShortcut: () => ({ target: "E:\\Cyrene-Agent\\node_modules\\electron\\electron.exe", appUserModelId: "other.app" }),
    });
    expect(differentIdentity.removeShortcut).not.toHaveBeenCalled();

    const differentTarget = setup({
      readShortcut: () => ({ target: "C:\\Other\\electron.exe", appUserModelId: WINDOWS_APP_USER_MODEL_ID }),
    });
    expect(differentTarget.removeShortcut).not.toHaveBeenCalled();
  });
});
