import { app } from "electron";

export interface MusicBootstrapForLatch {
  isShuttingDown(): boolean;
  shutdown(): Promise<unknown>;
}

export function installShutdownLatch(
  bootstrap: MusicBootstrapForLatch,
  timeoutMs = 5000,
  shutdownDependents: () => Promise<unknown> = async () => undefined,
): void {
  let triggered = false;
  app.on("before-quit", (event) => {
    if (triggered) return;
    if (bootstrap.isShuttingDown()) return;
    triggered = true;
    event.preventDefault();
    const t = setTimeout(() => {
      console.error(`[Cyrene] music shutdown timeout after ${timeoutMs}ms, forcing exit`);
      app.quit();
    }, timeoutMs);
    void Promise.allSettled([bootstrap.shutdown(), shutdownDependents()]).finally(() => {
      clearTimeout(t);
      app.quit();
    });
  });
}
