import { afterEach, expect, it, vi } from "vitest";
const backend = vi.hoisted(() => ({ requireStorageRuntime: vi.fn() }));
vi.mock("../storage/storage-backend", () => backend);
vi.mock("./chats-store-json", () => ({}));
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
it("正式 SQLite 未设置隔离变量时仍可原子保存主动消息与送达凭据", async () => {
  vi.stubEnv("CYRENE_SQLITE_ISOLATION", undefined);
  const delivery = vi.fn().mockReturnValue({ messageId: "new-message" });
  backend.requireStorageRuntime.mockReturnValue({ store: { appendProactiveMessage: delivery } });
  const store = await import("./chats-store");
  const input = { runId: "formal-run", text: "message" };
  expect(store.appendProactiveMessage("session", input)).toEqual({ messageId: "new-message" });
  expect(delivery).toHaveBeenCalledWith("session", input);
});
it("没有 SQLite 后端时拒绝伪造原子送达凭据", async () => {
  backend.requireStorageRuntime.mockImplementation(()=>{throw Error("SQLITE_NOT_INITIALIZED");});
  const store = await import("./chats-store");
  expect(() => store.appendProactiveMessage("session", {})).toThrow("SQLITE_NOT_INITIALIZED");
});
