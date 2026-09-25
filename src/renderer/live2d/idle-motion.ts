import type { Live2DModel, MotionPriority } from "pixi-live2d-display/cubism4";

const DEFAULT_IDLE_GROUP = "Tick3";
const IDLE_MOTION_PRIORITY = 1 as MotionPriority;
const NORMAL_MOTION_PRIORITY = 2 as MotionPriority;
const DEFAULT_RESET_GROUP = "动作#6";
const INTERACTIVE_MOTION_INDICES = [0, 1, 2] as const;

interface LoadedMotionTiming {
  _motionData?: { duration?: number };
}

export interface IdleMotionOptions {
  idleGroup?: string;
  minIntervalMs?: number;
  maxIntervalMs?: number;
  initialMinIntervalMs?: number;
  minMotionMs?: number;
  maxMotionMs?: number;
  resetMotionGroup?: string;
  resetMotionIndex?: number;
  resetMotionMs?: number;
  random?: () => number;
  onMotionEnd?: () => void;
}

/** 在用户持续空闲时播放有界待机动作，并在结束后短暂回正。 */
export class IdleMotionController {
  private readonly motionManager: Live2DModel["internalModel"]["motionManager"];
  private readonly idleGroup: string;
  private readonly minIntervalMs: number;
  private readonly maxIntervalMs: number;
  private readonly initialMinIntervalMs: number;
  private readonly minMotionMs: number;
  private readonly maxMotionMs: number;
  private readonly resetMotionGroup: string;
  private readonly resetMotionIndex: number;
  private readonly resetMotionMs: number;
  private readonly random: () => number;
  private readonly onMotionEnd?: () => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;
  private enabled = false;
  private userIdle = false;
  private screenNoChangeCount: number | null = null;
  private firstIdleMotionPending = true;
  private suspended = false;
  private disposed = false;
  private generation = 0;

  constructor(model: Live2DModel, options: IdleMotionOptions = {}) {
    this.motionManager = model.internalModel.motionManager;
    this.idleGroup = options.idleGroup ?? DEFAULT_IDLE_GROUP;
    this.minIntervalMs = options.minIntervalMs ?? 30_000;
    this.maxIntervalMs = options.maxIntervalMs ?? 120_000;
    this.initialMinIntervalMs = options.initialMinIntervalMs ?? 60_000;
    this.minMotionMs = options.minMotionMs ?? 3_000;
    this.maxMotionMs = options.maxMotionMs ?? 20_000;
    this.resetMotionGroup = options.resetMotionGroup ?? DEFAULT_RESET_GROUP;
    this.resetMotionIndex = options.resetMotionIndex ?? 0;
    this.resetMotionMs = options.resetMotionMs ?? 600;
    this.random = options.random ?? Math.random;
    this.onMotionEnd = options.onMotionEnd;
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return;
    this.enabled = enabled;
    this.firstIdleMotionPending = true;
    if (enabled && !this.suspended && !this.isOwnedMotionPlaying()) this.scheduleNext(true);
    else if (!enabled) this.deactivate();
  }

  setUserIdle(userIdle: boolean): void {
    if (this.disposed || this.userIdle === userIdle) return;
    this.userIdle = userIdle;
    if (userIdle) {
      if (this.enabled && !this.suspended && !this.isOwnedMotionPlaying()) this.scheduleNext(true);
      return;
    }
    this.firstIdleMotionPending = true;
    if (!this.isOwnedMotionPlaying()) this.cancelTimer();
  }

  setScreenNoChangeCount(count: number | null): void {
    this.screenNoChangeCount = Number.isFinite(count) ? Math.max(0, Math.min(5, Math.floor(count as number))) : null;
  }

  setSuspended(suspended: boolean): void {
    if (this.disposed || this.suspended === suspended) return;
    this.suspended = suspended;
    this.firstIdleMotionPending = true;
    if (!suspended && this.enabled && !this.isOwnedMotionPlaying()) this.scheduleNext(true);
    else if (suspended) this.deactivate();
  }

  restartWait(): void {
    if (this.disposed) return;
    this.firstIdleMotionPending = true;
    this.deactivate();
    if (this.isActive()) this.scheduleNext(true);
  }

  async playRandomNow(): Promise<boolean> {
    if (this.disposed || this.suspended) return false;
    this.cancelTimer();
    this.interruptReset();
    const generation = this.generation;
    const index = this.pickMotionIndex(INTERACTIVE_MOTION_INDICES);
    if (index < 0) {
      if (this.isActive()) this.scheduleNext(this.firstIdleMotionPending);
      return false;
    }
    try {
      const started = await this.motionManager.startMotion(this.idleGroup, index, NORMAL_MOTION_PRIORITY);
      if (!started || this.disposed || this.suspended || generation !== this.generation) {
        if (this.isActive()) this.scheduleNext(this.firstIdleMotionPending);
        return false;
      }
      this.scheduleMotionEnd(index);
      return true;
    } catch (error) {
      console.warn("[Cyrene] interactive motion failed", error);
      if (this.isActive()) this.scheduleNext(this.firstIdleMotionPending);
      return false;
    }
  }

