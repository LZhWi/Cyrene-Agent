import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectUserDataSafety } from "./user-data-safety";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-user-data-safety-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("inspectUserDataSafety", () => {
  it("拒绝 Electron 默认指向的正式版用户目录", () => {
    const appData = temporaryDirectory();
    expect(inspectUserDataSafety({
      appDataPath: appData,
      userDataPath: path.join(appData, "live2d-cyrene"),
      supportedMemorySchemaVersion: 2,
    })).toMatchObject({ safe: false, reason: expect.stringContaining("正式版用户目录") });
  });

  it("允许空的隔离用户目录", () => {
    const root = temporaryDirectory();
    expect(inspectUserDataSafety({
      appDataPath: path.join(root, "app-data"),
      userDataPath: path.join(root, "user-data"),
      supportedMemorySchemaVersion: 2,
    })).toEqual({ safe: true });
  });

  it("拒绝本地 schema 6 记忆，且不修改源文件", () => {
    const root = temporaryDirectory();
    const userData = path.join(root, "user-data");
    fs.mkdirSync(userData);
    const memoryPath = path.join(userData, "memory.json");
    const source = JSON.stringify({
      schemaVersion: 6,
      l2DmaeStates: { l2_a: { activation: 1 } },
      lastDecayAt: "2026-09-21T00:00:00.000Z",
    });
    fs.writeFileSync(memoryPath, source, "utf8");

    expect(inspectUserDataSafety({
      appDataPath: path.join(root, "app-data"),
      userDataPath: userData,
      supportedMemorySchemaVersion: 2,
    })).toMatchObject({ safe: false, reason: expect.stringContaining("schema=6") });
    expect(fs.readFileSync(memoryPath, "utf8")).toBe(source);
  });

  it("允许宿主当前 schema 的隔离记忆", () => {
    const root = temporaryDirectory();
    const userData = path.join(root, "user-data");
    fs.mkdirSync(userData);
    fs.writeFileSync(path.join(userData, "memory.json"), JSON.stringify({
      schemaVersion: 2,
      l2DmaeStates: [],
    }));

    expect(inspectUserDataSafety({
      appDataPath: path.join(root, "app-data"),
      userDataPath: userData,
      supportedMemorySchemaVersion: 2,
    })).toEqual({ safe: true });
  });

  it("允许由宿主补齐缺省数组的旧隔离记忆", () => {
    const root = temporaryDirectory();
    const userData = path.join(root, "user-data");
    fs.mkdirSync(userData);
    fs.writeFileSync(path.join(userData, "memory.json"), JSON.stringify({ schemaVersion: 1 }));

    expect(inspectUserDataSafety({
      appDataPath: path.join(root, "app-data"),
      userDataPath: userData,
      supportedMemorySchemaVersion: 2,
    })).toEqual({ safe: true });
  });
});
