import type { ToolDefinition } from "../orchestrator/tool-registry";
import type { WorkSessionMode } from "../../shared/work-types";

// These tools are coupled to Chat/Collab state or UI. Work has its own memory,
// model runtime, and clarification flow, so they must never enter its catalog.
const WORK_EXCLUDED_TOOL_IDS = new Set([
  "recall_history",
  "user_memory",
  "delegate_task",
  "ask_user_choice",
]);

export function filterWorkTools(tools: ToolDefinition[], mode: WorkSessionMode = "work"): ToolDefinition[] {
  // Code/Learn 对用户承诺绑定目录只读：执行层不继承普通 Work 的全局工具或 MCP，
  // 只使用 work-ipc 随绑定目录临时注入的 file_list/file_read/file_search。
  if (mode === "code" || mode === "learn") return [];
  return tools.filter((tool) => !WORK_EXCLUDED_TOOL_IDS.has(tool.id));
}
