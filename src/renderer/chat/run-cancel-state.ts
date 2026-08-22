export interface ChatRunSnapshot {
  runId: string;
  cancelRequested: boolean;
}

export class ChatRunState {
  private current: ChatRunSnapshot | null = null;

  begin(runId: string): void {
    if (this.current) throw new Error(`E_CHAT_RUN_ACTIVE: ${this.current.runId}`);
    this.current = { runId, cancelRequested: false };
  }

  requestCancel(): string | null {
    if (!this.current || this.current.cancelRequested) return null;
    this.current.cancelRequested = true;
    return this.current.runId;
  }

  isCancellationRequested(runId: string): boolean {
    return this.current?.runId === runId && this.current.cancelRequested;
  }

  finish(runId: string): void {
    if (this.current?.runId === runId) this.current = null;
  }

  snapshot(): ChatRunSnapshot | null {
    return this.current ? { ...this.current } : null;
  }
}
