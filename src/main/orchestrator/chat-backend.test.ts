import { describe, expect, it } from "vitest";
import {
  resolveChatBackend,
  shouldUseNativeChatSystems,
  shouldUseNativeProactiveChat,
} from "./chat-backend";

describe("resolveChatBackend", () => {
  it("只允许桌面 Chat 显式切换到陪伴后端", () => {
    expect(resolveChatBackend({ mode: "chat", source: "desktop", chatBackend: "companion" })).toBe("companion");
    expect(shouldUseNativeChatSystems({ mode: "chat", source: "desktop", chatBackend: "companion" })).toBe(false);
  });

  it("缺省值、其他模式、渠道和非法值均保持原生", () => {
    expect(resolveChatBackend({ mode: "chat", source: "desktop" })).toBe("native");
    expect(resolveChatBackend({ mode: "chat", source: "desktop", chatBackend: "invalid" })).toBe("native");
    for (const mode of ["work", "code", "learn"]) {
      expect(resolveChatBackend({ mode, source: "desktop", chatBackend: "companion" })).toBe("native");
    }
    expect(resolveChatBackend({ mode: "chat", source: "channel", channel: "wechat", chatBackend: "companion" })).toBe("native");
    expect(resolveChatBackend({ mode: "chat", chatBackend: "companion" })).toBe("native");
  });

  it("陪伴后端完整接管主动聊天开关，不因旧投递目标重新启动上游控制器", () => {
    expect(shouldUseNativeProactiveChat({
      chatBackend: "companion", proactiveChatMode: "on", proactiveDeliveryTarget: "local",
    })).toBe(false);
    expect(shouldUseNativeProactiveChat({
      chatBackend: "native", proactiveChatMode: "on", proactiveDeliveryTarget: "local",
    })).toBe(true);
    expect(shouldUseNativeProactiveChat({
      chatBackend: "companion", proactiveChatMode: "on", proactiveDeliveryTarget: "wechat",
    })).toBe(false);
    expect(shouldUseNativeProactiveChat({
      chatBackend: "companion", proactiveChatMode: "off", proactiveDeliveryTarget: "local",
    })).toBe(false);
  });
});
