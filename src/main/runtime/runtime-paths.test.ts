import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  getPath: vi.fn((name: string) => `electron:${name}`),
  getAppPath: vi.fn(() => "electron:app-root"),
}));

vi.mock("electron", () => ({
  app: {
    getPath: electronMock.getPath,
    getAppPath: electronMock.getAppPath,
  },
}));

import {
  getAppRootDir,
  getRuntimePath,
  getUserDataDir,
  setAppPathProvider,
  type RuntimePathName,
} from "./runtime-paths";

describe("runtime paths", () => {
  beforeEach(() => {
    setAppPathProvider(null);
    electronMock.getPath.mockClear();
    electronMock.getAppPath.mockClear();
  });

  it.each<RuntimePathName>([
    "home",
    "appData",
    "userData",
    "temp",
    "desktop",
    "documents",
    "downloads",
    "music",
    "pictures",
    "videos",
  ])("preserves Electron getPath behavior for %s", (name) => {
    expect(getRuntimePath(name)).toBe(`electron:${name}`);
    expect(electronMock.getPath).toHaveBeenCalledWith(name);
  });

  it("preserves Electron convenience path behavior", () => {
    expect(getUserDataDir()).toBe("electron:userData");
    expect(getAppRootDir()).toBe("electron:app-root");
  });

  it("uses an injected provider until it is explicitly cleared", () => {
    setAppPathProvider({
      getPath: (name) => `injected:${name}`,
      getAppPath: () => "injected:app-root",
    });

    expect(getUserDataDir()).toBe("injected:userData");
    expect(getRuntimePath("desktop")).toBe("injected:desktop");
    expect(getAppRootDir()).toBe("injected:app-root");
    expect(electronMock.getPath).not.toHaveBeenCalled();
    expect(electronMock.getAppPath).not.toHaveBeenCalled();

    setAppPathProvider(null);
    expect(getUserDataDir()).toBe("electron:userData");
  });
});
