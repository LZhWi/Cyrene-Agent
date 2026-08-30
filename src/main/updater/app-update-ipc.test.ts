import { describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import { registerAppUpdateIpc, type RequestControlledShutdown } from "./app-update-ipc";

function makeService(overrides: Partial<Record<"install" | "canInstall", (...args: any[]) => unknown>> = {}) {
  const state = { phase: "available" as const, currentVersion: "1.1.7", availableVersion: "1.2.0" };
  return {
    getState: vi.fn(() => state),
    check: vi.fn(async () => state),
    download: vi.fn(async () => ({ ...state, phase: "downloading" as const })),
    canInstall: vi.fn(() => true),
    install: vi.fn(() => true),
    onStateChanged: vi.fn(() => () => undefined),
    ...overrides,
  };
}

describe("registerAppUpdateIpc", () => {
  it("exposes update actions and broadcasts state changes", async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const send = vi.fn();
    const service = makeService();

    registerAppUpdateIpc({
      service,
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      getWindows: () => [{ isDestroyed: () => false, webContents: { send } }],
    });

    expect(await handlers.get(IPC.APP_UPDATE_GET_STATE)?.({})).toEqual(service.getState());
    await handlers.get(IPC.APP_UPDATE_CHECK)?.({});
    await handlers.get(IPC.APP_UPDATE_DOWNLOAD)?.({});
    expect(await handlers.get(IPC.APP_UPDATE_INSTALL)?.({})).toBe(true);
    expect(service.check).toHaveBeenCalledOnce();
    expect(service.download).toHaveBeenCalledOnce();
    expect(service.install).toHaveBeenCalledOnce();
  });

  it("completes controlled shutdown before install", async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const order: string[] = [];
    const requestControlledShutdown: RequestControlledShutdown = vi.fn(async ({ finalAction }) => {
      order.push("cleanup");
      finalAction();
    });
    const service = makeService({
      install: () => { order.push("install"); return true; },
    });

    registerAppUpdateIpc({
      service,
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      requestControlledShutdown,
    });

    expect(await handlers.get(IPC.APP_UPDATE_INSTALL)?.({})).toBe(true);
    expect(order).toEqual(["cleanup", "install"]);
    expect(requestControlledShutdown).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "update-install" }),
    );
  });

  it("does not install when canInstall is false", async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const service = makeService({ canInstall: () => false });

    registerAppUpdateIpc({
      service,
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    });

    expect(await handlers.get(IPC.APP_UPDATE_INSTALL)?.({})).toBe(false);
    expect(service.install).not.toHaveBeenCalled();
  });
});
