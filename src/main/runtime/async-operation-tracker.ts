export class AsyncOperationTracker {
  private readonly active = new Set<Promise<unknown>>();

  track<T>(operation: Promise<T>): Promise<T> {
    this.active.add(operation);
    void operation.finally(() => this.active.delete(operation)).catch(() => undefined);
    return operation;
  }

  async settleAll(): Promise<void> {
    await Promise.allSettled(Array.from(this.active));
  }

  get size(): number {
    return this.active.size;
  }
}
