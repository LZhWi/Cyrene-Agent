import type { VendorConfig } from "../orchestrator/vendors";

export function sameProactiveModel(left: VendorConfig, right: VendorConfig): boolean {
  const identity = (value: VendorConfig) => [value.provider, value.baseUrl, value.apiKey, value.model,
    value.explicitTransport ?? "auto", value.reasoning?.mode ?? "auto", value.reasoning?.effort ?? "", value.reasoning?.proMode ?? false];
  return JSON.stringify(identity(left)) === JSON.stringify(identity(right));
}

/** Never pass a judge's draft or instructions to the content model. */
export async function runProactiveStages(
  sameModel: boolean,
  generate: (stage: "decision" | "content", instruction?: string) => Promise<string>,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (sameModel) return generate("content");
  const raw = await generate("decision", '本次只负责判定是否值得主动打扰用户，不生成消息内容。沿用全部场景与静默约束，但覆盖原先包含 text 的输出格式：只返回 {"decision":"send"} 或 {"decision":"silent"}，不要解释。');
  signal?.throwIfAborted();
  let decision: unknown;
  try { decision = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, "$1")); }
  catch { return '{"decision":"invalid"}'; }
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return '{"decision":"invalid"}';
  const kind = (decision as { decision?: unknown }).decision;
  if (kind === "silent") return '{"decision":"silent","text":""}';
  if (kind !== "send") return '{"decision":"invalid"}';
  return generate("content", '发送判定已通过。本次负责根据原有上下文、角色和全部约束生成主动消息，保持原来的 JSON 输出格式。不要提及判定过程；若无法生成合适内容，仍可返回 silent。');
}
