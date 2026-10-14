import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeCodeExecutor } from "../plugins/codex-bridge/src/native";
import type { CodexBridge } from "../plugins/codex-bridge/src/bridge";

it("isolates native conversations, transmits raw input and reconnects the correct thread", async () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "native-code-")));
  const stored = new Map<string, any>();
  const storage = { rootDir: () => cwd, get: <T>(key: string) => stored.get(key) as T, set: (key: string, value: any) => stored.set(key, structuredClone(value)) };
  const bridges: CodexBridge[] = [];
  const calls: any[] = [];
  let sequence = 0;
  const close = vi.fn();
  const factory = async (bridge: CodexBridge) => {
    bridges.push(bridge);
    return { close, respond: vi.fn(), reject: vi.fn(), request: async (method: string, params: any): Promise<any> => {
      calls.push({ method, params });
      if (method === "account/read") return { account: { type: "chatgpt" } };
      if (method === "model/list") return { data: [{ model: "test", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }] };
      if (method === "skills/list") return { data: [{ cwd, skills: [] }] };
      if (method === "thread/start") return { thread: { id: `thread-${++sequence}` } };
      if (method === "thread/resume") return { thread: { id: params.threadId } };
      if (method === "turn/start") return { turn: { id: `turn-${++sequence}` } };
      return {};
    } };
  };
  const native = new NativeCodeExecutor(storage, undefined, factory);
  const input = { message: "  原文\n保持空格  ", model: "test", effort: "low", skillPath: "", sandbox: "read-only", autoExplain: false };
  try {
    await native.invoke("connect", { sessionId: "a", cwd });
    const a = await native.invoke("submit", { sessionId: "a", cwd, input });
    expect(calls.find(call => call.method === "turn/start").params.input).toEqual([{ type: "text", text: input.message }]);
    expect((await native.invoke("state", { sessionId: "b", cwd })).tasks).toHaveLength(0);
    await expect(native.invoke("answer", { sessionId: "b", cwd, input: { taskId: a.tasks[0].id, requestId: 1 } })).rejects.toThrow("失效");
    bridges[0].event({ method: "turn/completed", params: { threadId: a.tasks[0].threadId, turn: { id: a.tasks[0].turnId, status: "completed", items: [{ type: "agentMessage", text: "receipt" }] } } });
    await Promise.resolve(); expect(close).toHaveBeenCalledTimes(1);
    await native.invoke("submit", { sessionId: "a", cwd, input });
    expect(calls.find(call => call.method === "thread/resume").params.threadId).toBe(a.tasks[0].threadId);
    const restored = new NativeCodeExecutor(storage, undefined, factory);
    const state = await restored.invoke("state", { sessionId: "a", cwd });
    expect(state.tasks[0].status).toBe("unknown"); expect(state.tasks[1].finalText).toBe("receipt");
    restored.dispose();
  } finally { native.dispose(); rmSync(cwd, { recursive: true, force: true }); }
});
