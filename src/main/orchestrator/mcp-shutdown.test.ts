import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  connect: vi.fn(), listTools: vi.fn(), close: vi.fn(), transportClose: vi.fn(), register: vi.fn(), unregister: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: class {
  connect = mocks.connect; listTools = mocks.listTools; close = mocks.close;
} }));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({ StdioClientTransport: class { close = mocks.transportClose; } }));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({ SSEClientTransport: class { close = mocks.transportClose; } }));
vi.mock("./tools/registry/tool-registry", () => ({ toolRegistry: { getById: () => undefined, register: mocks.register, unregister: mocks.unregister } }));
const config = { id: "test", name: "test", transport: "stdio" as const, command: "never-launched" };
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  mocks.connect.mockResolvedValue(undefined);
  mocks.listTools.mockResolvedValue({ tools: [{ name: "read", inputSchema: { type: "object" } }] });
  mocks.close.mockResolvedValue(undefined); mocks.transportClose.mockResolvedValue(undefined);
});
it("disconnects all clients, unregisters tools, and is idempotent", async () => {
  const api = await import("./mcp-adapter");
  await api.connectMcpServer(config);
  await api.connectMcpServer({ ...config, id: "second" });
  await Promise.all([api.shutdownMcpConnections(), api.shutdownMcpConnections()]);
  expect(mocks.close).toHaveBeenCalledTimes(2);
  expect(mocks.unregister).toHaveBeenCalledTimes(2);
  expect(api.getMcpServerStates()).toEqual([]);
  await expect(api.connectMcpServer(config)).rejects.toThrow("APPLICATION_STOPPING");
  expect(mocks.connect).toHaveBeenCalledTimes(2);
});
it.each(["connect", "listTools"] as const)("closes an in-flight %s and prevents late tool registration", async (stage) => {
  let release!: (value: any) => void;
  mocks[stage].mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const api = await import("./mcp-adapter");
  const pending = api.connectMcpServer(config);
  const rejected = expect(pending).rejects.toThrow("APPLICATION_STOPPING");
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await api.shutdownMcpConnections();
  release({ tools: [] });
  await rejected;
  expect(mocks.close).toHaveBeenCalledTimes(1);
  expect(mocks.register).not.toHaveBeenCalled();
  expect(api.getMcpServerStates()).toEqual([]);
});
it("falls back to transport close when client close fails", async () => {
  const api = await import("./mcp-adapter");
  await api.connectMcpServer(config);
  mocks.close.mockRejectedValue(new Error("client close failed"));
  await api.shutdownMcpConnections();
  expect(mocks.transportClose).toHaveBeenCalledTimes(1);
});
it("waits for a manual disconnect that was already in progress", async () => {
  const api = await import("./mcp-adapter");
  await api.connectMcpServer(config);
  let release!: () => void;
  mocks.close.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  const manual = api.disconnectMcpServer(config.id);
  let drained = false;
  const shutdown = api.shutdownMcpConnections().then(() => { drained = true; });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(drained).toBe(false);
  release();
  await Promise.all([manual, shutdown]);
  expect(mocks.close).toHaveBeenCalledTimes(1);
});
it("quiesce interrupts pending restore before the producer drain phase", async () => {
  const api = await import("./mcp-adapter");
  let rejectConnect!: (error: Error) => void;
  mocks.connect.mockImplementationOnce(() => new Promise((_, reject) => { rejectConnect = reject; }));
  mocks.close.mockImplementationOnce(async () => { rejectConnect(new Error("connection closed")); });
  const pending = api.connectMcpServer(config);
  const rejected = expect(pending).rejects.toThrow("connection closed");
  api.quiesceMcpConnections();
  await rejected;
  await api.shutdownMcpConnections();
  expect(mocks.close).toHaveBeenCalledTimes(1);
  expect(mocks.register).not.toHaveBeenCalled();
});
it("reports failed fallback without skipping other clients", async () => {
  const api = await import("./mcp-adapter");
  await api.connectMcpServer(config);
  await api.connectMcpServer({ ...config, id: "second" });
  mocks.close.mockRejectedValueOnce(new Error("client failed"));
  mocks.transportClose.mockRejectedValueOnce(new Error("transport failed"));
  await expect(api.shutdownMcpConnections()).rejects.toThrow("MCP shutdown failed");
  expect(mocks.close).toHaveBeenCalledTimes(2);
});
