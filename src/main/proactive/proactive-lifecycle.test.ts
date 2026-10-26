import { describe, expect, it, vi } from "vitest";
import type { GeneralSettings } from "../settings/general-settings";

vi.mock("electron", () => ({ powerMonitor: { on: vi.fn(), getSystemIdleTime: () => 0 } }));
vi.mock("../chats/chats-store", () => ({}));
vi.mock("../chats/chats-ipc", () => ({ broadcastChatsChanged: vi.fn() }));
vi.mock("../channels/init", () => ({ setChannelsConversationLifecycle: vi.fn() }));
vi.mock("../channels/manager", () => ({ channelManager: {} }));
vi.mock("../channels/proactive-delivery", () => ({}));
vi.mock("../orchestrator", () => ({}));
vi.mock("../prompts/prompt-loader", () => ({}));
vi.mock("../settings/model-settings", () => ({}));
vi.mock("../settings-store", () => ({}));
vi.mock("./proactive-state-store", () => ({ loadProactiveState: vi.fn(), saveProactiveState: vi.fn() }));
vi.mock("./proactive-model", () => ({}));
vi.mock("./proactive-service", () => ({ createProactiveChatService: vi.fn() }));
import { createProactiveChatService } from "./proactive-service";
import { createProactiveLifecycle } from "./proactive-lifecycle";

describe("主动状态归属", () => {
  it("陪伴对话不推进原生主动状态，切回原生后保留原来的生命周期", () => {
    const service = { invalidateForUserMessage: vi.fn(), normalConversationStarted: vi.fn(), normalConversationEnded: vi.fn() };
    vi.mocked(createProactiveChatService).mockReturnValue(service as any);
    const settings = { chatBackend: "companion", proactiveChatMode: "on" } as GeneralSettings;
    const lifecycle = createProactiveLifecycle({ loadGeneralSettings: () => settings });
    lifecycle.initializeProactiveChatService();
    const conversation = lifecycle.proactiveConversationLifecycle;
    conversation.onUserMessage(); conversation.onConversationStarted(); conversation.onConversationEnded();
    for (const handler of Object.values(service)) expect(handler).not.toHaveBeenCalled();
    settings.chatBackend = "native";
    conversation.onUserMessage(); conversation.onConversationStarted(); conversation.onConversationStarted();
    conversation.onConversationEnded();
    expect(service.normalConversationEnded).not.toHaveBeenCalled();
    conversation.onConversationEnded();
    expect(service.invalidateForUserMessage).toHaveBeenCalledOnce();
    expect(service.normalConversationStarted).toHaveBeenCalledTimes(2);
    expect(service.normalConversationEnded).toHaveBeenCalledOnce();
  });
});
