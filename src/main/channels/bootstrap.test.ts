// channels/bootstrap 生命周期测试。
// 核心回归点（Task 1）：createChannelsSubsystem 在构造期只注入 dispatcher 依赖，
// 不做任何初始化/启动 —— initialize / start / shutdown 必须显式调用。
import { describe, it, expect, vi, beforeEach } from "vitest";

const channelMocks = vi.hoisted(() => ({
  buildAndRunAgent: undefined as ((...args: unknown[]) => Promise<unknown>) | undefined,
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", whenReady: async () => undefined },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
}));

// init.ts 会被 mock：bootstrap 默认 lifecycle 直接委托到这三个函数
vi.mock("./init", () => ({
  initializeChannels: vi.fn(),
  startChannels: vi.fn(async () => undefined),
  shutdownChannels: vi.fn(async () => undefined),
}));

// 捕获生产装配写入 dispatcher 的执行函数，用于验证渠道终态边界。
vi.mock("./dispatcher", () => ({
  setDispatcherBuildAndRunAgent: vi.fn((handler) => { channelMocks.buildAndRunAgent = handler; }),
  setDispatcherBroadcastChat: vi.fn(),
  setDispatcherLoadGeneralSettings: vi.fn(),
  setDispatcherLoadRecentHistory: vi.fn(),
  setDispatcherSynthesizeTts: vi.fn(),
  formatChannelUserText: vi.fn(() => "渠道问题"),
}));

// 避免拉起真实 tool registry（会级联 import RAG 等重依赖）
vi.mock("../orchestrator/tools/registry/tool-registry", () => ({
  toolRegistry: { getEnabledTools: () => [], getAllTools: () => [] },
}));
vi.mock("../orchestrator/tools/history-tools", () => ({
  indexConversationTurn: vi.fn(),
}));
vi.mock("../orchestrator/cyrene-agent", () => ({
  CyreneAgent: class {
    lastResult = {
      reply: "超时前的部分回复",
      toolResults: [],
      terminal: {
        status: "timeout",
        reason: "timeout",
        externalEffectsMayContinue: true,
      },
    };

    runWithEvents() {
      return {
        subscribe: ({ complete }: { complete: () => void }) => {
          complete();
        },
      };
    }
  },
}));
vi.mock("./settings-store", () => ({
  loadChannelsSettings: () => ({ toolSandbox: "safe" }),
}));
vi.mock("../settings/settings-facade", () => ({
  loadGeneralSettings: () => ({}),
}));
vi.mock("../settings/model-settings", () => ({
  loadModelSettings: () => ({}),
  loadVisionConfig: () => undefined,
  resolveModelSettingsProfile: () => ({ multimodal: false }),
}));
vi.mock("../chat/image-send-strategy", () => ({
  decideImageSendStrategy: () => ({ mode: "none" }),
}));
vi.mock("./agent-input", () => ({
  buildChannelAttachmentInputs: async () => ({ attachments: [], imageAttachments: [] }),
}));
vi.mock("./agent-policy", () => ({
  resolveChannelAgentPolicy: () => ({ exposeTools: false, executionMode: "chat" }),
  enforceChannelAgentPolicy: vi.fn(),
}));

// eslint-disable-next-line import/first
import { createChannelsSubsystem, type ChannelsSubsystemDeps } from "./bootstrap";
// eslint-disable-next-line import/first
import { initializeChannels, startChannels, shutdownChannels } from "./init";

