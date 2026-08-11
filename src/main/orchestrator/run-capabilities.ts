import type { ConversationMode } from "../../shared/chat-types";
import type { SkillEntry, SkillMode, SkillModeOverrides } from "../skills/types";
import type { ToolDefinition, ToolModeOverrides } from "./tool-registry";
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
  toolRegistry: { getEnabledToolsForMode(mode: ConversationMode, overrides?: ToolModeOverrides): ToolDefinition[] };
  skillRegistry: { getEnabledForMode(mode: SkillMode, overrides?: SkillModeOverrides): SkillEntry[] };
}

export function resolveRunCapabilities(input: ResolveRunCapabilitiesInput): RunCapabilities {
  if (input.mode === "chat") {
    return { mode: input.mode, tools: [], toolIds: new Set(), skills: [], skillIds: new Set() };
  }
  const tools = filterToolsBySearchBackend(
    input.toolRegistry.getEnabledToolsForMode(input.mode, input.toolModeOverrides),
    input.activeSearchBackend,
  );
  const skills = input.skillRegistry.getEnabledForMode(input.mode, input.skillModeOverrides);
  return { mode: input.mode, tools, toolIds: new Set(tools.map((tool) => tool.id)), skills, skillIds: new Set(skills.map((skill) => skill.id)) };
}
