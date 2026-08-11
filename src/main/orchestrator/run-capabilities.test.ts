import { describe, expect, it } from "vitest";
import { resolveRunCapabilities } from "./run-capabilities";

const tool = (id: string, modes?: Array<"chat" | "work" | "learn" | "code">) => ({ id, modes, enabled: true });
const skill = (id: string, modes?: Array<"work" | "learn" | "code">) => ({ id, modes, enabled: true });

describe("resolveRunCapabilities", () => {
  const tools = [tool("read_file"), tool("git_commit", ["code"]), tool("web_search")];
  const skills = [skill("office", ["work"]), skill("code-review", ["code"]), skill("study", ["learn"])];
  const input = (mode: "chat" | "work" | "learn" | "code") => ({
    mode,
    activeSearchBackend: "off" as const,
    toolRegistry: { getEnabledToolsForMode: (target: typeof mode) => tools.filter((item) => !item.modes || item.modes.includes(target)) as any },
    skillRegistry: { getEnabledForMode: (target: "work" | "learn" | "code") => skills.filter((item) => !item.modes || item.modes.includes(target)) as any },
  });

  it("makes chat capability-free", () => {
    const result = resolveRunCapabilities(input("chat"));
    expect(result.tools).toEqual([]);
    expect(result.skills).toEqual([]);
  });

  it("honors mode filtering for tools and skills", () => {
    expect(resolveRunCapabilities(input("work")).toolIds).not.toContain("git_commit");
    expect(resolveRunCapabilities(input("code")).toolIds).toContain("git_commit");
    expect(resolveRunCapabilities(input("learn")).skillIds).toEqual(new Set(["study"]));
  });
});
