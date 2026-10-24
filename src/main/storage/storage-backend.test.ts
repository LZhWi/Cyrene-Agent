import { afterEach, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {
  getAppPath: () => { throw new Error("Default backend must not access SQLite runtime"); },
  getPath: () => { throw new Error("Default backend must not access user data"); },
} }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
it("keeps SQLite disabled by default without accessing its runtime or user data", async () => {
  vi.stubEnv("CYRENE_SQLITE_ISOLATION", undefined);
  const backend = await import("./storage-backend");
  expect(backend.getStorageRuntime()).toBeUndefined();
  expect(backend.pluginStorageBackend("unused")).toBeUndefined();
});
