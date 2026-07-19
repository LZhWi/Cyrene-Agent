import type { ActionDecision } from "./agent-graph";
import { buildToolExecutionContext } from "./tool-execution-context";
import type { ToolDefinition } from "./tool-registry";
import type { ToolCallResult } from "./types";
import type { ChatMessage, ChatRequest, ChatResponse, ToolCall } from "./vendors/types";

type ActDecision = Extract<ActionDecision, { decision: "act" }>;

export interface NativeToolCallInput {
  model: string;
  messages: ChatMessage[];
  toolSystemContent: string;
  citaContextBlock: string;
  decision: ActDecision;
  toolResults: ToolCallResult[];
  tool: ToolDefinition;
  protocolFeedback?: string;
}

type InvokeNativeModel = (request: ChatRequest) => Promise<ChatResponse>;

function directToolCall(tool: ToolDefinition): ToolCall {
  return { id: `${tool.id}-${Date.now()}`, name: tool.id, arguments: "{}" };
}

function buildRequest(input: NativeToolCallInput): ChatRequest {
  const systemContent = [
    input.toolSystemContent,
    "## Runtime 原生 Function Calling",
    "Action Gate 已判定本轮必须执行下方能力。请通过 API 原生工具调用返回参数，不要在普通文本中模拟工具调用。",
    `行动目标：${input.decision.objective}`,
    `可信引用：${JSON.stringify(input.decision.targetRefs)}`,
    input.citaContextBlock,
    buildToolExecutionContext(input.toolResults),
    input.protocolFeedback ? `上一次工具参数未通过 Runtime 校验：${input.protocolFeedback}` : "",
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
    toolChoiceIntent: { mode: "must_call", toolName: input.tool.id },
    stream: false,
  };
}

export async function resolveNativeToolCall(
  input: NativeToolCallInput,
  invoke: InvokeNativeModel,
): Promise<ToolCall> {
  if (Object.keys(input.tool.inputSchema.properties).length === 0) return directToolCall(input.tool);
  const response = await invoke(buildRequest(input));
  if (response.toolCalls.length === 1 && response.toolCalls[0].name === input.tool.id) {
    return response.toolCalls[0];
  }
  throw new Error("E_NATIVE_TOOL_PROTOCOL");
}
