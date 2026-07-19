import type { ActionDecision } from "./agent-graph";
import { buildToolExecutionContext } from "./tool-execution-context";
import type { ToolDefinition } from "./tool-registry";
import type { ToolCallResult } from "./types";
import type { ChatMessage, ChatRequest, ChatResponse, ToolCall } from "./vendors/types";

type ActDecision = Extract<ActionDecision, { decision: "act" }>;

export function resolveToolForCapability(tools: ToolDefinition[], capability: string): ToolDefinition {
  const matches = tools.filter((tool) => tool.enabled && (tool.capability ?? tool.id) === capability);
  if (matches.length === 0) throw new Error("E_ACTION_CAPABILITY_UNAVAILABLE");
  if (matches.length > 1) throw new Error("E_ACTION_CAPABILITY_AMBIGUOUS");
  return matches[0];
}

export function buildForcedToolRequest(input: {
  model: string;
  messages: ChatMessage[];
  toolSystemContent: string;
  citaContextBlock: string;
  decision: ActDecision;
  toolResults: ToolCallResult[];
  tool: ToolDefinition;
}): ChatRequest {
  const systemContent = [
    input.toolSystemContent,
    "## Runtime 强制行动",
    "Action Gate 已判定本轮必须执行下面这个工具。你只负责根据原始对话和可信上下文填写参数，必须实际调用该工具，不得输出自由文本。",
    `行动目标：${input.decision.objective}`,
    `可信引用：${JSON.stringify(input.decision.targetRefs)}`,
    input.citaContextBlock,
    buildToolExecutionContext(input.toolResults),
  ].filter(Boolean).join("\n\n");
  return {
    model: input.model,
    messages: [{ role: "system", content: systemContent }, ...input.messages],
    tools: [{
      name: input.tool.id,
      description: input.tool.description,
      parameters: {
        type: "object",
        properties: input.tool.inputSchema.properties,
        ...(input.tool.inputSchema.required ? { required: input.tool.inputSchema.required } : {}),
      },
    }],
    toolChoice: { name: input.tool.id },
    stream: false,
  };
}

export function parseForcedToolResponse(response: ChatResponse, expectedToolId: string): ToolCall {
  if (response.toolCalls.length !== 1 || response.toolCalls[0].name !== expectedToolId) {
    throw new Error("E_FORCED_TOOL_PROTOCOL");
  }
  return response.toolCalls[0];
}
