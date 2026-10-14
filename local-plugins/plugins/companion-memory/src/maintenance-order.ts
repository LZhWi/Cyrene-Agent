/** Serialize complete compression/reflection cycles, including application of changes. */
export function createMaintenanceOrder() {
  let tail = Promise.resolve();
  return async (signal: AbortSignal): Promise<() => void> => {
    if (signal.aborted) throw new Error("后台维护已取消");
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("后台维护已取消"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([previous, cancelled]);
      if (signal.aborted) throw new Error("后台维护已取消");
      return release;
    } catch (error) {
      // Cancelling a waiter must not let its successor bypass the active cycle.
      void previous.then(release);
      throw error;
    } finally { signal.removeEventListener("abort", onAbort); }
  };
}
