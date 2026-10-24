/** Admission must be closed before taking the pending-work snapshot. */
export async function waitForProducer(label: string, pending: Promise<unknown>[], signal: AbortSignal): Promise<void> {
  if (!pending.length) return;
  let abort!: () => void;
  const deadline = new Promise<void>((resolve) => { abort = resolve; });
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    await Promise.race([Promise.allSettled(pending), deadline]);
    if (signal.aborted) console.warn(`[Shutdown] ${label} drain deadline reached`);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
