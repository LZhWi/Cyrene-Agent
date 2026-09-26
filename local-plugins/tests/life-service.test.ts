import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createMockPluginContext } from "@playa0v0/cyrene-plugin-sdk/testing";
import chatPlugin from "../plugins/companion-chat/src/index";
import { CHAT_ID } from "../plugins/shared/protocol";

it("生活休息期照常接受任务并回复，不扩展生活提示词到工作模式", async () => {
  const parent = path.resolve(".test-runtime");
  mkdirSync(parent, { recursive: true });
  const parentReal = realpathSync(parent), root = mkdtempSync(path.join(parent, "life-service-"));
  const generateText = vi.fn().mockResolvedValue("可以，先检查边界条件。");
  const ctx = createMockPluginContext({ pluginId: CHAT_ID, deps: { llm: { generateText } } });
  ctx.storage.rootDir = () => root;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 26, 2));
  try {
    await chatPlugin.register(ctx);
    expect(await ctx.ipcChannels.get("life-status")!()).toMatchObject({ resting: true });
    const provider = ctx.promptProviders.find((item) => item.id === "life-context")!;
    expect(provider.modes).toEqual(["chat"]);
    expect(provider.sources).toEqual(["conversation"]);
    expect(generateText).not.toHaveBeenCalled();
    const invoke = async (action: string, data?: unknown) => await ctx.ipcChannels.get("ui")!(action, data) as any;
    const session = await invoke("new");
    const sent = await invoke("send", { sessionId: session.data, text: "帮我检查这段算法的边界条件" });
    expect(sent.ok).toBe(true);
    expect(generateText).toHaveBeenCalledOnce();
    const state = await invoke("state");
    expect(state.data.chat.sessions[0].messages.at(-1).text).toBe("可以，先检查边界条件。");
  } finally {
    await ctx.dispose();
    await chatPlugin.unregister?.();
    vi.useRealTimers();
    if (path.dirname(realpathSync(root)) !== parentReal || !path.basename(root).startsWith("life-service-")) throw new Error("测试目录越界");
    rmSync(root, { recursive: true, force: true });
  }
});
