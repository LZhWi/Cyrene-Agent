// 子代理结果解析与序列化

import type { SubAgentPublicResultV1 } from "./types";

/** 序列化子代理结果为 JSON 字符串（存入 ToolExecutionOutcome.output） */
export function serializeSubAgentResult(result: SubAgentPublicResultV1): string {
  return JSON.stringify(result);
}

/** 协议错误 */
export class SubAgentProtocolError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "SubAgentProtocolError";
  }
}

/**
 * 唯一的子代理结果解析入口。
 * 所有消费方（Soul 投影、完成证据、Action Gate、Plan Verify）
 * 都应通过此函数解析，不要直接 JSON.parse。
 */
export function parseSubAgentResult(output: string): SubAgentPublicResultV1 {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new SubAgentProtocolError("INVALID_JSON");
  }

  if (
    typeof value !== "object"
    || value === null
    || (value as Record<string, unknown>).kind !== "subagent_result"
    || (value as Record<string, unknown>).version !== 1
  ) {
    throw new SubAgentProtocolError("INVALID_SUBAGENT_RESULT");
  }

  return value as SubAgentPublicResultV1;
}
