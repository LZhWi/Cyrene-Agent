import type { ActionDecision } from "./agent-graph";
import { buildToolExecutionContext } from "./tool-execution-context";
import type { JsonSchemaProp, ToolDefinition } from "./tool-registry";
import type { ToolCallResult } from "./types";
import type { ChatMessage, ChatRequest, ChatResponse } from "./vendors/types";

type ActDecision = Extract<ActionDecision, { decision: "act" }>;

export function resolveToolForCapability(tools: ToolDefinition[], capability: string): ToolDefinition {
  const matches = tools.filter((tool) => tool.enabled && (tool.capability ?? tool.id) === capability);
  if (matches.length === 0) throw new Error("E_ACTION_CAPABILITY_UNAVAILABLE");
  if (matches.length > 1) throw new Error("E_ACTION_CAPABILITY_AMBIGUOUS");
  return matches[0];
}

export function buildToolArgumentRequest(input: {
  model: string;
  messages: ChatMessage[];
  toolSystemContent: string;
  citaContextBlock: string;
  decision: ActDecision;
  toolResults: ToolCallResult[];
  tool: ToolDefinition;
  protocolFeedback?: string;
}): ChatRequest {
  const systemContent = [
    input.toolSystemContent,
    "## Runtime 参数解析",
    "Action Gate 已选择下面的能力。你只负责填写该工具参数，只返回一个 JSON 对象，不要使用 Markdown，不要输出 JSON 之外的文字。",
    "不得编造 ContextRef、Provider ID、歌曲 ID、歌单 ID或其他受控标识；只能使用给定可信引用或前序工具事实。",
    `行动目标：${input.decision.objective}`,
    `可信引用：${JSON.stringify(input.decision.targetRefs)}`,
    `工具：${input.tool.id}`,
    `参数 Schema：${JSON.stringify(input.tool.inputSchema)}`,
    input.citaContextBlock,
    buildToolExecutionContext(input.toolResults),
    input.protocolFeedback ? `上一次 JSON 参数无效，请修正。错误：${input.protocolFeedback}` : "",
  ].filter(Boolean).join("\n\n");
  return {
    model: input.model,
    messages: [{ role: "system", content: systemContent }, ...input.messages],
    stream: false,
  };
}

function parseObject(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("E_TOOL_ARGUMENT_PROTOCOL");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("E_TOOL_ARGUMENT_PROTOCOL");
  return value as Record<string, unknown>;
}

function validateValue(value: unknown, schema: JsonSchemaProp): boolean {
  if (schema.type === "array" && "items" in schema) {
    return Array.isArray(value) && value.every((item) => validateValue(item, schema.items));
  }
  if (schema.type === "object" && "properties" in schema) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => !(key in schema.properties))) return false;
    if (schema.required?.some((key: string) => !(key in record))) return false;
    return Object.entries(record).every(([key, item]) => validateValue(item, schema.properties[key]));
  }
  if (schema.type === "number" && typeof value !== "number") return false;
  if (schema.type === "string" && typeof value !== "string") return false;
  if (schema.type === "boolean" && typeof value !== "boolean") return false;
  return !("enum" in schema) || schema.enum === undefined || (typeof value === "string" && schema.enum.includes(value));
}

function validateRoot(args: Record<string, unknown>, tool: ToolDefinition): void {
  const schema = tool.inputSchema;
  if (Object.keys(args).some((key) => !(key in schema.properties))) throw new Error("E_TOOL_ARGUMENT_SCHEMA");
  if (schema.required?.some((key) => !(key in args))) throw new Error("E_TOOL_ARGUMENT_SCHEMA");
  for (const [key, value] of Object.entries(args)) {
    if (!validateValue(value, schema.properties[key])) throw new Error("E_TOOL_ARGUMENT_SCHEMA");
  }
}

function parsedSuccessfulOutputs(results: ToolCallResult[]): unknown[] {
  return results.filter((result) => result.status === "succeeded").flatMap((result) => {
    try { return [JSON.parse(result.output) as unknown]; } catch { return []; }
  });
}

function collectNamedValues(value: unknown, keyName: string, output: Set<unknown>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectNamedValues(item, keyName, output));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === keyName) {
      if (Array.isArray(child)) child.forEach((item) => output.add(item));
      else output.add(child);
    }
    collectNamedValues(child, keyName, output);
  }
}

function validateControlledInputs(
  args: Record<string, unknown>,
  tool: ToolDefinition,
  targetRefs: string[],
  toolResults: ToolCallResult[],
): void {
  const successful = parsedSuccessfulOutputs(toolResults);
  for (const [key, policy] of Object.entries(tool.controlledInput ?? {})) {
    const value = args[key];
    if (value === undefined) continue;
    if (policy === "context_ref" || policy === "context_ref_array") {
      const allowed = new Set<unknown>(targetRefs);
      for (const output of successful) {
        for (const refKey of [key, "contextRef", "candidateRef", "setRef"]) collectNamedValues(output, refKey, allowed);
      }
      const values = policy === "context_ref_array" && Array.isArray(value) ? value : [value];
      if (values.some((item) => !allowed.has(item))) throw new Error("E_TOOL_ARGUMENT_SOURCE");
      continue;
    }
    const allowed = new Set<unknown>();
    successful.forEach((output) => collectNamedValues(output, key, allowed));
    if (!allowed.has(value)) throw new Error("E_TOOL_ARGUMENT_SOURCE");
  }
}

export function parseAndValidateToolArguments(
  response: ChatResponse,
  tool: ToolDefinition,
  targetRefs: string[],
  toolResults: ToolCallResult[],
): Record<string, unknown> {
  const args = parseObject(response.text);
  validateRoot(args, tool);
  validateControlledInputs(args, tool, targetRefs, toolResults);
  return args;
}
