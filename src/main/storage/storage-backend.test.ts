import { afterEach, expect, it, vi } from "vitest";
vi.mock("node:fs", () => ({ default: { existsSync: () => false } }));

vi.mock("electron", () => ({ app: {
  getAppPath: () => { throw new Error("Default backend must not access SQLite runtime"); },
  getPath: () => "unused-profile",
} }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
it("pre-ready discovery is optional but business access cannot fall back to JSON", async () => {
  vi.stubEnv("CYRENE_SQLITE_ISOLATION", undefined);
  const backend = await import("./storage-backend");
  expect(backend.getStorageRuntime()).toBeUndefined();
  expect(()=>backend.requireStorageRuntime()).toThrow('SQLITE_NOT_INITIALIZED');
  expect(()=>backend.requireStorageRuntime('another-profile')).toThrow('SQLITE_PROFILE_MISMATCH');
  expect(backend.pluginStorageBackend("unused")).toBeUndefined();
});
