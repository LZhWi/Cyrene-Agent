import type { ChatMessage } from "../vendors/types";

const TOOL_RESULT_MAX_CHARS = 12_000;
const WINDOW_COMPRESS_THRESHOLD_CHARS = 80_000;
const KEEP_RECENT_MESSAGES = 6;

function contentToText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => block.type === "text" ? block.text : "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** 与本地两阶段循环一致：单条工具结果只保留前 12000 字符。 */
export function truncateLocalToolResult(content: string): string {
  if (content.length <= TOOL_RESULT_MAX_CHARS) return content;
  return content.slice(0, TOOL_RESULT_MAX_CHARS)
    + `\n[truncated: 原始 ${content.length} 字符，已截断至 ${TOOL_RESULT_MAX_CHARS} 字符]`;
}

/**
 * 与本地两阶段循环一致的窗口压缩。
 * 这里只处理普通消息；Harness 的内部运行消息不会进入本地等价 transcript。
 */
export function compressLocalTwoPhaseTranscript(messages: readonly ChatMessage[]): ChatMessage[] {
  const visible = messages.filter((message) => !message.internal && message.visibility !== "internal")
    .map((message) => ({ ...message }));
  const totalChars = visible.reduce((sum, message) => sum + contentToText(message.content).length, 0);
  if (totalChars <= WINDOW_COMPRESS_THRESHOLD_CHARS) return visible;

  const result = [...visible];
  const nonSystemIndices = result
    .map((message, index) => message.role === "system" ? -1 : index)
    .filter((index) => index >= 0);
  const compressFromIndex = nonSystemIndices.length > KEEP_RECENT_MESSAGES
    ? nonSystemIndices[nonSystemIndices.length - KEEP_RECENT_MESSAGES]
    : -1;

  if (compressFromIndex > 0) {
    for (let index = 0; index < compressFromIndex; index++) {
      if (result[index].role === "system") continue;
      const content = contentToText(result[index].content);
      if (content.length > 500) {
        result[index] = {
          ...result[index],
          content: content.slice(0, 200) + `\n[compressed: 原始 ${content.length} 字符]`,
        };
      }
    }
  }

  let compressedChars = result.reduce((sum, message) => sum + contentToText(message.content).length, 0);
  while (compressedChars > WINDOW_COMPRESS_THRESHOLD_CHARS) {
    const firstNonSystem = result.findIndex((message) => message.role !== "system");
    if (firstNonSystem < 0 || firstNonSystem >= result.length - KEEP_RECENT_MESSAGES) break;
    compressedChars -= contentToText(result[firstNonSystem].content).length;
    result.splice(firstNonSystem, 1);
  }
  return result;
}
