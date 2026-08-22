export type ModelRuntimeClass =
  | "interactive"
  | "call"
  | "channel"
  | "scheduler"
  | "vision-interactive"
  | "vision-background";

interface PendingLease {
  id: number;
  runtimeClass: ModelRuntimeClass;
  signal?: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
}

const PRIORITY: Record<ModelRuntimeClass, number> = {
  call: 0,
  interactive: 0,
  channel: 1,
  "vision-interactive": 1,
  scheduler: 2,
  "vision-background": 3,
};

function isBackground(runtimeClass: ModelRuntimeClass): boolean {
  return runtimeClass === "scheduler" || runtimeClass === "vision-background";
}

export function modelRuntimeClassForAgentDescription(description: string): ModelRuntimeClass {
  if (description.startsWith("Scheduled task:")) return "scheduler";
  if (description.startsWith("bot:") || description.startsWith("mobile")) return "channel";
  return "interactive";
}

export class ModelRuntimeCoordinator {
  private readonly queue: PendingLease[] = [];
  private sequence = 0;
  private activeTotal = 0;
  private activeBackground = 0;

  constructor(
    private readonly maxConcurrent = 2,
    private readonly maxBackgroundConcurrent = 1,
  ) {}

  acquire(runtimeClass: ModelRuntimeClass, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new DOMException("模型任务已取消", "AbortError"));
    return new Promise<() => void>((resolve, reject) => {
      const pending: PendingLease = {
        id: this.sequence++,
        runtimeClass,
        signal,
        resolve,
        reject,
      };
      pending.onAbort = () => {
        const index = this.queue.indexOf(pending);
        if (index < 0) return;
        this.queue.splice(index, 1);
        reject(new DOMException("模型任务已取消", "AbortError"));
      };
      signal?.addEventListener("abort", pending.onAbort, { once: true });
      this.queue.push(pending);
      this.dispatch();
    });
  }

  async run<T>(runtimeClass: ModelRuntimeClass, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(runtimeClass, signal);
    try {
      if (signal?.aborted) throw new DOMException("模型任务已取消", "AbortError");
      return await task();
    } finally {
      release();
    }
  }

  private dispatch(): void {
    while (this.activeTotal < this.maxConcurrent) {
      const nextIndex = this.nextEligibleIndex();
      if (nextIndex < 0) return;
      const [pending] = this.queue.splice(nextIndex, 1);
      pending.signal?.removeEventListener("abort", pending.onAbort!);
      if (pending.signal?.aborted) {
        pending.reject(new DOMException("模型任务已取消", "AbortError"));
        continue;
      }

      const background = isBackground(pending.runtimeClass);
      this.activeTotal += 1;
      if (background) this.activeBackground += 1;
      let released = false;
      pending.resolve(() => {
        if (released) return;
        released = true;
        this.activeTotal -= 1;
        if (background) this.activeBackground -= 1;
        this.dispatch();
      });
    }
  }

  private nextEligibleIndex(): number {
    let bestIndex = -1;
    for (let index = 0; index < this.queue.length; index++) {
      const pending = this.queue[index];
      if (isBackground(pending.runtimeClass) && this.activeBackground >= this.maxBackgroundConcurrent) continue;
      if (bestIndex < 0) {
        bestIndex = index;
        continue;
      }
      const best = this.queue[bestIndex];
      if (PRIORITY[pending.runtimeClass] < PRIORITY[best.runtimeClass]
        || (PRIORITY[pending.runtimeClass] === PRIORITY[best.runtimeClass] && pending.id < best.id)) {
        bestIndex = index;
      }
    }
    return bestIndex;
  }
}

export const modelRuntimeCoordinator = new ModelRuntimeCoordinator();
