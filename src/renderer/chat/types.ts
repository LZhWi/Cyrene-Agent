export type DocumentIndexCardStatus =
  | "pending"
  | "queued"
  | "reading"
  | "chunking"
  | "embedding"
  | "cached"
  | "done"
  | "failed"
  | "error"
  | "cancelled";

export type DocumentIndexProgress = {
  jobId: string;
  filePath: string;
  fileName: string;
  status: Exclude<DocumentIndexCardStatus, "pending" | "error">;
  completedChunks?: number;
  totalChunks?: number;
  reason?: string;
};

const labelByStatus: Record<DocumentIndexCardStatus, string> = {
  pending: "待处理",
  queued: "等待处理",
  reading: "正在读取",
  chunking: "正在切分",
  embedding: "正在分析",
  cached: "已从缓存读取",
  done: "已处理",
  failed: "处理失败",
  error: "处理失败",
  cancelled: "已取消",
};

export function getDocumentIndexStatusLabel(status: DocumentIndexCardStatus): string {
  return labelByStatus[status];
}

export function canCancelDocumentIndexStatus(status: DocumentIndexCardStatus): boolean {
  return status === "queued" || status === "reading" || status === "chunking" || status === "embedding";
}
