export interface KeyedQueue {
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
}

export interface CreateKeyedQueueOptions {
  maxPendingPerKey?: number;
}

interface QueueState {
  tail: Promise<void>;
  pending: number;
}

class PromiseKeyedQueue implements KeyedQueue {
  private readonly states = new Map<string, QueueState>();

  constructor(private readonly maxPendingPerKey: number) {}

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    let state = this.states.get(key);
    if (!state) {
      state = { tail: Promise.resolve(), pending: 0 };
      this.states.set(key, state);
    }

    if (state.pending >= this.maxPendingPerKey) {
      return Promise.reject(new Error(`queue_full:${key}`));
    }

    state.pending += 1;
    const scheduled = state.tail.then(task);
    const result = scheduled.finally(() => {
      state.pending -= 1;
      if (state.pending === 0 && this.states.get(key) === state) {
        this.states.delete(key);
      }
    });

    // 尾链吞掉任务错误，避免一个失败任务阻断同键的后续任务。
    state.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function createKeyedQueue(
  options: CreateKeyedQueueOptions = {},
): KeyedQueue {
  return new PromiseKeyedQueue(options.maxPendingPerKey ?? 20);
}
