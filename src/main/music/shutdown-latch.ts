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
  let state: "idle" | "cleaning" | "ready" = "idle";
  app.on("before-quit", (event) => {
    if (state === "ready") return;
    event.preventDefault();
    if (state === "cleaning") return;
    state = "cleaning";
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      state = "ready";
      app.quit();
    };
    const t = setTimeout(() => {
      console.error(`[Cyrene] music shutdown timeout after ${timeoutMs}ms, forcing exit`);
      finish();
    }, timeoutMs);
    void Promise.allSettled([bootstrap.shutdown(), shutdownDependents()]).finally(() => {
      clearTimeout(t);
      finish();
    });
  });
}
