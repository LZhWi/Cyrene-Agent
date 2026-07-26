import { buildToolExecutionContext } from "./tool-execution-context";
import type { ToolDefinition } from "./tool-registry";
import type { ToolCallResult } from "./types";
import type { ChatRequest, ChatResponse, ToolCall } from "./vendors/types";

export interface NativeToolCallInput {
  model: string;
  nativeFcSystemPrompt: string;
  executionBrief: string;
  /** 本地主进程提供的可信默认值与绝对路径。 */
  runtimeEnvironmentContext?: string;
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
    input.nativeFcSystemPrompt,
    input.runtimeEnvironmentContext
      ? `[TRUSTED_RUNTIME_ENVIRONMENT]\n${input.runtimeEnvironmentContext}\n[/TRUSTED_RUNTIME_ENVIRONMENT]`
      : "",
    input.executionBrief,
    buildToolExecutionContext(input.toolResults),
    input.protocolFeedback ? `上一次工具参数未通过 Runtime 校验：${input.protocolFeedback}` : "",
  ].filter(Boolean).join("\n\n");
  return {
    model: input.model,
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: "请根据 EXECUTION_BRIEF 填写工具参数。" },
    ],
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
