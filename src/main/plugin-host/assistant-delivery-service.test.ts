import { describe, expect, it, vi } from "vitest";
import { isPluginHostError } from "../../plugins/api";
import { createPluginAssistantDeliveryService } from "./assistant-delivery-service";

describe("插件助手消息投递服务", () => {
  it("只把插件身份和纯文本交给受控宿主写入口", async () => {
    const append = vi.fn(async () => ({
      conversationId: "proactive-1",
      messageId: "message-1",
      at: "2026-09-18T00:00:00.000Z",
    }));
    const service = createPluginAssistantDeliveryService({
      pluginId: "companion-chat",
      sink: { append },
    });
    await expect(service.postProactiveMessage("主动问候")).resolves.toEqual({
      conversationId: "proactive-1",
      messageId: "message-1",
      at: "2026-09-18T00:00:00.000Z",
    });
    expect(append).toHaveBeenCalledWith({
      pluginId: "companion-chat",
      text: "主动问候",
      allowIgnoreFeedback: false,
    });
    await service.postProactiveMessage("再次问候", { allowIgnoreFeedback: true });
    expect(append).toHaveBeenLastCalledWith({
      pluginId: "companion-chat",
      text: "再次问候",
      allowIgnoreFeedback: true,
    });
  });

  it("拒绝空文本、超长文本和停止后的调用", async () => {
    const append = vi.fn();
    const controller = new AbortController();
    const service = createPluginAssistantDeliveryService({
      pluginId: "companion-chat",
      signal: controller.signal,
      sink: { append },
    });
    for (const text of ["   ", "x".repeat(32_001)]) {
      await expect(service.postProactiveMessage(text)).rejects.toSatisfy(
        (error: unknown) => isPluginHostError(error) && error.code === "E_INVALID_ARGUMENT",
      );
    }
    await expect(service.postProactiveMessage("你好", { allowIgnoreFeedback: "yes" } as any)).rejects.toSatisfy(
      (error: unknown) => isPluginHostError(error) && error.code === "E_INVALID_ARGUMENT",
    );
    controller.abort();
    await expect(service.postProactiveMessage("你好")).rejects.toSatisfy(
      (error: unknown) => isPluginHostError(error) && error.code === "E_PLUGIN_STOPPING",
    );
    expect(append).not.toHaveBeenCalled();
  });

  it("异步写入期间插件停止时不把迟到成功回传给插件", async () => {
    let resolve!: (value: { conversationId: string; messageId: string; at: string }) => void;
    const controller = new AbortController();
    const service = createPluginAssistantDeliveryService({
      pluginId: "companion-chat",
      signal: controller.signal,
      sink: { append: () => new Promise((done) => { resolve = done; }) },
    });
    const pending = service.postProactiveMessage("你好");
    controller.abort();
    resolve({ conversationId: "proactive-1", messageId: "message-1", at: "2026-09-18T00:00:00.000Z" });
    await expect(pending).rejects.toSatisfy(
      (error: unknown) => isPluginHostError(error) && error.code === "E_PLUGIN_STOPPING",
    );
  });
});
