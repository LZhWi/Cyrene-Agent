import { describe, expect, it } from "vitest";
import { resolveRunCapabilities } from "./run-capabilities";

const tool = (id: string, modes?: Array<"chat" | "work" | "learn" | "code">, chatBuiltin?: boolean) =>
  ({ id, modes, enabled: true, ...(chatBuiltin ? { chatBuiltin } : {}) });
const skill = (id: string, modes?: Array<"work" | "learn" | "code">) => ({ id, modes, enabled: true });

describe("resolveRunCapabilities", () => {
  const tools = [
    tool("read_file"),
    tool("git_commit", ["code"]),
    tool("web_search"),
    tool("weather"),
    tool("moments_view", ["chat"], true),
    tool("moments_post", ["chat"], true),
  ];
  const skills = [skill("office", ["work"]), skill("code-review", ["code"]), skill("study", ["learn"])];
  // fake registry 镜像真实现：override 优先于 modes 声明
  const filterTools = (mode: string, overrides?: Record<string, any>) =>
    tools.filter((item) => {
      const override = overrides?.[item.id]?.[mode];
      if (override !== undefined) return override;
      return !item.modes || item.modes.includes(mode);
    });
  const input = (mode: "chat" | "work" | "learn" | "code", toolModeOverrides?: Record<string, any>) => ({
    mode,
    activeSearchBackend: "off" as const,
    toolModeOverrides,
    toolRegistry: { getEnabledToolsForMode: (target: typeof mode) => filterTools(target, toolModeOverrides) as any },
    skillRegistry: { getEnabledForMode: (target: "work" | "learn" | "code") => skills.filter((item) => !item.modes || item.modes.includes(target)) as any },
  });

  it("keeps channel chat limited to builtin tools", () => {
    // 非桌面 Chat（渠道）只保留内置人格工具。
    const result = resolveRunCapabilities(input("chat"));
    expect([...result.toolIds]).toEqual(["moments_view", "moments_post"]);
    expect(result.skills).toEqual([]);
  });

  it("仅在插件接管 Chat 时移除原生记忆工具，保留其他工具与模式", () => {
    const extraTools = [...tools, tool("user_memory", ["chat"], true), tool("weather_chat", ["chat"], true)];
    const scoped = {
      ...input("chat"),
      toolRegistry: { getEnabledToolsForMode: () => extraTools.filter((item) => item.modes?.includes("chat")) as any },
    };
    expect(resolveRunCapabilities(scoped).toolIds).toContain("user_memory");
    const pluginMemory = resolveRunCapabilities({ ...scoped, useNativeChatSystems: false });
    expect(pluginMemory.toolIds).not.toContain("user_memory");
    expect(pluginMemory.toolIds).toContain("weather_chat");
    expect(pluginMemory.toolIds).toContain("moments_view");
  });

  it("uses every mode-eligible tool for desktop Collab without per-tool opt-in", () => {
    const result = resolveRunCapabilities({ ...input("chat"), desktopChat: true });
    expect([...result.toolIds]).toEqual(["read_file", "weather", "moments_view", "moments_post"]);
    expect(result.skills).toEqual([]);
  });

  it("keeps explicit per-tool disable as the Collab escape hatch", () => {
    const result = resolveRunCapabilities({
      ...input("chat", { weather: { chat: true }, read_file: { chat: false } }),
      desktopChat: true,
    });
    expect([...result.toolIds]).toEqual(["weather", "moments_view", "moments_post"]);
    expect(result.skills).toEqual([]);
  });

  it("chat 内置人格工具：渠道可见，显式勾掉即隐藏", () => {
    // 渠道 Chat 的 chatBuiltin 工具仍放行。
    const off = resolveRunCapabilities(input("chat"));
    expect([...off.toolIds]).toEqual(["moments_view", "moments_post"]);

    // 用户显式 override.chat=false：逃生门仍然有效
    const banned = resolveRunCapabilities(input("chat", { moments_post: { chat: false } }));
    expect([...banned.toolIds]).toEqual(["moments_view"]);

    // Collab 全量集合中 chatBuiltin 也不重复出现
    const dup = resolveRunCapabilities({
      ...input("chat", { moments_view: { chat: true }, weather: { chat: true } }),
      desktopChat: true,
    });
    expect(dup.tools.filter((t) => t.id === "moments_view")).toHaveLength(1);
    expect([...dup.toolIds]).toEqual(["read_file", "weather", "moments_view", "moments_post"]);
  });

  it("honors mode filtering for tools and skills", () => {
    expect(resolveRunCapabilities(input("work")).toolIds).not.toContain("git_commit");
    expect(resolveRunCapabilities(input("code")).toolIds).toContain("git_commit");
    expect(resolveRunCapabilities(input("learn")).skillIds).toEqual(new Set(["study"]));
    // chat 内置工具只声明 chat 模式，不漏进其他模式
    expect(resolveRunCapabilities(input("work")).toolIds).not.toContain("moments_view");
  });
});
