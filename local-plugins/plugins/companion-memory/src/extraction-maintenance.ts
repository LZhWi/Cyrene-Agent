import type { IsolatedExtractionBatch, IsolatedExtractionReceipt } from "./memory";

/** Reuses a saved extraction without accepting the batch before post-processing commits. */
export async function resumeIsolatedExtraction(input: {
  batch: IsolatedExtractionBatch;
  signal: AbortSignal;
  receipt(): IsolatedExtractionReceipt | undefined;
  processed(): string[];
  extract(): Promise<{ batches: number; pending: number }>;
  validate(): Promise<void>;
  refresh(receipt: IsolatedExtractionReceipt): Promise<void>;
  finish(receipt: IsolatedExtractionReceipt): Promise<number>;
}) {
  const check = () => { if (input.signal.aborted) throw new Error("提取已取消"); };
  check();
  let receipt = input.receipt();
  const processed = new Set(input.processed()), count = input.batch.pending.filter(turn => processed.has(turn.id)).length;
  if (count !== 0 && count !== input.batch.pending.length) throw new Error("SQLITE_PARTIAL_BATCH_RECEIPT");
  if (count && !receipt) throw new Error("SQLITE_EXTRACTION_RECEIPT_MISSING");
  const result = receipt ? { batches: 0, pending: 0 } : await input.extract();
  receipt = input.receipt();
  if (!receipt || input.batch.pending.some(turn => !input.processed().includes(turn.id))) throw new Error("SQLITE_EXTRACTION_RECEIPT_MISSING");
  check();
  await input.validate();
  check();
  if (receipt.completed) return { ...result, conflicts: 0 };
  await input.refresh(receipt);
  check();
  const conflicts = await input.finish(receipt);
  if (!input.receipt()?.completed) throw new Error("SQLITE_POST_EXTRACTION_NOT_COMMITTED");
  return { ...result, conflicts };
}
