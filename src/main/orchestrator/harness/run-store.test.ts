import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessRunStore } from "./run-store";
import type { AgentState } from "./types";
import type { ChatMessage } from "../vendors/types";
const backend=vi.hoisted(()=>({current:null as any}));
vi.mock('../../storage/storage-backend',()=>({requireStorageRuntime:()=>{if(!backend.current)throw Error('SQLITE_NOT_INITIALIZED');return backend.current;}}));
import {sqliteFixture} from '../../../../scripts/testing/sqlite-fixture';
const fixtures:ReturnType<typeof sqliteFixture>[]=[];

const roots: string[] = [];

function createStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-harness-run-"));
  roots.push(root);
  backend.current=sqliteFixture(root);fixtures.push(backend.current);
  let now = 1_000;
  return {
    root,
    tick: () => { now += 1; },
    store: new HarnessRunStore(root, { now: () => now }),
  };
}

function createRun(store: HarnessRunStore) {
  return store.create({
    conversationId: "chat-1",
    runId: "run-1",
    messages: [{ role: "user", content: "整理项目结构" }],
    request: {
      provider: "openai",
      model: "test-model",
      contextWindowTokens: 128_000,
      mode: "work",
      promptFingerprint: "prompt-v1",
      toolSchemaFingerprint: "tools-v1",
    },
  });
}

afterEach(() => {
  for(const fixture of fixtures.splice(0))fixture.close();backend.current=null;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("HarnessRunStore", () => {
  it('commits checkpoints without JSON and deletes session plus events',()=>{
    const {root,store}=createStore();createRun(store);store.checkpoint('run-1',{rounds:3});store.markTerminal('run-1','completed');
    expect(new HarnessRunStore(root).get('run-1')?.status).toBe('completed');
    expect(fs.existsSync(path.join(root,'cyrene-runs'))).toBe(false);
    store.deleteConversation('chat-1');expect(store.get('run-1')).toBeNull();expect(backend.current.call('harness.audit','run-1')).toEqual([]);
  });
  it('fails closed without a backend',()=>{backend.current=null;expect(()=>new HarnessRunStore('unused')).toThrow('SQLITE_NOT_INITIALIZED');});

  it.each(["missing", "corrupt", "incomplete"])("ignores a %s legacy index while recovering SQLite", (kind) => {
    const {root,store}=createStore();createRun(store);
    if(kind!=="missing"){fs.mkdirSync(path.join(root,'cyrene-runs'));fs.writeFileSync(path.join(root,'cyrene-runs/index.json'),kind==='corrupt'?'broken':'[]');}
    const restarted=new HarnessRunStore(root);
    expect(restarted.getLatestInterrupted('chat-1')?.runId).toBe('run-1');
    expect(restarted.get('run-1')?.messages).toEqual([{role:'user',content:'整理项目结构'}]);
  });
  it("persists a main-run checkpoint separately from the chat transcript", () => {
    const { root, store, tick } = createStore();
    createRun(store);
    tick();

    store.checkpoint("run-1", {
      rounds: 2,
      todoItems: [{ id: "inspect", content: "检查入口", status: "in_progress" }],
      toolOutputs: [{
        recordId: "a".repeat(64), resultRef: "tool-result://v1/test", runId: "run-1", toolCallId: "call-1",
        toolName: "read_file", bytes: 10, codePoints: 10, truncatedForModel: false, createdAt: 1_001,
      }],
    });

    expect(store.get("run-1")).toMatchObject({
      status: "running",
      rounds: 2,
      state: { todoItems: [{ id: "inspect", status: "in_progress" }] },
      toolOutputs: [{ toolCallId: "call-1" }],
    });
    expect(fs.existsSync(path.join(root, "cyrene-runs", "sessions", "run-1.json"))).toBe(false);
  });

  it("persists a committed compaction cache epoch in the run checkpoint", () => {
    const { store } = createStore();
    createRun(store);

    store.checkpoint("run-1", {
      cache: { cacheEpoch: 2, epochReason: "compaction" },
    });

    expect(store.get("run-1")).toMatchObject({
      cache: { cacheEpoch: 2, epochReason: "compaction" },
    });
  });

  it("marks an unfinished main run interrupted after process restart", () => {
    const { root, store } = createStore();
    createRun(store);

    const restarted = new HarnessRunStore(root);

    expect(restarted.get("run-1")).toMatchObject({ status: "interrupted", runId: "run-1" });
    expect(restarted.getLatestInterrupted("chat-1")?.runId).toBe("run-1");
  });

  it("returns isolated snapshots and keeps a lifecycle journal", () => {
    const { store } = createStore();
    createRun(store);
    store.recordTool("run-1", { toolCallId: "call-1", toolName: "write_file", sideEffect: "idempotent_mutation", status: "started" });

    const snapshot = store.get("run-1")!;
    snapshot.messages.push({ role: "assistant", content: "不应写回" });

    expect(store.get("run-1")?.messages).toEqual([{ role: "user", content: "整理项目结构" }]);
    expect(store.get("run-1")?.toolCalls).toEqual([
      expect.objectContaining({ toolCallId: "call-1", status: "started" }),
    ]);
  });

  it("rejects only a live duplicate run id, allowing a stale terminal record to be replaced", () => {
    const { store } = createStore();
    createRun(store);
    expect(() => createRun(store)).toThrow("HARNESS_RUN_EXISTS");

    store.markTerminal("run-1", "completed");
    expect(createRun(store)).toMatchObject({ runId: "run-1", status: "running", rounds: 0 });
  });

  // ── 存储写放大减法 ──────────────────────────────────────

  it("clones live references from checkpoint patches before persisting", () => {
    // 消费方克隆契约：harness 删除 deepClone 后传活引用，
    // store 必须在 checkpoint 返回前完成克隆，调用方后续修改不得影响已落盘内容。
    const { store } = createStore();
    createRun(store);
    const messages: ChatMessage[] = [{ role: "user", content: "v1" }];
    const state: AgentState = { todoItems: [], uncertainEffects: [] };

    store.checkpoint("run-1", { messages, state });

    messages.push({ role: "assistant", content: "later" });
    state.todoItems.push({ id: "t1", content: "later", status: "pending" });

    expect(store.get("run-1")?.messages).toEqual([{ role: "user", content: "v1" }]);
    expect(store.get("run-1")?.state.todoItems).toEqual([]);
  });






  it("logs write amplification metrics on markTerminal", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { store } = createStore();
      createRun(store);
      store.recordTool("run-1", { toolCallId: "call-1", toolName: "read_file", sideEffect: "read_only", status: "committed" });
      store.checkpoint("run-1", { rounds: 1 });
      store.markTerminal("run-1", "completed");

      const metricLine = logSpy.mock.calls.map((call) => call.join(" ")).find((line) => line.includes("HarnessRunStore"));
      expect(metricLine).toBeDefined();
      expect(metricLine).toMatch(/run-1/);
      expect(metricLine).toMatch(/completed/);
    } finally {
      logSpy.mockRestore();
    }
  });
});
