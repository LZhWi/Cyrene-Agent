export const DOCUMENT_WAIT_MESSAGE = "这份文档有点大呢，我正在仔细读里面的内容……稍等我一下，等我看完重点再认真回答你～";

export interface RetrievedDocumentChunk {
  text: string;
  score: number;
  fileName?: string;
  chunkIndex?: number;
  importId?: string;
}

export type ProcessedDocument =
  | { kind: "text"; name: string; text: string }
  | { kind: "indexed"; name: string; chunks: number; importId?: string; reason?: string; retrievedChunks?: RetrievedDocumentChunk[] }
  | { kind: "empty"; name: string; reason?: string }
  | { kind: "unsupported" | "error"; name: string; reason?: string }
  | { kind: "image" | "document"; name: string };

export async function processDocumentsWithWait<T>(params: {
  processDocuments: (filePaths: string[], query: string) => Promise<T[]>;
  filePaths: string[];
  query: string;
  onWaitStart: (message: string) => void;
  onWaitEnd: () => void;
  waitMs?: number;
}): Promise<T[]> {
  let shown = false;
  const timer = setTimeout(() => {
    shown = true;
    params.onWaitStart(DOCUMENT_WAIT_MESSAGE);
  }, params.waitMs ?? 3500);

  try {
    return await params.processDocuments(params.filePaths, params.query);
  } finally {
    clearTimeout(timer);
    if (shown) params.onWaitEnd();
  }
}

function formatRetrievedChunks(chunks: RetrievedDocumentChunk[]): string {
  return chunks.map((chunk) => {
    const label = chunk.fileName
      ? `${chunk.fileName}${typeof chunk.chunkIndex === "number" ? ` #${chunk.chunkIndex + 1}` : ""}`
      : "文档片段";
    return `- ${label}: ${chunk.text}`;
  }).join("\n");
}

export function buildDocumentContextLines(results: ProcessedDocument[]): string[] {
  const lines: string[] = [];
  for (const result of results) {
    if (result.kind === "indexed" && !result.reason) {
      lines.push(`文档 ${result.name} 已建立索引，共 ${result.chunks} 段。`);
      if (result.retrievedChunks?.length) {
        lines.push(`以下是与本轮问题相关的文档片段：\n${formatRetrievedChunks(result.retrievedChunks)}`);
      }
      continue;
    }

    if (result.kind === "unsupported" || result.kind === "empty" || result.kind === "error" || result.kind === "indexed") {
      const reason = result.reason || (result.kind === "empty" ? "文档为空" : "暂不支持或无法读取");
      lines.push(`用户发送了文档 ${result.name}，但文档处理失败：${reason}。请诚实说明暂时无法分析该文档，不要编造文档内容。`);
    }
  }
  return lines;
}
