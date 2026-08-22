import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signal: null as AbortSignal | null,
  disconnect: vi.fn(async () => true),
}));

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => JSON.stringify([{
    id: "slow", name: "Slow MCP", transport: "stdio", command: "node",
  }])),
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
}));
vi.mock("../runtime/runtime-paths", () => ({ getUserDataDir: () => "C:/isolated" }));
vi.mock("../runtime/atomic-file", () => ({ writeJsonAtomicSync: vi.fn() }));
vi.mock("./mcp-adapter", () => ({
  connectMcpServer: vi.fn((_config: unknown, signal?: AbortSignal) => {
    mocks.signal = signal ?? null;
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }),
  disconnectMcpServer: mocks.disconnect,
  getMcpServerStates: vi.fn(() => []),
}));

describe("MCP manager lifecycle", () => {
  it("aborts and joins startup connections before shutdown completes", async () => {
    vi.resetModules();
    const { initMcpManager, shutdownMcpManager } = await import("./mcp-manager");
    const initializing = initMcpManager();
    await vi.waitFor(() => expect(mocks.signal).not.toBeNull());
    const shuttingDown = shutdownMcpManager();
    await shuttingDown;
    await initializing;
    expect(mocks.signal?.aborted).toBe(true);
    expect(mocks.disconnect).not.toHaveBeenCalled();
  });
});
