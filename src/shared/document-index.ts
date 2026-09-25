export type DocumentIndexJobStatus =
  | "queued"
  | "reading"
  | "chunking"
  | "embedding"
  | "cached"
  | "done"
  | "failed"
  | "cancelled";

export type DocumentIndexProgress = {
  jobId: string;
  filePath: string;
  fileName: string;
  status: DocumentIndexJobStatus;
  completedChunks?: number;
  totalChunks?: number;
  reason?: string;
};