function makeChannelsDeps(): ChannelsSubsystemDeps {
  return {
    agentRuntime: {} as ChannelsSubsystemDeps["agentRuntime"],
    ttsSynthesisService: {} as ChannelsSubsystemDeps["ttsSynthesisService"],
    getReactChatWindow: () => null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createChannelsSubsystem lifecycle", () => {
  it("does not initialize or start channels during construction", () => {
    const lifecycle = { initialize: vi.fn(), start: vi.fn(), shutdown: vi.fn() };
    const subsystem = createChannelsSubsystem(makeChannelsDeps(), lifecycle);
    expect(lifecycle.initialize).not.toHaveBeenCalled();
    expect(lifecycle.start).not.toHaveBeenCalled();
    subsystem.initialize();
    expect(lifecycle.initialize).toHaveBeenCalledOnce();
  });

  it("starts channels only after explicit start", async () => {
    const lifecycle = { initialize: vi.fn(), start: vi.fn(async () => undefined), shutdown: vi.fn() };
    const subsystem = createChannelsSubsystem(makeChannelsDeps(), lifecycle);
    await subsystem.start();
    expect(lifecycle.start).toHaveBeenCalledOnce();
  });

  it("resolves adaptersRegistered only after synchronous adapter initialization succeeds", async () => {
    const lifecycle = { initialize: vi.fn(), start: vi.fn(async () => undefined), shutdown: vi.fn() };
    const subsystem = createChannelsSubsystem(makeChannelsDeps(), lifecycle);
    let settled = false;
    void subsystem.adaptersRegistered.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    subsystem.initialize();
    await expect(subsystem.adaptersRegistered).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it("rejects adaptersRegistered when adapter initialization fails", async () => {
    const lifecycle = {
      initialize: vi.fn(() => { throw new Error("adapter registration failed"); }),
      start: vi.fn(async () => undefined),
      shutdown: vi.fn(),
    };
    const subsystem = createChannelsSubsystem(makeChannelsDeps(), lifecycle);
    expect(() => subsystem.initialize()).toThrow("adapter registration failed");
    await expect(subsystem.adaptersRegistered).rejects.toThrow("adapter registration failed");
  });

  it("forwards the abort signal to the lifecycle start", async () => {
    const lifecycle = { initialize: vi.fn(), start: vi.fn(async () => undefined), shutdown: vi.fn() };
    const subsystem = createChannelsSubsystem(makeChannelsDeps(), lifecycle);
    const controller = new AbortController();
    await subsystem.start(controller.signal);
    expect(lifecycle.start).toHaveBeenCalledOnce();
    expect(lifecycle.start).toHaveBeenCalledWith(controller.signal);
  });

  it("delegates shutdown to the lifecycle adapter", async () => {
    const lifecycle = { initialize: vi.fn(), start: vi.fn(async () => undefined), shutdown: vi.fn() };
    const subsystem = createChannelsSubsystem(makeChannelsDeps(), lifecycle);
    await subsystem.shutdown();
    expect(lifecycle.shutdown).toHaveBeenCalledOnce();
  });

  it("defaults to the channels init module when no lifecycle adapter is provided", () => {
    const subsystem = createChannelsSubsystem(makeChannelsDeps());
    expect(initializeChannels).not.toHaveBeenCalled();
    expect(startChannels).not.toHaveBeenCalled();
    subsystem.initialize();
    expect(initializeChannels).toHaveBeenCalledOnce();
    void startChannels;
    void shutdownChannels;
  });

  it("渠道超时终态不进入成功收尾", async () => {
    const onRunFinished = vi.fn(async () => ({ sticker: null }));
    const agentRuntime = {
      buildOptions: vi.fn(async () => ({
        options: { executionMode: "chat", conversationMode: "chat" },
        latestUserText: "unused",
      })),
      onRunFinished,
      buildSchedulerOptions: vi.fn(),
    } as unknown as ChannelsSubsystemDeps["agentRuntime"];
    createChannelsSubsystem({
      ...makeChannelsDeps(),
      agentRuntime,
    });

    const buildAndRunAgent = channelMocks.buildAndRunAgent;
    if (!buildAndRunAgent) throw new Error("渠道 Agent 执行函数未注册");
    const result = await buildAndRunAgent({
      channel: "telegram",
      chatType: "direct",
      senderId: "user-1",
      at: new Date("2026-09-02T00:00:00Z"),
    }, "channel-session", []) as { text: string };

    expect(result.text).toBe("超时前的部分回复");
    expect(onRunFinished).not.toHaveBeenCalled();
  });
});
