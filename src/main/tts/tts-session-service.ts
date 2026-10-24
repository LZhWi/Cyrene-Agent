import type { StartTtsRequest, TtsSessionEvent, TtsStartResult } from "../../shared/tts-session";
import { waitForProducer } from "../application/wait-for-producer";

export interface TtsSessionExecution {
  result: TtsStartResult;
  completion: Promise<void>;
}

type SynthesizeTts = (
  request: StartTtsRequest,
  signal: AbortSignal,
  emit: (event: TtsSessionEvent) => void,
) => Promise<TtsStartResult | TtsSessionExecution>;

/** requestId 只负责会话隔离与取消；远端合成本身不承诺可暂停。 */
export class TtsSessionService {
  private readonly active = new Map<string, AbortController>();
  private readonly pending = new Set<Promise<void>>();
  private closing = false;

  constructor(private readonly synthesize: SynthesizeTts) {}

  async start(request: StartTtsRequest, onEvent: (event: TtsSessionEvent) => void = () => undefined): Promise<TtsStartResult> {
    if (this.closing) return { requestId: request.requestId, status: "cancelled" };
    let settled!: () => void;
    const completion = new Promise<void>((resolve) => { settled = resolve; });
    this.pending.add(completion);
    const finish = () => { this.pending.delete(completion); settled(); };
    this.cancel(request.requestId);
    const controller = new AbortController();
    this.active.set(request.requestId, controller);
    let ownsAsyncCompletion = false;
    const emit = (event: TtsSessionEvent) => {
      if (
        !controller.signal.aborted
        && this.active.get(request.requestId) === controller
        && event.requestId === request.requestId
      ) onEvent(event);
    };
    try {
      const execution = await this.synthesize(request, controller.signal, emit);
      const result = "result" in execution ? execution.result : execution;
      if ("result" in execution) {
        ownsAsyncCompletion = true;
        void execution.completion.catch((error) => {
          emit({
            requestId: request.requestId,
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }).finally(() => {
          if (this.active.get(request.requestId) === controller) this.active.delete(request.requestId);
          finish();
        });
      }
      return controller.signal.aborted
        ? { requestId: request.requestId, status: "cancelled" }
        : result;
    } finally {
      if (!ownsAsyncCompletion && this.active.get(request.requestId) === controller) this.active.delete(request.requestId);
      if (!ownsAsyncCompletion) finish();
    }
  }

  shutdown(signal: AbortSignal): Promise<void> {
    this.closing = true;
    for (const id of this.active.keys()) this.cancel(id);
    return waitForProducer("tts", [...this.pending], signal);
  }

  cancel(requestId: string): boolean {
    const controller = this.active.get(requestId);
    if (!controller) return false;
    controller.abort();
    this.active.delete(requestId);
    return true;
  }
}
