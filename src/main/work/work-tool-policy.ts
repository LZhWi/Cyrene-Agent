import type { ToolDefinition } from "../orchestrator/tool-registry";

// These tools are coupled to Chat/Collab state or UI. Work has its own memory,
// model runtime, and clarification flow, so they must never enter its catalog.
const WORK_EXCLUDED_TOOL_IDS = new Set([
  "recall_history",
  "user_memory",
  "delegate_task",
  "ask_user_choice",
]);

export function filterWorkTools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.filter((tool) => !WORK_EXCLUDED_TOOL_IDS.has(tool.id));
}
