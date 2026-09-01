import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelAdapter } from "../main/channels/adapters/base";
import { createContext, PLUGIN_CLEANUP_TIMEOUT_MS, type PluginRuntime } from "./context";

let tmp: string;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

function runtime(): PluginRuntime & { tools: string[]; ipc: Map<string, unknown> } {
  const tools: string[] = [];
  const ipc = new Map<string, unknown>();
  return {
    tools,
    ipc,
    toolRegistry: {
      register: (t) => tools.push(t.id),
      unregister: (id) => {
        const i = tools.indexOf(id);
        if (i >= 0) tools.splice(i, 1);
        return true;
      },
    },
    channelManager: { has: () => false, register: () => {}, unregister: async () => true, startOne: async () => {} },
    registerIpc: (c, h) => ipc.set(c, h),
    unregisterIpc: (c) => ipc.delete(c),
  };
}

describe("createContext", () => {
  it("registerIpc 自动加 plugin:<id>: 前缀", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-ctx-test-"));
    const rt = runtime();
    const ctx = createContext("demo", tmp, rt);
    ctx.registerIpc("ping", () => "pong");
    expect(rt.ipc.has("plugin:demo:ping")).toBe(true);
  });

  it("dispose 清理已注册工具与 IPC", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-ctx-test-"));
    const rt = runtime();
    const ctx = createContext("demo", tmp, rt);
    ctx.registerTool({
      id: "demo_tool",
      name: "t",
      description: "d",
      enabled: true,
      inputSchema: { type: "object", properties: {}, required: [] },
      execute: async () => "ok",
    });
    ctx.registerIpc("ping", () => "pong");
    await ctx.dispose();
    expect(rt.tools).toEqual([]);
    expect(rt.ipc.has("plugin:demo:ping")).toBe(false);
  });

  it("停止时先取消 signal，再按逆序等待清理回调", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-ctx-test-"));
    const ctx = createContext("demo", tmp, runtime());
    const events: string[] = [];
    ctx.onDispose(() => { events.push(`first:${ctx.signal.aborted}`); });
    ctx.onDispose(async () => {
      await Promise.resolve();
      events.push(`second:${ctx.signal.aborted}`);
    });

    expect(ctx.signal.aborted).toBe(false);
    ctx.beginStop();
    expect(ctx.signal.aborted).toBe(true);
    await ctx.dispose();

    expect(events).toEqual(["second:true", "first:true"]);
  });

  it("清理回调失败不阻止其他回调和框架资源释放，重复 dispose 不会重跑", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-ctx-test-"));
    const rt = runtime();
    const ctx = createContext("demo", tmp, rt);
    const events: string[] = [];
    ctx.registerIpc("ping", () => "pong");
    ctx.onDispose(() => { events.push("kept"); });
    ctx.onDispose(() => { throw new Error("cleanup failed"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await ctx.dispose();
    await ctx.dispose();

    expect(events).toEqual(["kept"]);
    expect(rt.ipc.has("plugin:demo:ping")).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("并发 dispose 共享同一个释放任务且不重复清理", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-ctx-test-"));
    const rt = runtime();
    const unregisterIpc = vi.spyOn(rt, "unregisterIpc");
    const ctx = createContext("demo", tmp, rt);
    let releaseCleanup!: () => void;
    ctx.registerIpc("ping", () => "pong");
    ctx.onDispose(() => new Promise<void>((resolve) => { releaseCleanup = resolve; }));

    const first = ctx.dispose();
    const second = ctx.dispose();

    expect(second).toBe(first);
    releaseCleanup();
    await Promise.all([first, second]);
    expect(unregisterIpc).toHaveBeenCalledOnce();
  });

  it("onDispose 超时后继续执行其余回调并释放框架资源", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-ctx-test-"));
    const rt = runtime();
    const ctx = createContext("demo", tmp, rt);
    const events: string[] = [];
    ctx.registerIpc("ping", () => "pong");
    ctx.onDispose(() => { events.push("continued"); });
    ctx.onDispose(() => new Promise<void>(() => {}));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();

    const disposing = ctx.dispose();
    await vi.advanceTimersByTimeAsync(PLUGIN_CLEANUP_TIMEOUT_MS);
    await disposing;

    expect(events).toEqual(["continued"]);
    expect(rt.ipc.has("plugin:demo:ping")).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "[plugin:demo] 清理资源时发生 1 个错误",
      [expect.objectContaining({ message: expect.stringContaining("onDispose 清理超时") })],
    );
  });

  it("停止后拒绝新增清理回调", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-ctx-test-"));
    const ctx = createContext("demo", tmp, runtime());
    ctx.beginStop();
    expect(() => ctx.onDispose(() => {})).toThrow(/停止后/);
  });

  it("storage 可读写", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-ctx-test-"));
    const ctx = createContext("demo", tmp, runtime());
    ctx.storage.set("k", 1);
    expect(ctx.storage.get<number>("k")).toBe(1);
  });

  it("工具 id 不满足 <插件id>_ 前缀时抛错", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-ctx-test-"));
    const ctx = createContext("demo", tmp, runtime());
    expect(() =>
      ctx.registerTool({
        id: "bad_tool",
        name: "t",
        description: "d",
        enabled: true,
        inputSchema: { type: "object", properties: {}, required: [] },
        execute: async () => "ok",
      }),
    ).toThrow(/demo_/);
  });

  it("拒绝覆盖已注册工具", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-ctx-test-"));
    const rt = runtime();
    rt.toolRegistry.getById = () => ({ id: "demo_tool" } as never);
    const ctx = createContext("demo", tmp, rt);
    expect(() =>
      ctx.registerTool({
        id: "demo_tool",
        name: "t",
        description: "d",
        enabled: true,
        inputSchema: { type: "object", properties: {}, required: [] },
        execute: async () => "ok",
      }),
    ).toThrow(/已被占用/);
    expect(rt.tools).toEqual([]);
  });

  it("拒绝覆盖已注册渠道", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-ctx-test-"));
    const rt = runtime();
    rt.channelManager.has = () => true;
    const ctx = createContext("demo", tmp, rt, ["channels"]);
    const adapter = { id: "wechat" } as ChannelAdapter;
    await expect(ctx.registerChannelAdapter(adapter)).rejects.toThrow(/已被占用/);
  });

  it("未声明 deps 时不注入 channels；声明后注入", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-ctx-test-"));
    const without = createContext("demo", tmp, runtime());
    expect(without.deps.channels).toBeUndefined();
    const withDeps = createContext("demo", tmp, runtime(), ["channels"]);
    expect(withDeps.deps.channels?.has("wechat")).toBe(false);
  });

  it("只有 manifest 声明 llm 时才注入 generateText", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-ctx-test-"));
    const rt = runtime();
    const calls: string[] = [];
    rt.llm = {
      generateText: async (messages) => {
        calls.push(messages.map((message) => message.content).join("|"));
        return "模型结果";
      },
    };

    const without = createContext("demo", tmp, rt);
    expect(without.deps.llm).toBeUndefined();

    const withDeps = createContext("demo", tmp, rt, ["llm"]);
    const result = await withDeps.deps.llm?.generateText([
      { role: "user", content: "你好" },
    ]);
    expect(result).toBe("模型结果");
    expect(calls).toEqual(["你好"]);
  });

  it("dispose 返回 Promise 并等待渠道注销完成", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-ctx-test-"));
    const rt = runtime();
    let releaseUnregister!: () => void;
    let unregisterFinished = false;
    rt.channelManager.unregister = async () => {
      await new Promise<void>((resolve) => {
        releaseUnregister = resolve;
      });
      unregisterFinished = true;
      return true;
    };
    const adapter: ChannelAdapter = {
      id: "wechat",
      displayName: "test",
      capability: {
        text: true,
        image: false,
        audio: false,
        file: false,
        video: false,
        markdown: false,
        card: false,
        sticker: false,
        maxTextLength: 100,
      },
      start: async () => {},
      stop: async () => {},
      onMessage: null,
      send: async () => ({ ok: true }),
      getStatus: () => ({ enabled: true, phase: "running" }),
    };
    const ctx = createContext("demo", tmp, rt, ["channels"]);
    await ctx.registerChannelAdapter(adapter);

    const disposing = ctx.dispose();
    expect(disposing).toBeInstanceOf(Promise);
    expect(unregisterFinished).toBe(false);
    releaseUnregister();
    await disposing;
    expect(unregisterFinished).toBe(true);
  });

  it("拒绝注销不属于当前插件的工具、IPC 和渠道", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-ctx-test-"));
    const ctx = createContext("demo", tmp, runtime(), ["channels"]);
    expect(() => ctx.unregisterTool("read_file")).toThrow(/不属于当前插件/);
    expect(() => ctx.unregisterIpc("missing")).toThrow(/不属于当前插件/);
    await expect(ctx.unregisterChannelAdapter("wechat")).rejects.toThrow(/不属于当前插件/);
  });
});
