import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import type { QqListenAuthRequirement } from "../../shared/qq-listen";

const bridge = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  exposed: new Map<string, any>(),
  networkInterfaces: vi.fn(() => ({})),
}));

vi.mock("electron", () => ({
  app: {}, BrowserWindow: {}, webUtils: {},
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => bridge.exposed.set(name, api) },
  ipcMain: {
    handle: (name: string, handler: (...args: any[]) => unknown) => bridge.handlers.set(name, handler),
    removeHandler: (name: string) => bridge.handlers.delete(name),
  },
  ipcRenderer: {
    invoke: async (name: string, payload: unknown) => {
      const handler = bridge.handlers.get(name);
      if (!handler) throw new Error(`IPC 未注册: ${name}`);
      return handler({}, payload);
    },
  },
}));
vi.mock("node:os", async (original) => ({ ...await original<typeof import("node:os")>(), networkInterfaces: bridge.networkInterfaces }));
vi.mock("./manager", () => ({ channelManager: { setDispatcher: vi.fn(), register: vi.fn(), stopAll: vi.fn() } }));
vi.mock("./settings-store", () => ({ loadChannelsSettings: vi.fn(), saveChannelsSettings: vi.fn() }));
vi.mock("./conversation-binding-store", () => ({ getChannelConversationBindingStore: vi.fn() }));
vi.mock("../chats/chats-store", () => ({ listSessions: vi.fn(), getSession: vi.fn() }));
vi.mock("./inbound-server", () => ({ startInboundServer: vi.fn(), stopInboundServer: vi.fn() }));
vi.mock("./adapters/feishu", () => ({ FeishuAdapter: class {} }));
vi.mock("./adapters/wechat/ilink-bot-adapter", () => ({ ILinkBotAdapter: class {}, loadCredentials: vi.fn() }));
vi.mock("./adapters/qq/napcat-adapter", () => ({ NapCatAdapter: class {} }));
vi.mock("./adapters/qqbot/qqbot-adapter", () => ({ QqBotAdapter: class {} }));
vi.mock("./message-log", () => ({ getRecentLog: vi.fn(), clearLog: vi.fn(), reloadLogFromDisk: vi.fn() }));
vi.mock("../logger", () => ({ logger: { info: vi.fn() }, LogTag: {} }));

afterEach(() => { bridge.handlers.clear(); bridge.exposed.clear(); });

describe("QQ 监听预检 IPC", () => {
  it("通过真实 preload 和主进程注册返回实际网卡判定，并随 scope 清理", async () => {
    const { createIpcScope } = await import("../application/ipc-scope");
    const { initializeChannels, shutdownChannels } = await import("./init");
    const scope = createIpcScope();
    try {
      initializeChannels({ ipc: scope, handleIncoming: async () => null, reloadDispatcherSettings: vi.fn() });
      await import("../../preload/index");
      const api = bridge.exposed.get("settings") as {
        channelsQqResolveAuthRequirement(input: { listenMode: string; customHost?: string }): Promise<QqListenAuthRequirement>;
      };
      bridge.networkInterfaces.mockReturnValue({ "vEthernet (WSL)": [{ address: "172.20.0.1", family: "IPv4", internal: false }] });
      await expect(api.channelsQqResolveAuthRequirement({ listenMode: "auto" })).resolves.toMatchObject({ ok: true, requiresAccessToken: true, resolvedHost: "172.20.0.1" });
      bridge.networkInterfaces.mockReturnValue({});
      await expect(api.channelsQqResolveAuthRequirement({ listenMode: "auto" })).resolves.toMatchObject({ ok: true, requiresAccessToken: false, resolvedHost: "127.0.0.1" });
      bridge.networkInterfaces.mockImplementation(() => { throw new Error("网卡枚举不可用"); });
      await expect(api.channelsQqResolveAuthRequirement({ listenMode: "auto" })).resolves.toMatchObject({ ok: false, error: "网卡枚举不可用" });
      await expect(api.channelsQqResolveAuthRequirement({ listenMode: "loopback" })).resolves.toMatchObject({ ok: true, requiresAccessToken: false });
      await expect(api.channelsQqResolveAuthRequirement({ listenMode: "custom", customHost: "0.0.0.0" })).resolves.toMatchObject({ ok: true, requiresAccessToken: true });
    } finally {
      await shutdownChannels();
      scope.dispose();
    }
    expect(bridge.handlers.has(IPC.CHANNELS_QQ_RESOLVE_AUTH_REQUIREMENT)).toBe(false);
  });
});
