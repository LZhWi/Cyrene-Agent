/** Tracks index work without changing its inputs, scheduling or ranking. */
const pending = new Map<Promise<unknown>, string>();
let closing = false;

export function isBackgroundIndexClosing(): boolean { return closing; }

export function trackBackgroundIndex<T>(label: string, work: () => Promise<T>): Promise<T> {
  if (closing) return Promise.reject(new Error("APPLICATION_STOPPING"));
  const task = work();
  pending.set(task, label);
  void task.then(() => pending.delete(task), () => pending.delete(task));
  return task;
}

export async function drainBackgroundIndexes(signal: AbortSignal): Promise<void> {
  closing = true;
  let onAbort!: () => void;
  const expired = new Promise<void>((resolve) => {
    onAbort = () => {
      if (pending.size) console.warn("[Shutdown] unfinished background indexes", [...pending.values()]);
      resolve();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try { await Promise.race([Promise.allSettled([...pending.keys()]), expired]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
