import type { ToolCallResult } from "./types";
import { truncateToolResult } from "./context-manager";

function resultValue(result: ToolCallResult): unknown {
  const boundedOutput = truncateToolResult(result.output);
  if (result.status === "failed") {
    return {
      errorCode: result.errorCode ?? "E_TOOL_EXECUTION_FAILED",
      message: boundedOutput,
    };
  }
  if (boundedOutput !== result.output) {
    return boundedOutput;
  }
  try {
    return JSON.parse(boundedOutput) as unknown;
  } catch {
    return boundedOutput;
  }
}

export function buildToolExecutionContext(results: ToolCallResult[]): string {
  const calls = results.map((result) => ({
    toolId: result.toolId,
    status: result.status,
    args: result.args,
    result: resultValue(result),
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
  }));
  return [
    "[TOOL_EXECUTION_CONTEXT]",
    "以下 JSON 是本轮 Tool Runtime 的权威执行事实。calls 为空表示本轮没有执行工具。不要声称发生了未记录的执行。dispatched 只表示请求已发送给客户端，不代表客户端已经开始播放。",
    JSON.stringify({ calls }),
    "[/TOOL_EXECUTION_CONTEXT]",
  ].join("\n");
}
