import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexBridge, defaults } from "../plugins/codex-bridge/src/bridge";
import type { RpcClient } from "../plugins/codex-bridge/src/client";

function setup() {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "cyrene-codex-test-")));
  const data = new Map<string, any>();
  const storage = { get: <T>(key: string) => data.get(key) as T, set: (key: string, value: any) => data.set(key, structuredClone(value)), rootDir: () => cwd };
  const llm = { generateText: vi.fn(async () => "Cyrene 解读") };
  const bridge = new CodexBridge(storage, llm);
  const request = vi.fn(async (method: string, _params: any): Promise<any> => {
    switch (method) {
      case "account/read": return { account: { type: "chatgpt", planType: "pro" } };
      case "model/list": return { data: [{ model: "test-model", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] };
      case "skills/list": return { data: [{ cwd, skills: [{ name: "test-skill", path: path.join(cwd, "SKILL.md"), enabled: true }] }] };
      case "thread/start": case "thread/resume": return { thread: { id: "thread-1" } };
      case "turn/start": return { turn: { id: "turn-1" } };
      default: return {};
    }
  });
  const rpc: RpcClient = { request, respond: vi.fn(), reject: vi.fn(), close: vi.fn() };
  const config = { ...defaults, cwd, autoExplain: false };
  const submit = { message: "  用户原文\n不改写  ", model: "test-model", effort: "high", skillPath: path.join(cwd, "SKILL.md"), sandbox: "read-only" as const, autoExplain: false };
  const connect = () => bridge.connect(config, async () => rpc);
  const done = (turnId = "turn-1") => bridge.event({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status: "completed", items: [{ type: "agentMessage", phase: "final_answer", text: "完成回执" }] } } });
  const clean = () => { bridge.dispose(); rmSync(cwd, { recursive: true, force: true }); };
  return { bridge, storage, llm, rpc, request, submit, connect, done, clean, config };
}

