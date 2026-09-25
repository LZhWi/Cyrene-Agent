import { createHash } from "node:crypto";
import type { ChatMessage, ChatRequest } from "./vendors/types";

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** 仅记录本地结构元数据；不输出 prompt、聊天正文、图片数据或凭据。 */
export function logPromptCacheSegments(
  phase: "tool" | "soul",
  segments: ReadonlyArray<{ name: string; content: string }>,
): void {
  console.log(`[PromptCacheDiag] segments(${phase}) =`, JSON.stringify(segments.map((segment) => ({
    name: segment.name,
    chars: segment.content.length,
    sha256: fingerprint(segment.content),
  }))));
}

function contentKind(content: ChatMessage["content"]): "blocks" | "text" {
  return Array.isArray(content) ? "blocks" : "text";
}

/** 与本地项目同口径的模型请求诊断；只记录长度、哈希、角色及工具数量。 */
export function logPromptCacheRequest(phase: "tool" | "soul", request: ChatRequest): void {
  const messages = request.messages.map((message, index) => {
    const serialized = JSON.stringify(message);
    return {
      index,
      role: message.role,
      chars: serialized.length,
      sha256: fingerprint(serialized),
      contentKind: contentKind(message.content),
    };
  });
  const serializedTools = JSON.stringify(request.tools ?? []);
  console.log(`[PromptCacheDiag] request(${phase}) =`, JSON.stringify({
    model: request.model,
    cacheKey: typeof request.extraBody?.prompt_cache_key === "string"
      ? request.extraBody.prompt_cache_key
      : null,
    messageCount: messages.length,
    messages,
    toolCount: request.tools?.length ?? 0,
    toolsChars: serializedTools.length,
    toolsSha256: fingerprint(serializedTools),
  }));
}
