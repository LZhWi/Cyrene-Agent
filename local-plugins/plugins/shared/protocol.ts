import { randomUUID } from "node:crypto";
import type { PluginContext } from "@playa0v0/cyrene-plugin-sdk";

export const CHAT_ID = "companion-chat";
export const MEMORY_ID = "companion-memory";
interface Request { v: 1; id: string; from: string; method: string; data: unknown }
interface Reply { v: 1; id: string; to: string; ok: boolean; data?: unknown; error?: string }

/** 事件只负责快速投递。耗时任务独立执行，再发响应，避免占用宿主的 5 秒监听窗口。 */
export function createPeer(ctx: PluginContext, other: string,
  handle: (method: string, data: unknown, signal: AbortSignal) => Promise<unknown>) {
  const pending = new Map<string, { resolve: (data: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; cleanup: () => void }>();
  const inflight = new Map<string, AbortController>();
  let stopped = false;
  const offRequest = ctx.events.on<Request>(`plugin:${other}:request`, (r) => {
    if (stopped || !r || r.v !== 1 || r.from !== other || typeof r.id !== "string" || typeof r.method !== "string" || inflight.has(r.id)) return;
    const control = new AbortController(); inflight.set(r.id, control);
    void Promise.resolve().then(() => {
      if (stopped || control.signal.aborted) throw new Error("请求已取消");
      return handle(r.method, r.data, AbortSignal.any([ctx.signal, control.signal]));
    }).then(
      (data) => ({ v: 1, id: r.id, to: other, ok: true, data } as Reply),
      () => ({ v: 1, id: r.id, to: other, ok: false, error: "对方插件处理失败，请查看插件状态后重试" } as Reply),
    ).then(async (reply) => { if (!stopped) await ctx.events.emit("reply", reply); })
      .catch(() => undefined).finally(() => inflight.delete(r.id));
  });
  const offCancel = ctx.events.on<{ v: number; id: string; from: string }>(`plugin:${other}:cancel`, (r) => {
    if (r?.v === 1 && r.from === other) inflight.get(r.id)?.abort();
  });
  const offReply = ctx.events.on<Reply>(`plugin:${other}:reply`, (r) => {
    if (!r || r.v !== 1 || r.to !== ctx.id) return;
    const p = pending.get(r.id);
    if (!p) return;
    pending.delete(r.id); clearTimeout(p.timer); p.cleanup();
    if (r.ok) p.resolve(r.data); else p.reject(new Error(r.error || "插件请求失败"));
  });
  function stop() {
    if (stopped) return;
    stopped = true; offRequest(); offReply(); offCancel();
    for (const control of inflight.values()) control.abort();
    for (const p of pending.values()) { clearTimeout(p.timer); p.cleanup(); p.reject(new Error("插件已停止")); }
    pending.clear();
  }
  ctx.onDispose(stop);
  return {
    stop,
    request<T>(method: string, data: unknown, signal?: AbortSignal, timeoutMs = 5000): Promise<T> {
      if (stopped || ctx.signal.aborted || signal?.aborted) return Promise.reject(new Error("请求已取消"));
      return new Promise<T>((resolve, reject) => {
        const id = randomUUID();
        const cancelRemote = () => { void ctx.events.emit("cancel", { v: 1, id, from: ctx.id }).catch(() => undefined); };
        const cancel = () => {
          const p = pending.get(id);
          if (!p) return;
          pending.delete(id); clearTimeout(p.timer); p.cleanup(); reject(new Error("请求已取消"));
          cancelRemote();
        };
        const timer = setTimeout(() => {
          pending.delete(id); signal?.removeEventListener("abort", cancel);
          cancelRemote();
          reject(new Error("插件未就绪或请求超时，请确认两个插件均已启用"));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, cleanup: () => signal?.removeEventListener("abort", cancel) });
        signal?.addEventListener("abort", cancel, { once: true });
        void ctx.events.emit("request", { v: 1, id, from: ctx.id, method, data } satisfies Request).catch(cancel);
      });
    },
  };
}
