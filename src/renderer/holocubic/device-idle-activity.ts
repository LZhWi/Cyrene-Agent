const DEFAULT_QUIET_THRESHOLD_MS = 1_000;

/** Converts device input events into the same active/idle boundary used by the desktop pet. */
export class DeviceIdleActivityController {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private idle: boolean | null = null;

  constructor(
    private readonly onIdleChanged: (idle: boolean) => void,
    private readonly quietThresholdMs = DEFAULT_QUIET_THRESHOLD_MS,
  ) {}

  start(): void {
    if (this.disposed) return;
    this.setIdle(true);
  }

  recordInput(): void {
    if (this.disposed) return;
    this.setIdle(false);
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.setIdle(true);
    }, this.quietThresholdMs);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
  }

  private setIdle(idle: boolean): void {
    if (this.idle === idle) return;
    this.idle = idle;
    this.onIdleChanged(idle);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
