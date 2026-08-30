import type { BrowserWindow } from "electron";
import type { IpcScope } from "../application/ipc-scope";
import type { AgentRuntime } from "../orchestrator/agent-runtime";
import { toolRegistry } from "../orchestrator/tool-registry";
import { SchedulerEngine, type SchedulerEngineDeps } from "./scheduler-engine";
import { getSchedulerStore } from "./scheduler-store";
import { registerSchedulerIpc } from "./scheduler-ipc";
import { createSchedulerRunner } from "./scheduler-runner";

export interface SchedulerSubsystemDeps {
  agentRuntime: AgentRuntime;
  getReactChatWindow(): BrowserWindow | null;
  store?: ReturnType<typeof getSchedulerStore>;
  createEngine?: (deps: SchedulerEngineDeps) => SchedulerEngine;
  registerIpc?: typeof registerSchedulerIpc;
  /** 共享 IPC scope；传入后 scheduler IPC 由组合根统一注销。 */
  ipc?: IpcScope;
}

export interface SchedulerSubsystem {
  store: ReturnType<typeof getSchedulerStore>;
  engine: SchedulerEngine;
  initialize(): void;
  start(): void;
  stop(): void;
}

/**
 * 组装 scheduler 子系统。构造期只创建 store 引用 / runner / engine，
 * 不加载 store、不注册 IPC、不启动定时器 —— initialize / start / stop 必须显式调用。
 */
export function createSchedulerSubsystem(deps: SchedulerSubsystemDeps): SchedulerSubsystem {
  const store = deps.store ?? getSchedulerStore();

  const runner = createSchedulerRunner({
    buildOptions: (task) => deps.agentRuntime.buildSchedulerOptions(task),
    getChatWebContents: () => {
      const win = deps.getReactChatWindow();
      return win && !win.isDestroyed() ? win.webContents : null;
    },
    recordHistory: (entry) => store.recordHistory(entry),
    id: () => `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    now: () => new Date(),
  });

  const engineDeps: SchedulerEngineDeps = {
    store,
    runTask: runner.runScheduledTask,
  };
  const engine = deps.createEngine
    ? deps.createEngine(engineDeps)
    : new SchedulerEngine(engineDeps);
  const registerIpc = deps.registerIpc ?? registerSchedulerIpc;

  let initialized = false;
  return {
    store,
    engine,
    /** 加载持久化 store + 注册 IPC。idempotent。 */
    initialize(): void {
      if (initialized) return;
      initialized = true;
      store.load();
      registerIpc(store, engine, () => toolRegistry.getAllTools(), deps.ipc);
    },
    /** 只启动 engine 定时器（必须在 MCP 恢复之后调用）。 */
    start(): void {
      engine.start();
    },
    /** 只停止 engine 定时器。 */
    stop(): void {
      engine.stop();
    },
  };
}
