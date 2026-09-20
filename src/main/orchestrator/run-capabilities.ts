import type { ConversationMode } from "../../shared/chat-types";
import type { SkillEntry, SkillMode, SkillModeOverrides } from "../skills/types";
import type { ToolDefinition, ToolModeOverrides } from "./tools/registry/tool-registry";
import { filterToolsBySearchBackend, type SearchBackend } from "./search-backend-filter";

export interface RunCapabilities {
  mode: ConversationMode;
  tools: readonly ToolDefinition[];
  toolIds: ReadonlySet<string>;
  skills: readonly SkillEntry[];
  skillIds: ReadonlySet<string>;
}

export interface ResolveRunCapabilitiesInput {
  mode: ConversationMode;
  activeSearchBackend: SearchBackend;
  toolModeOverrides?: ToolModeOverrides;
  skillModeOverrides?: SkillModeOverrides;
  /** 是否为桌面 Chat；桌面采用完整 Collab 工具集合，渠道只保留 chatBuiltin。 */
  desktopChat?: boolean;
  /** 仅桌面 Chat 改用插件记忆时为 false。 */
  useNativeChatSystems?: boolean;
  toolRegistry: { getEnabledToolsForMode(mode: ConversationMode, overrides?: ToolModeOverrides): ToolDefinition[] };
  skillRegistry: { getEnabledForMode(mode: SkillMode, overrides?: SkillModeOverrides): SkillEntry[] };
}

const NATIVE_CHAT_MEMORY_TOOL_IDS = new Set(["user_memory", "read_memory", "write_memory", "recall_history"]);
export function isNativeChatMemoryTool(id: string): boolean { return NATIVE_CHAT_MEMORY_TOOL_IDS.has(id); }

export function resolveRunCapabilities(input: ResolveRunCapabilitiesInput): RunCapabilities {
  if (input.mode === "chat") {
    // 桌面 Chat 对齐本地 Collab：暴露所有对 chat 可见且已启用的工具，
    // 不再依赖上游 Chat 工具总开关或逐项 opt-in。显式 override.chat=false
    // 仍由 registry 作为单项逃生门处理；渠道调用方继续只取 chatBuiltin。
    const modeTools = input.toolRegistry.getEnabledToolsForMode("chat", input.toolModeOverrides);
    const builtinTools = modeTools.filter((tool) => tool.chatBuiltin === true);
    if (!input.desktopChat) {
      const tools = filterToolsBySearchBackend(builtinTools, input.activeSearchBackend)
        .filter((tool) => input.useNativeChatSystems !== false || !isNativeChatMemoryTool(tool.id));
      return { mode: input.mode, tools, toolIds: new Set(tools.map((tool) => tool.id)), skills: [], skillIds: new Set() };
    }
    const tools = filterToolsBySearchBackend(modeTools, input.activeSearchBackend)
      .filter((tool) => input.useNativeChatSystems !== false || !isNativeChatMemoryTool(tool.id));
    return {
      mode: input.mode,
      tools,
      toolIds: new Set(tools.map((tool) => tool.id)),
      skills: [],
      skillIds: new Set(),
    };
  }
  const tools = filterToolsBySearchBackend(
    input.toolRegistry.getEnabledToolsForMode(input.mode, input.toolModeOverrides),
    input.activeSearchBackend,
  );
  const skills = input.skillRegistry.getEnabledForMode(input.mode, input.skillModeOverrides);
  return { mode: input.mode, tools, toolIds: new Set(tools.map((tool) => tool.id)), skills, skillIds: new Set(skills.map((skill) => skill.id)) };
}