describe("Codex task bridge", () => {
  it("does not overwrite completion delivered during an answer response", async () => {
    const t = setup(); try {
      await t.connect(); const id = await t.bridge.submit(t.submit);
      t.bridge.event({ id: 1, method: "item/tool/requestUserInput", params: { threadId: "thread-1", turnId: "turn-1", questions: [{ id: "q" }] } });
      t.rpc.respond = vi.fn(() => t.done());
      t.bridge.answer({ taskId: id, requestId: 1, answers: { q: "A" } });
      await Promise.resolve();
      expect(t.bridge.tasks[0].status).toBe("completed");
      expect(t.bridge.connection).toBe("idle");
    } finally { t.clean(); }
  });
  it.each(["completed", "failed", "interrupted"])("releases the server after %s while retaining the receipt", async status => {
    const t = setup(); try {
      await t.connect(); await t.bridge.submit(t.submit);
      let finish!: () => void;
      t.rpc.close = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
      t.bridge.event({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status, items: [{ type: "agentMessage", text: "saved" }] } } });
      expect(t.storage.get<any[]>("tasks")![0].finalText).toBe("saved");
      expect(t.rpc.close).toHaveBeenCalledTimes(1);
      expect(t.bridge.connection).toBe("releasing");
      finish(); await Promise.resolve();
      expect(t.bridge.connection).toBe("idle");
      expect(t.bridge.tasks[0].status).toBe(status);
    } finally { t.clean(); }
  });
  it("sends exact user text and selected skill without a Cyrene model call", async () => {
    const t = setup(); try {
      await t.connect(); await t.bridge.submit(t.submit);
      const call = t.request.mock.calls.find(([method]) => method === "turn/start")![1];
      expect(call.input).toEqual([{ type: "text", text: t.submit.message }, { type: "skill", name: "test-skill", path: t.submit.skillPath }]);
      expect(call).toMatchObject({ effort: "high", model: "test-model", sandboxPolicy: { type: "readOnly" }, approvalsReviewer: "user" });
      expect(t.llm.generateText).not.toHaveBeenCalled();
      t.done(); expect(t.bridge.tasks[0]).toMatchObject({ status: "completed", finalText: "完成回执" });
      await t.bridge.explain(t.bridge.tasks[0].id);
      expect(t.llm.generateText).toHaveBeenCalledTimes(1);
      expect(t.bridge.tasks[0].explanation).toBe("Cyrene 解读");
    } finally { t.clean(); }
  });
  it("rejects API key authentication before submitting any task", async () => {
    const t = setup(); try {
      t.request.mockResolvedValueOnce({ account: { type: "apiKey" } });
      await expect(t.connect()).rejects.toThrow("ChatGPT");
      expect(t.request.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
    } finally { t.clean(); }
  });
  it("rejects unsupported effort and refreshes a stale skill before execution", async () => {
    const t = setup(); try {
      await t.connect(); await expect(t.bridge.submit({ ...t.submit, effort: "invalid" })).rejects.toThrow("思考强度");
      t.request.mockResolvedValueOnce({ data: [{ cwd: t.config.cwd, skills: [] }] });
      await expect(t.bridge.submit(t.submit)).rejects.toThrow("技能已不可用");
      expect(t.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
    } finally { t.clean(); }
  });
  it("reserves the submission slot before asynchronous skill discovery", async () => {
    const t = setup(); try {
      await t.connect(); const first = t.bridge.submit(t.submit);
      await expect(t.bridge.submit(t.submit)).rejects.toThrow("当前任务"); await first;
      expect(t.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
    } finally { t.clean(); }
  });
  it("binds question answers to a live task and refuses expired cards", async () => {
    const t = setup(); try {
      await t.connect(); const id = await t.bridge.submit(t.submit);
      t.bridge.event({ id: 21, method: "item/tool/requestUserInput", params: { threadId: "thread-1", turnId: "turn-1", questions: [{ id: "q1", question: "选择什么？" }] } });
      expect(t.bridge.tasks[0].status).toBe("waiting");
      expect(() => t.bridge.answer({ taskId: "other", requestId: 21, answers: { q1: "A" } })).toThrow("失效");
      t.bridge.answer({ taskId: id, requestId: 21, answers: { q1: "A" } });
      expect(t.rpc.respond).toHaveBeenCalledWith(21, { answers: { q1: { answers: ["A"] } } });
      expect(() => t.bridge.answer({ taskId: id, requestId: 21, answers: { q1: "B" } })).toThrow("失效");
    } finally { t.clean(); }
  });
  it("does not auto approve, limits choices, and rejects unsupported permission grants", async () => {
    const t = setup(); try {
      await t.connect(); const id = await t.bridge.submit(t.submit);
      t.bridge.event({ id: 22, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", command: "test", availableDecisions: ["decline", "cancel"] } });
      expect(t.rpc.respond).not.toHaveBeenCalled();
      expect(() => t.bridge.answer({ taskId: id, requestId: 22, decision: "accept" })).toThrow("无效");
      t.bridge.answer({ taskId: id, requestId: 22, decision: "decline" });
      expect(t.rpc.respond).toHaveBeenCalledWith(22, { decision: "decline" });
      t.bridge.event({ id: 23, method: "item/permissions/requestApproval", params: { threadId: "thread-1", turnId: "turn-1" } });
      expect(t.rpc.respond).toHaveBeenCalledWith(23, { permissions: {}, scope: "turn" });
    } finally { t.clean(); }
  });
  it("clears resolved cards and ignores events from other threads", async () => {
    const t = setup(); try {
      await t.connect(); await t.bridge.submit(t.submit);
      t.bridge.event({ id: 22, method: "item/fileChange/requestApproval", params: { threadId: "thread-1", turnId: "turn-1" } });
      t.bridge.event({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 22 } });
      expect(t.bridge.prompts).toHaveLength(0);
      t.bridge.event({ method: "turn/completed", params: { threadId: "other", turn: { id: "x", status: "completed" } } });
      expect(t.bridge.tasks[0].status).toBe("inProgress");
    } finally { t.clean(); }
  });
  it("marks disconnected work unknown, permits reconnect and reconciliation without resubmit", async () => {
    const t = setup(); try {
      await t.connect(); const id = await t.bridge.submit(t.submit); t.bridge.disconnected("lost");
      expect(t.bridge.tasks[0].status).toBe("unknown"); await t.connect();
      await expect(t.bridge.submit(t.submit)).rejects.toThrow("未知状态");
      t.request.mockResolvedValueOnce({ thread: { turns: [{ id: "turn-1", status: "completed", items: [{ type: "agentMessage", text: "恢复回执" }] }] } });
      await t.bridge.sync(id); expect(t.bridge.tasks[0].finalText).toBe("恢复回执");
      expect(t.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
    } finally { t.clean(); }
  });
  it("continues the existing thread and retains receipts when explanation fails", async () => {
    const t = setup(); try {
      await t.connect(); const id = await t.bridge.submit(t.submit); t.done();
      t.llm.generateText.mockRejectedValueOnce(new Error("model failed"));
      await expect(t.bridge.explain(id)).rejects.toThrow("model failed");
      expect(t.bridge.tasks[0].finalText).toBe("完成回执");
      await t.bridge.submit({ ...t.submit, continueId: id });
      expect(t.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(1);
      expect(t.request.mock.calls.find(([method]) => method === "thread/resume")?.[1].threadId).toBe("thread-1");
    } finally { t.clean(); }
  });
  it("saves uncertain termination on dispose instead of pretending cancellation succeeded", async () => {
    const t = setup(); try {
      await t.connect(); await t.bridge.submit(t.submit); t.bridge.dispose();
      const restored = new CodexBridge(t.storage, t.llm);
      expect(restored.tasks[0].status).toBe("unknown"); expect(t.rpc.close).toHaveBeenCalled();
    } finally { t.clean(); }
  });
  it("ignores an old turn completion while continuing the same thread", async () => {
    const t = setup(); try {
      await t.connect(); const id = await t.bridge.submit(t.submit); t.done();
      const original = t.request.getMockImplementation()!;
      t.request.mockImplementation(async (method, params) => method === "turn/start" ? { turn: { id: "turn-2" } } : original(method, params));
      await t.bridge.submit({ ...t.submit, continueId: id }); t.done("turn-1");
      expect(t.bridge.tasks[0].status).toBe("inProgress"); t.done("turn-2");
      expect(t.bridge.tasks[0].status).toBe("completed");
    } finally { t.clean(); }
  });
  it("does not invoke the summary model twice for duplicate terminal events", async () => {
    const t = setup(); try {
      await t.connect(); await t.bridge.submit({ ...t.submit, autoExplain: true });
      t.done(); await Promise.resolve(); t.done();
      expect(t.llm.generateText).toHaveBeenCalledTimes(1);
    } finally { t.clean(); }
  });
  it("performs no storage writes after the host has aborted plugin cleanup", async () => {
    const t = setup(); try {
      await t.connect(); await t.bridge.submit(t.submit);
      const set = vi.spyOn(t.storage, "set").mockImplementation(() => { throw new Error("host already aborted"); });
      expect(() => t.bridge.dispose()).not.toThrow(); expect(set).not.toHaveBeenCalled();
      set.mockRestore();
    } finally { t.clean(); }
  });
  it("waits for server confirmation before marking cancellation complete", async () => {
    const t = setup(); try {
      await t.connect(); const id = await t.bridge.submit(t.submit);
      await t.bridge.cancel(id); expect(t.bridge.tasks[0].status).toBe("cancelling");
      expect(t.request.mock.calls.find(([method]) => method === "turn/interrupt")?.[1]).toEqual({ threadId: "thread-1", turnId: "turn-1" });
      t.bridge.event({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", items: [] } } });
      expect(t.bridge.tasks[0].status).toBe("interrupted");
    } finally { t.clean(); }
  });
});