  interruptReset(): void {
    this.cancelResetTimer();
    const state = this.motionManager.state;
    if (state.currentGroup === this.resetMotionGroup && state.currentIndex === this.resetMotionIndex) {
      this.motionManager.stopAllMotions();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.enabled = false;
    this.suspended = true;
    this.cancelTimer();
    this.cancelResetTimer();
    this.disposed = true;
  }

  private isActive(): boolean {
    return this.enabled && this.userIdle && !this.suspended && !this.disposed;
  }

  private isOwnedMotionPlaying(): boolean {
    const state = this.motionManager.state;
    return state.currentGroup === this.idleGroup
      || state.reservedGroup === this.idleGroup
      || state.reservedIdleGroup === this.idleGroup;
  }

  private deactivate(): void {
    this.cancelTimer();
    this.stopOwnedMotion();
  }

  private scheduleNext(initial = false): void {
    this.cancelTimer();
    if (!this.isActive()) return;
    const n = this.screenNoChangeCount ?? 0;
    const adaptiveMin = n > 0 ? (20 + 20 * n) * 1000 : this.minIntervalMs;
    const adaptiveMax = n > 0 ? (120 + 20 * n) * 1000 : this.maxIntervalMs;
    const minDelay = initial ? Math.max(adaptiveMin, this.initialMinIntervalMs) : adaptiveMin;
    const delay = this.randomBetween(minDelay, Math.max(minDelay, adaptiveMax));
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.playNext(generation);
    }, delay);
  }

  private async playNext(generation: number): Promise<void> {
    if (!this.isActive() || generation !== this.generation) return;
    const index = this.pickMotionIndex();
    if (index < 0) {
      this.scheduleNext(this.firstIdleMotionPending);
      return;
    }
    try {
      const started = await this.motionManager.startMotion(this.idleGroup, index, IDLE_MOTION_PRIORITY);
      if (!started) {
        this.scheduleNext(this.firstIdleMotionPending);
        return;
      }
      if (!this.isActive() || generation !== this.generation) {
        this.stopOwnedMotion();
        return;
      }
      this.firstIdleMotionPending = false;
      this.scheduleMotionEnd(index);
    } catch (error) {
      console.warn("[Cyrene] idle motion failed", error);
      this.scheduleNext(this.firstIdleMotionPending);
    }
  }

  private scheduleMotionEnd(index: number): void {
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (generation !== this.generation) return;
      this.stopOwnedMotion();
      this.scheduleNext(this.firstIdleMotionPending);
    }, this.getMotionDurationMs(index));
  }

  private pickMotionIndex(candidates?: readonly number[]): number {
    const count = this.motionManager.definitions[this.idleGroup]?.length ?? 0;
    if (count === 0) return -1;
    const available = candidates?.filter((index) => index >= 0 && index < count);
    if (available?.length) return available[Math.min(available.length - 1, Math.floor(this.random() * available.length))];
    return Math.min(count - 1, Math.floor(this.random() * count));
  }

  private getMotionDurationMs(index: number): number {
    const motion = this.motionManager.motionGroups[this.idleGroup]?.[index] as LoadedMotionTiming | undefined;
    const naturalMs = Number(motion?._motionData?.duration ?? 0) * 1000;
    if (!Number.isFinite(naturalMs) || naturalMs <= 0) return this.minMotionMs;
    return Math.max(this.minMotionMs, Math.min(this.maxMotionMs, naturalMs));
  }

  private stopOwnedMotion(): boolean {
    if (!this.isOwnedMotionPlaying()) return false;
    this.motionManager.stopAllMotions();
    this.onMotionEnd?.();
    void this.playResetMotion();
    return true;
  }

  private async playResetMotion(): Promise<void> {
    try {
      const started = await this.motionManager.startMotion(this.resetMotionGroup, this.resetMotionIndex, NORMAL_MOTION_PRIORITY);
      if (!started || this.disposed) return;
      this.cancelResetTimer();
      this.resetTimer = setTimeout(() => {
        this.resetTimer = null;
        const state = this.motionManager.state;
        if (state.currentGroup === this.resetMotionGroup && state.currentIndex === this.resetMotionIndex) {
          this.motionManager.stopAllMotions();
        }
      }, this.resetMotionMs);
    } catch (error) {
      console.warn("[Cyrene] idle reset motion failed", error);
    }
  }

  private cancelTimer(): void {
    this.generation += 1;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private cancelResetTimer(): void {
    if (this.resetTimer !== null) clearTimeout(this.resetTimer);
    this.resetTimer = null;
  }

  private randomBetween(min: number, max: number): number {
    return Math.round(min + this.random() * Math.max(0, max - min));
  }
}
