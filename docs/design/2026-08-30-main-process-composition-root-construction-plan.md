# Electron 主进程应用组合根实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `src/main/index.ts` 重构为不超过 30 行的 **Composition Root（应用组合根）**入口，同时保持现有功能、IPC 契约、窗口语义和用户数据格式不变。

**Architecture:** 使用显式的 `preReady → shellReady → coreReady → backgroundReady` 阶段。只有 `application.ts` 持有完整 **ApplicationContext（应用上下文）**；启动模块使用窄依赖和不可变阶段结果。窗口加载受 IPC 注册屏障约束，后台任务由可取消运行器跟踪，退出使用固定阶段的受控清理与 Windows 紧急落盘。

**Tech Stack:** **Electron（跨平台桌面应用框架）** 43、**TypeScript（类型脚本语言）** 5.6、Node.js 24、**Vitest（测试框架）** 4.1、现有 `electron-updater` 6.6；不新增运行时依赖。

**Spec:** `docs/design/2026-08-30-main-process-composition-root-redesign.md`

## Global Constraints

- 冻结新功能，只做架构重构和已确认缺陷修复。
- 不新增依赖注入容器、生命周期库或后台任务库；复用 Electron API 和仓库现有模块。
- 保持所有公开 **IPC（进程间通信）**频道名称、参数和返回值不变。
- 保持聊天窗口为主窗口；桌宠只在 `petVisible === true` 时创建。
- 聊天渲染页面只能在它可能调用的全部 IPC 处理器注册后加载。
- `Loading` 最短展示时间从实际 `show()` 的时刻计算。
- `createXxx()` 只能构造；长期任务必须由显式 `initialize()`、`start()` 或 `load()` 启动。
- 生命周期阶段和 `degradedReasons` 独立；可选能力失败不得阻塞聊天窗口。
- 音乐、LSP、Git 监听、TTS 和 ASR 保持当前延迟启动语义。
- 不修改用户数据格式，不增加数据迁移。
- 不触碰用户现有改动 `src/main/channels/dispatcher.ts` 和 `native/cyrene-gamebot/`；任何提交都使用精确路径暂存。
- 当前回归基线为 345 个测试文件、2712 个测试通过；最终不得降低基线。

## Target File Map

### 新建文件

- `src/main/application/context.ts`：完整运行上下文与阶段结果类型，仅供编排器组装。
- `src/main/application/readiness.ts`：生命周期阶段、健康状态和等待屏障。
- `src/main/application/readiness.test.ts`：阶段推进、失败和健康恢复测试。
- `src/main/application/window-activation.ts`：启动期功能窗口激活代理。
- `src/main/application/window-activation.test.ts`：请求合并、门禁和停止测试。
- `src/main/application/shutdown.ts`：固定阶段受控退出、总超时和紧急落盘。
- `src/main/application/shutdown.test.ts`：阶段顺序、并发、幂等和超时测试。
- `src/main/application/electron-lifecycle.ts`：`before-quit`、窗口会话结束和更新事件适配。
- `src/main/application/electron-lifecycle.test.ts`：Electron 事件适配测试。
- `src/main/application/ipc-scope.ts`：统一注册和注销 IPC 处理器。
- `src/main/application/ipc-scope.test.ts`：重复注册和整体注销测试。
- `src/main/application/pre-ready.ts`：Electron `ready` 前的同步配置。
- `src/main/application/pre-ready.test.ts`：单实例、协议、GPU 开关和权限修复顺序测试。
- `src/main/application/shell-bootstrap.ts`：Loading、窗口壳、协议、托盘和基础 IPC。
- `src/main/application/shell-bootstrap.test.ts`：窗口不加载、桌宠不创建和激活门禁测试。
- `src/main/application/core-bootstrap.ts`：迁移、技能、工具、RAG、运行时、完整 IPC 和窗口加载。
- `src/main/application/core-bootstrap.test.ts`：核心顺序、降级和致命加载失败测试。
- `src/main/application/background.ts`：后台任务运行器、MCP 屏障、频道、调度与预热。
- `src/main/application/background.test.ts`：超时结算、取消、迟到资源和依赖顺序测试。
- `src/main/application/application.ts`：唯一生命周期编排器。
- `src/main/application/application.test.ts`：端到端阶段顺序和顶层失败测试。
- `src/main/windows/startup-window-load.ts`：聊天窗口页面加载和 `ready-to-show` 有限等待。
- `src/main/windows/startup-window-load.test.ts`：加载失败、事件失败和超时测试。

### 主要修改文件

- `src/main/index.ts`：最终只保留创建应用和绑定 Electron 生命周期。
- `src/main/channels/bootstrap.ts`、`src/main/channels/init.ts`：拆分构造、初始化、启动和停止。
- `src/main/scheduler/bootstrap.ts`、`src/main/scheduler/scheduler-ipc.ts`：拆分构造、初始化、启动和停止。
- `src/main/windows/create-aux-windows.ts`、`src/main/windows/window-manager.ts`：拆分聊天窗口对象创建与页面加载。
- `src/main/startup/create-splash-window.ts`：报告实际显示时刻。
- `src/main/tray.ts`、`src/main/windows/primary-window.ts`、`src/main/single-instance.ts`：统一进入窗口激活代理。
- `src/main/updater/app-update-ipc.ts`、`src/main/updater/app-update-service.ts`：安装更新前先走受控退出。
- 主进程现有 `registerXxxIpc` 模块：接收 IPC Scope 并返回注销函数。
- `src/main/music/shutdown-latch.ts`：组合根切换后删除独立退出闩锁的生产使用。

## Shared Interface Contract

后续任务统一使用以下接口名称，不在各任务中另起别名：

```ts
export type StartupPhase =
  | "preparing"
  | "shell-ready"
  | "core-ready"
  | "background-starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";

export interface DegradedReason {
  capability: string;
  message: string;
  at: number;
  error?: unknown;
}

export interface StartupReadiness {
  getPhase(): StartupPhase;
  transition(next: StartupPhase): void;
  waitFor(target: "core-ready" | "ready", signal?: AbortSignal): Promise<void>;
  markDegraded(reason: DegradedReason): void;
  clearDegraded(capability: string): void;
  getDegradedReasons(): ReadonlyMap<string, DegradedReason>;
}

export type WindowActivationRequest =
  | { kind: "chat"; sessionId?: string }
  | { kind: "sidebar" }
  | { kind: "settings"; section?: string }
  | { kind: "music" };

export interface WindowActivationBroker {
  bind(actions: {
    focusLoading(): void;
    activate(request: WindowActivationRequest): void | Promise<void>;
  }): void;
  request(request: WindowActivationRequest): void;
  markReady(): Promise<void>;
  stop(): void;
  isReady(): boolean;
}

export type ShutdownPhase =
  | "quiesce"
  | "stopProducers"
  | "stopActiveWork"
  | "stopExternalConsumers"
  | "stopExternalProviders"
  | "stopLocalResources"
  | "flushPersistence";

export interface ShutdownCoordinator {
  register(input: {
    id: string;
    phase: ShutdownPhase;
    dispose(signal: AbortSignal): void | Promise<void>;
  }): () => void;
  registerEmergencyFlush(id: string, flush: () => void): () => void;
  requestControlledShutdown(input: {
    reason: string;
    finalAction(): void;
  }): Promise<void>;
  emergencyFlush(): void;
  isStopping(): boolean;
  isFinalizing(): boolean;
}

export interface ReactChatWindowHandle {
  window: Electron.BrowserWindow;
  load(sessionId?: string): Promise<void>;
  show(sessionId?: string): void;
}
```

## Test Fixture Contract

Test snippets use local, test-only dependency factories. They are created in the same test file during the “write failing test” step and are never exported to production code:

- `makeChannelsDeps(overrides)` returns a complete `ChannelsSubsystemDeps` with every external function as `vi.fn()`.
- `makeSchedulerDeps(overrides)` returns scheduler store, engine factory and IPC registration fakes.
- `makePreReadyDeps(calls, overrides)` appends each pre-ready operation name to `calls`.
- `makeShellDeps(overrides)` exposes spies `createSplashWindow`, `createChatShell`, `fireTrayChat`, readiness and activation; its fake `WindowManager` exposes `createPetWindow`.
- `makeCoreDeps(calls, overrides)` appends each core operation name to `calls` and exposes `chat`, `channels`, `scheduler`, readiness and shutdown spies.
- `makeBackgroundDeps(calls, overrides)` appends each background operation name to `calls` and exposes MCP, channel, scheduler and readiness spies.
- `makeApplicationDeps(calls, overrides)` appends each application phase to `calls` and exposes readiness and shutdown spies.
- `makeUpdateService(overrides)` returns a complete `AppUpdateService` fake.
- `createFakeBrowserWindow()` returns an event-emitting window fake with `loadURL`, `loadFile`, `show`, `focus`, `close`, `isDestroyed` and `webContents` spies.
- `createFakeStartupWindow()` returns the minimal `StartupLoadWindowLike` event fake.
- `createFakeIpcMain()` returns `handle`, `on`, `removeHandler`, `removeListener` spies plus maps of registered handlers and listeners.
- `createFakeIpcScope()` returns an `IpcScope` fake plus a map of registered handlers.

Every factory uses the same override rule:

```ts
function withOverrides<T extends object>(defaults: T, overrides: Partial<T> = {}): T {
  return { ...defaults, ...overrides };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
```

---

### Task 1: Make Channels and Scheduler Lifecycles Explicit

**Files:**
- Create: `src/main/channels/bootstrap.test.ts`
- Create: `src/main/scheduler/bootstrap.test.ts`
- Modify: `src/main/channels/bootstrap.ts`
- Modify: `src/main/channels/init.ts`
- Modify: `src/main/scheduler/bootstrap.ts`
- Modify: `src/main/scheduler/scheduler-ipc.ts`
- Modify: `src/main/index.ts` only enough to call the new explicit methods while preserving current behavior

**Interfaces:**
- Consumes: existing `AgentRuntime`, `TtsSynthesisService`, `SchedulerEngine`, channel adapters and stores.
- Produces:

```ts
export interface ChannelsLifecycleAdapter {
  initialize(): void;
  start(signal?: AbortSignal): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ChannelsSubsystem {
  initialize(): void;
  start(signal?: AbortSignal): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ChannelsSubsystemDeps {
  agentRuntime: AgentRuntime;
  ttsSynthesisService: TtsSynthesisService;
  getReactChatWindow(): Electron.BrowserWindow | null;
}

export function createChannelsSubsystem(
  deps: ChannelsSubsystemDeps,
  lifecycle?: ChannelsLifecycleAdapter,
): ChannelsSubsystem;

export interface SchedulerSubsystemDeps {
  agentRuntime: AgentRuntime;
  getReactChatWindow(): Electron.BrowserWindow | null;
  store?: ReturnType<typeof getSchedulerStore>;
  createEngine?: (deps: SchedulerEngineDeps) => SchedulerEngine;
  registerIpc?: typeof registerSchedulerIpc;
}

export interface SchedulerSubsystem {
  store: ReturnType<typeof getSchedulerStore>;
  engine: SchedulerEngine;
  initialize(): void;
  start(): void;
  stop(): void;
}

export function createSchedulerSubsystem(deps: SchedulerSubsystemDeps): SchedulerSubsystem;
```

- `createChannelsSubsystem()` and `createSchedulerSubsystem()` must not start timers, servers, adapters or asynchronous work.

- [x] **Step 1: Write failing channel lifecycle tests**

```ts
it("does not initialize or start channels during construction", () => {
  const lifecycle = { initialize: vi.fn(), start: vi.fn(), shutdown: vi.fn() };
  const subsystem = createChannelsSubsystem(makeChannelsDeps(), lifecycle);
  expect(lifecycle.initialize).not.toHaveBeenCalled();
  expect(lifecycle.start).not.toHaveBeenCalled();
  subsystem.initialize();
  expect(lifecycle.initialize).toHaveBeenCalledOnce();
});

it("starts channels only after explicit start", async () => {
  const lifecycle = { initialize: vi.fn(), start: vi.fn(async () => undefined), shutdown: vi.fn() };
  const subsystem = createChannelsSubsystem(makeChannelsDeps(), lifecycle);
  await subsystem.start();
  expect(lifecycle.start).toHaveBeenCalledOnce();
});
```

- [x] **Step 2: Write failing scheduler lifecycle tests**

```ts
it("does not load the store, register IPC, or start the engine in createSchedulerSubsystem", () => {
  const store = { load: vi.fn(), onChange: vi.fn() };
  const engine = { start: vi.fn(), stop: vi.fn() };
  const createEngine = vi.fn(() => engine);
  const registerIpc = vi.fn();
  const subsystem = createSchedulerSubsystem(makeSchedulerDeps({ store, createEngine, registerIpc }));
  expect(store.load).not.toHaveBeenCalled();
  expect(registerIpc).not.toHaveBeenCalled();
  expect(engine.start).not.toHaveBeenCalled();
  subsystem.initialize();
  expect(store.load).toHaveBeenCalledOnce();
  expect(registerIpc).toHaveBeenCalledOnce();
});
```

- [x] **Step 3: Run the focused tests and verify RED**

Run:

```powershell
npx vitest run src/main/channels/bootstrap.test.ts src/main/scheduler/bootstrap.test.ts
```

Expected: FAIL because the factories currently perform initialization during construction and do not expose the required lifecycle methods.

- [x] **Step 4: Split channel initialization from network start**

Refactor `channels/init.ts` into explicit idempotent operations:

```ts
export function initializeChannels(): void {
  wireDispatcher();
  registerAdapters();
  registerChannelsIpc();
}

export async function startChannels(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await startInboundServer();
  if (signal?.aborted) {
    await stopInboundServer();
    throw signal.reason;
  }
  await channelManager.startAll();
}
```

`shutdownChannels()` stops adapters and the inbound server, and resets both `initialized` and `started` flags. Preserve all existing adapter and dispatcher behavior.

- [x] **Step 5: Split scheduler initialization from timer start**

Move `store.load()` and `registerSchedulerIpc()` into `initialize()`. `start()` calls only `engine.start()`, and `stop()` calls only `engine.stop()`.

- [x] **Step 6: Keep the old entry behavior temporarily explicit**

In the current `index.ts`, replace implicit creation with explicit calls while already fixing the confirmed MCP/channel ordering bug:

```ts
channelsSubsystem = createChannelsSubsystem(deps);
channelsSubsystem.initialize();

schedulerSubsystem = createSchedulerSubsystem({ agentRuntime, getReactChatWindow: getChatWindow });
schedulerSubsystem.initialize();

// Keep these at the current post-MCP startup position.
await channelsSubsystem.start();
schedulerSubsystem.start();
```

Remove the old `schedulerSubsystem.engine.start()` call. Do not use `void channelsSubsystem.start()`; the temporary entry must await the explicit start until Task 9 moves it into the tracked background runner.

- [x] **Step 7: Run focused and adjacent tests**

```powershell
npx vitest run src/main/channels/bootstrap.test.ts src/main/channels src/main/scheduler/bootstrap.test.ts src/main/scheduler
npm run build:main
```

Expected: all selected tests pass and the main-process build exits with code 0.

- [x] **Step 8: Commit only lifecycle files**

```powershell
git add -- src/main/channels/bootstrap.ts src/main/channels/init.ts src/main/channels/bootstrap.test.ts src/main/scheduler/bootstrap.ts src/main/scheduler/scheduler-ipc.ts src/main/scheduler/bootstrap.test.ts src/main/index.ts
git commit -m "refactor(app): make subsystem lifecycle explicit"
```

Before committing, run `git diff --cached --name-only` and confirm `src/main/channels/dispatcher.ts` is absent.

### Task 2: Add Readiness and Window Activation Primitives

**Files:**
- Create: `src/main/application/readiness.ts`
- Create: `src/main/application/readiness.test.ts`
- Create: `src/main/application/window-activation.ts`
- Create: `src/main/application/window-activation.test.ts`
- Modify: `src/main/tray.ts`
- Create: `src/main/tray.test.ts`
- Modify: `src/main/windows/primary-window.ts`
- Modify: `src/main/windows/primary-window.test.ts`

**Interfaces:**
- Consumes: `StartupPhase`, `StartupReadiness`, `WindowActivationRequest`, and `WindowActivationBroker` from the Shared Interface Contract.
- Produces: `createStartupReadiness()` and `createWindowActivationBroker()`.

- [x] **Step 1: Write failing readiness tests**

```ts
it("keeps lifecycle phase independent from degraded capabilities", () => {
  const readiness = createStartupReadiness({ now: () => 10 });
  readiness.transition("shell-ready");
  readiness.markDegraded({ capability: "rag", message: "offline", at: 10 });
  readiness.transition("core-ready");
  expect(readiness.getPhase()).toBe("core-ready");
  expect(readiness.getDegradedReasons().has("rag")).toBe(true);
  readiness.clearDegraded("rag");
  expect(readiness.getPhase()).toBe("core-ready");
});

it("rejects core waiters when startup fails", async () => {
  const readiness = createStartupReadiness();
  const waiting = readiness.waitFor("core-ready");
  readiness.transition("failed");
  await expect(waiting).rejects.toThrow("startup failed");
});
```

- [x] **Step 2: Write failing activation tests**

```ts
it("queues and coalesces activation until markReady", async () => {
  const activate = vi.fn();
  const focusLoading = vi.fn();
  const broker = createWindowActivationBroker();
  broker.bind({ activate, focusLoading });
  broker.request({ kind: "chat", sessionId: "old" });
  broker.request({ kind: "chat", sessionId: "new" });
  expect(activate).not.toHaveBeenCalled();
  expect(focusLoading).toHaveBeenCalledTimes(2);
  await broker.markReady();
  expect(activate).toHaveBeenCalledOnce();
  expect(activate).toHaveBeenCalledWith({ kind: "chat", sessionId: "new" });
});

it("rejects activation after stop", () => {
  const broker = createWindowActivationBroker();
  broker.stop();
  broker.request({ kind: "chat" });
  expect(broker.isReady()).toBe(false);
});
```

- [x] **Step 3: Run tests and verify RED**

```powershell
npx vitest run src/main/application/readiness.test.ts src/main/application/window-activation.test.ts
```

Expected: FAIL because the application lifecycle primitives do not exist.

- [x] **Step 4: Implement readiness with validated transitions**

Allow only:

```text
preparing → shell-ready → core-ready → background-starting → ready
preparing/shell-ready/core-ready/background-starting/ready/failed → stopping → stopped
preparing/shell-ready/core-ready/background-starting → failed
```

`waitFor()` resolves when the requested phase is reached and rejects on `failed`, `stopping`, `stopped`, or an aborted signal.

- [x] **Step 5: Implement the activation broker**

Store pending requests in a `Map<WindowActivationRequest["kind"], WindowActivationRequest>`, replacing the previous request of the same kind. `bind()` supplies actions without marking the broker ready. `markReady()` flips the one-shot gate and drains requests. `stop()` clears pending requests and ignores future calls.

- [x] **Step 6: Route tray and primary-window actions through requests**

Change tray dependencies to:

```ts
export interface CreateTrayDependencies {
  requestActivation(request: WindowActivationRequest): void;
  togglePetWindow(): void;
  quit(): void;
}
```

Map menu items to `chat`, `sidebar`, `music`, and `settings` requests. Keep the desktop-pet toggle and quit actions immediate.

- [x] **Step 7: Run focused tests and build**

```powershell
npx vitest run src/main/application/readiness.test.ts src/main/application/window-activation.test.ts src/main/tray.test.ts src/main/windows/primary-window.test.ts
npm run build:main
```

- [x] **Step 8: Commit**

```powershell
git add -- src/main/application/readiness.ts src/main/application/readiness.test.ts src/main/application/window-activation.ts src/main/application/window-activation.test.ts src/main/tray.ts src/main/tray.test.ts src/main/windows/primary-window.ts src/main/windows/primary-window.test.ts
git commit -m "refactor(app): add readiness and activation gates"
```

### Task 3: Add Fixed-Phase Shutdown Coordination

**Files:**
- Create: `src/main/application/shutdown.ts`
- Create: `src/main/application/shutdown.test.ts`
- Create: `src/main/application/electron-lifecycle.ts`
- Create: `src/main/application/electron-lifecycle.test.ts`
- Verify unchanged: `src/main/token-usage-store.ts`

**Interfaces:**
- Consumes: `ShutdownCoordinator` and `ShutdownPhase` from the Shared Interface Contract.
- Produces:

```ts
export interface AppLifecycleLike {
  on(event: "before-quit", listener: (event: { preventDefault(): void }) => void): void;
  removeListener(event: "before-quit", listener: (event: { preventDefault(): void }) => void): void;
  quit(): void;
}

export interface SessionEndWindowLike {
  on(event: "query-session-end" | "session-end", listener: (event: { preventDefault(): void }) => void): void;
  removeListener(event: "query-session-end" | "session-end", listener: (event: { preventDefault(): void }) => void): void;
}

export function createShutdownCoordinator(options: {
  readiness: StartupReadiness;
  timeoutMs?: number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  log?: (message: string, error?: unknown) => void;
}): ShutdownCoordinator;

export function installAppShutdownHandlers(input: {
  app: AppLifecycleLike;
  coordinator: ShutdownCoordinator;
}): () => void;

export function attachWindowsSessionEndHandlers(input: {
  window: SessionEndWindowLike;
  coordinator: ShutdownCoordinator;
}): () => void;
```

- [x] **Step 1: Write failing shutdown order and idempotency tests**

```ts
it("runs fixed phases sequentially and entries within one phase concurrently", async () => {
  const events: string[] = [];
  const readiness = createStartupReadiness();
  const coordinator = createShutdownCoordinator({ readiness, timeoutMs: 1000 });
  coordinator.register({ id: "scheduler", phase: "stopProducers", dispose: async () => { events.push("scheduler"); } });
  coordinator.register({ id: "channels", phase: "stopExternalConsumers", dispose: async () => { events.push("channels"); } });
  coordinator.register({ id: "mcp", phase: "stopExternalProviders", dispose: async () => { events.push("mcp"); } });
  await coordinator.requestControlledShutdown({ reason: "test", finalAction: () => events.push("final") });
  expect(events).toEqual(["scheduler", "channels", "mcp", "final"]);
  expect(readiness.getPhase()).toBe("stopped");
});

it("runs finalAction once for repeated requests", async () => {
  const finalAction = vi.fn();
  const coordinator = createShutdownCoordinator({ readiness: createStartupReadiness() });
  await Promise.all([
    coordinator.requestControlledShutdown({ reason: "one", finalAction }),
    coordinator.requestControlledShutdown({ reason: "two", finalAction }),
  ]);
  expect(finalAction).toHaveBeenCalledOnce();
});
```

- [x] **Step 2: Write failing emergency-flush tests**

```ts
it("performs emergency flush synchronously and idempotently", () => {
  const flush = vi.fn();
  const coordinator = createShutdownCoordinator({ readiness: createStartupReadiness() });
  coordinator.registerEmergencyFlush("token-usage", flush);
  coordinator.emergencyFlush();
  coordinator.emergencyFlush();
  expect(flush).toHaveBeenCalledOnce();
});
```

- [x] **Step 3: Write failing Electron adapter tests**

Capture `before-quit`, `query-session-end`, and `session-end` handlers with fakes. Assert the first controlled quit calls `preventDefault()`, while a finalizing quit does not. Assert both Windows session events call `emergencyFlush()` without awaiting network cleanup.

- [x] **Step 4: Run tests and verify RED**

```powershell
npx vitest run src/main/application/shutdown.test.ts src/main/application/electron-lifecycle.test.ts
```

- [x] **Step 5: Implement fixed phases and total timeout**

Use the exact phase order from the Shared Interface Contract. Transition readiness to `stopping` before the first phase. For each phase, call all registered disposers with one shared `AbortSignal` and await `Promise.allSettled()`. Race the entire phase chain against one deadline; when it fires, abort the signal, log incomplete resource IDs, and stop awaiting non-cooperative disposers. In both the normal and timeout paths, transition to `stopped`, set `finalizing`, then invoke the first request's `finalAction`.

- [x] **Step 6: Register token usage for both exit levels**

Keep `flush()` synchronous and atomic. The production composition will register it in `flushPersistence` and as an emergency flusher; do not add Electron listeners directly inside `token-usage-store.ts`.

- [x] **Step 7: Run tests and build**

```powershell
npx vitest run src/main/application/shutdown.test.ts src/main/application/electron-lifecycle.test.ts src/main/token-usage-store.test.ts
npm run build:main
```

- [x] **Step 8: Commit**

```powershell
git add -- src/main/application/shutdown.ts src/main/application/shutdown.test.ts src/main/application/electron-lifecycle.ts src/main/application/electron-lifecycle.test.ts
git commit -m "refactor(app): coordinate phased shutdown"
```

### Task 4: Separate Chat Window Construction from Renderer Loading

**Files:**
- Create: `src/main/windows/startup-window-load.ts`
- Create: `src/main/windows/startup-window-load.test.ts`
- Modify: `src/main/windows/create-aux-windows.ts`
- Modify: `src/main/windows/window-manager.ts`
- Modify: `src/main/windows/window-state.ts`
- Modify: `src/main/startup/create-splash-window.ts`
- Modify: `src/main/startup/startup-window-reveal.ts`
- Modify: `src/main/startup/startup-window-reveal.test.ts`

**Interfaces:**
- Consumes: `ReactChatWindowHandle` from the Shared Interface Contract.
- Produces:

```ts
export interface StartupLoadWindowLike {
  once(event: "ready-to-show", listener: () => void): void;
  removeListener(event: "ready-to-show", listener: () => void): void;
  webContents: {
    once(event: "did-fail-load", listener: (_event: unknown, code: number, description: string, url: string, isMainFrame: boolean) => void): void;
    removeListener(event: "did-fail-load", listener: (_event: unknown, code: number, description: string, url: string, isMainFrame: boolean) => void): void;
  };
}

export interface StartupWindowLike {
  close(): void;
  isDestroyed(): boolean;
  show(): void;
}

export interface RevealStartupWindowsOptions {
  splashWindow: StartupWindowLike | null;
  chatWindow: StartupWindowLike;
  loadingShownAt?: number;
  minimumDurationMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export function createReactChatWindowShell(options?: {
  readyTimeoutMs?: number;
}): ReactChatWindowHandle;

export async function loadWindowForStartup(input: {
  window: StartupLoadWindowLike;
  load(): Promise<void>;
  timeoutMs: number;
}): Promise<void>;

export interface WindowManager {
  createReactChatWindowShell(): ReactChatWindowHandle;
  openReactChatWindow(sessionId?: string): Promise<Electron.BrowserWindow>;
  // Existing pet and auxiliary-window methods remain.
}
```

Use `20_000` ms as the chat renderer `ready-to-show` timeout.

- [x] **Step 1: Write failing load-order tests**

```ts
it("does not load the renderer while creating the chat window shell", () => {
  const window = createFakeBrowserWindow();
  vi.mocked(BrowserWindow).mockImplementation(() => window as never);
  const handle = createReactChatWindowShell();
  expect(window.loadURL).not.toHaveBeenCalled();
  expect(window.loadFile).not.toHaveBeenCalled();
  expect(handle.window).toBeDefined();
});
```

- [x] **Step 2: Write failing failure and timeout tests**

```ts
it("rejects when loadURL rejects", async () => {
  await expect(loadWindowForStartup({
    window: createFakeStartupWindow(),
    load: async () => { throw new Error("load failed"); },
    timeoutMs: 20_000,
  })).rejects.toThrow("load failed");
});

it("rejects when ready-to-show never arrives", async () => {
  vi.useFakeTimers();
  const pending = loadWindowForStartup({ window: createFakeStartupWindow(), load: async () => undefined, timeoutMs: 20_000 });
  await vi.advanceTimersByTimeAsync(20_000);
  await expect(pending).rejects.toThrow("ready-to-show timeout");
});
```

- [x] **Step 3: Run tests and verify RED**

```powershell
npx vitest run src/main/windows/startup-window-load.test.ts src/main/startup/startup-window-reveal.test.ts
```

- [x] **Step 4: Implement an idempotent chat handle**

`load()` caches one Promise. Attach `did-fail-load` and `ready-to-show` listeners before invoking `loadURL/loadFile`. Ignore subframe failures. On success, remove failure and timeout listeners. `show(sessionId)` dispatches the session ID using the existing `reactChatSession` logic and must not call `load()`.

- [x] **Step 5: Record actual Loading show time**

Extend `createSplashWindow()` with `onShown(at: number)`. Invoke it immediately after `window.show()` using an injected monotonic clock defaulting to `performance.now()`. If splash creation or loading fails, shell bootstrap leaves `loadingShownAt` undefined and skips minimum delay.

- [x] **Step 6: Update startup reveal calculation**

Change reveal options to include the chat window and optional splash timestamp:

```ts
const remaining = loadingShownAt === undefined
  ? 0
  : Math.max(0, minimumDurationMs - (now() - loadingShownAt));
```

Close Loading and show chat. The core bootstrap then marks the activation broker ready. Desktop pet is not part of generic reveal.

- [x] **Step 7: Run focused tests and build**

```powershell
npx vitest run src/main/windows/startup-window-load.test.ts src/main/startup/startup-window-reveal.test.ts src/main/windows
npm run build:main
```

- [x] **Step 8: Commit**

```powershell
git add -- src/main/windows/startup-window-load.ts src/main/windows/startup-window-load.test.ts src/main/windows/create-aux-windows.ts src/main/windows/window-manager.ts src/main/windows/window-state.ts src/main/startup/create-splash-window.ts src/main/startup/startup-window-reveal.ts src/main/startup/startup-window-reveal.test.ts
git commit -m "refactor(app): separate chat window creation and load"
```

### Task 5: Scope Main-Process IPC Registration

**Files:**
- Create: `src/main/application/ipc-scope.ts`
- Create: `src/main/application/ipc-scope.test.ts`
- Modify: `src/main/windows/window-system-ipc.ts`
- Modify: `src/main/chats/chat-ui-ipc.ts`
- Modify: `src/main/settings/settings-ipc.ts`
- Modify: `src/main/memory/memory-user-ipc.ts`
- Modify: `src/main/tts/tts-ipc.ts`
- Modify: `src/main/chats/chats-ipc.ts`
- Modify: `src/main/code-git/code-git-ipc.ts`
- Modify: `src/main/agui-bridge.ts`
- Modify: `src/main/updater/app-update-ipc.ts`
- Modify: `src/main/scheduler/scheduler-ipc.ts`
- Modify: `src/main/channels/init.ts`
- Modify: `src/main/user-choice.ts`
- Modify: `src/main/call/call-manager.ts`
- Modify: `src/main/permission/bootstrap.ts`

**Interfaces:**
- Produces:

```ts
export interface IpcScope {
  handle(channel: string, listener: (...args: any[]) => unknown): void;
  on(channel: string, listener: (...args: any[]) => void): void;
  dispose(): void;
}

export function createIpcScope(main?: Pick<typeof ipcMain,
  "handle" | "on" | "removeHandler" | "removeListener"
>): IpcScope;
```

- Every `registerXxxIpc` function listed above accepts `{ ipc: IpcScope }` or an `IpcScope` parameter. Public IPC constants and payloads remain unchanged.

- [x] **Step 1: Write failing scope tests**

```ts
it("removes every handler and listener registered through the scope", () => {
  const main = createFakeIpcMain();
  const scope = createIpcScope(main);
  const listener = vi.fn();
  scope.handle("a", listener);
  scope.on("b", listener);
  scope.dispose();
  expect(main.removeHandler).toHaveBeenCalledWith("a");
  expect(main.removeListener).toHaveBeenCalledWith("b", listener);
});

it("rejects duplicate registration inside one scope", () => {
  const scope = createIpcScope(createFakeIpcMain());
  scope.handle("a", vi.fn());
  expect(() => scope.handle("a", vi.fn())).toThrow("IPC channel already registered: a");
});
```

- [x] **Step 2: Run the scope test and verify RED**

```powershell
npx vitest run src/main/application/ipc-scope.test.ts
```

- [x] **Step 3: Implement `IpcScope`**

Track handled channels and listener tuples. `dispose()` is idempotent and removes them in reverse local registration order; this reverse order is only for handler teardown and is unrelated to resource shutdown phases.

- [x] **Step 4: Convert IPC registration modules mechanically**

For each listed module:

1. Replace direct `ipcMain.handle` with `ipc.handle`.
2. Replace direct `ipcMain.on` with `ipc.on`.
3. Keep existing optional fake IPC parameters working by wrapping them in the same structural interface.
4. Do not rename channels or modify payload validation.
5. Return the existing feature disposer where one already exists; otherwise let the owning phase dispose the shared scope.

Representative conversion:

```ts
export function registerAppUpdateIpc(options: RegisterAppUpdateIpcOptions & { ipc: IpcScope }): () => void {
  options.ipc.handle(IPC.APP_UPDATE_GET_STATE, () => options.service.getState());
  const unsubscribe = options.service.onStateChanged(broadcast);
  return unsubscribe;
}
```

- [x] **Step 5: Run all touched IPC tests**

```powershell
npx vitest run src/main/application/ipc-scope.test.ts src/main/updater/app-update-ipc.test.ts src/main/settings src/main/chats src/main/code-git src/main/tts src/main/channels src/main/scheduler
npm run build:main
```

- [x] **Step 6: Commit**

```powershell
git add -- src/main/application/ipc-scope.ts src/main/application/ipc-scope.test.ts src/main/windows/window-system-ipc.ts src/main/chats/chat-ui-ipc.ts src/main/settings/settings-ipc.ts src/main/memory/memory-user-ipc.ts src/main/tts/tts-ipc.ts src/main/chats/chats-ipc.ts src/main/code-git/code-git-ipc.ts src/main/agui-bridge.ts src/main/updater/app-update-ipc.ts src/main/scheduler/scheduler-ipc.ts src/main/channels/init.ts src/main/user-choice.ts src/main/call/call-manager.ts src/main/permission/bootstrap.ts
git commit -m "refactor(app): scope main process ipc registration"
```

### Task 6: Extract the Pre-Ready Phase

**Files:**
- Create: `src/main/application/pre-ready.ts`
- Create: `src/main/application/pre-ready.test.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `WindowActivationBroker.request({ kind: "chat" })` for second-instance activation.
- Produces:

```ts
export interface PreReadyDependencies {
  configureDocumentIndex(): void;
  installSingleInstance(onSecondInstance: () => void): boolean;
  registerPrivilegedSchemes(): void;
  configureGpuSwitches(): void;
  ensureGpuSandboxAcl(): void;
  activation: Pick<WindowActivationBroker, "request">;
}

export interface PreReadyResult {
  isPrimaryProcess: boolean;
}

export function prepareBeforeReady(deps: PreReadyDependencies): PreReadyResult;
```

- [x] **Step 1: Write failing order tests**

```ts
it("performs every Electron pre-ready operation synchronously", () => {
  const calls: string[] = [];
  const result = prepareBeforeReady(makePreReadyDeps(calls));
  expect(calls).toEqual([
    "configure-document-index",
    "single-instance-lock",
    "register-schemes",
    "gpu-switches",
    "gpu-acl",
  ]);
  expect(result.isPrimaryProcess).toBe(true);
});

it("does not continue primary startup for a duplicate process", () => {
  const deps = makePreReadyDeps([], { installSingleInstance: () => false });
  expect(prepareBeforeReady(deps).isPrimaryProcess).toBe(false);
  expect(deps.registerPrivilegedSchemes).not.toHaveBeenCalled();
  expect(deps.ensureGpuSandboxAcl).not.toHaveBeenCalled();
});
```

- [x] **Step 2: Run and verify RED**

```powershell
npx vitest run src/main/application/pre-ready.test.ts
```

- [x] **Step 3: Move only ready-before-required code**

Move these operations from `index.ts` without changing order or behavior:

```text
configureDocumentIndexQueue(runDocumentIndexJob)
installSingleInstanceGuard(app, activation callback)
registerPrivilegedSchemes()
disable-gpu / enable-unsafe-swiftshader switches
ensureGpuSandboxAcl({ isPackaged: app.isPackaged, exeDir: path.dirname(app.getPath("exe")), userDataDir: app.getPath("userData") })
```

Do not construct business services, windows or IPC scopes in this module.

- [x] **Step 4: Run tests and build**

```powershell
npx vitest run src/main/application/pre-ready.test.ts src/main/single-instance.test.ts src/main/gpu-sandbox-acl.test.ts
npm run build:main
```

- [x] **Step 5: Commit**

```powershell
git add -- src/main/application/pre-ready.ts src/main/application/pre-ready.test.ts src/main/index.ts
git commit -m "refactor(app): extract pre-ready bootstrap"
```

### Task 7: Build the Shell Bootstrap

**Files:**
- Create: `src/main/application/context.ts`
- Create: `src/main/application/shell-bootstrap.ts`
- Create: `src/main/application/shell-bootstrap.test.ts`
- Modify: `src/main/tray.ts`
- Modify: `src/main/windows/window-manager.ts`
- Modify: `src/main/startup/create-splash-window.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: readiness, activation broker, shutdown coordinator, `createIpcScope()`, and `createReactChatWindowShell()`.
- Produces:

```ts
export interface ShellDependencies {
  readiness: StartupReadiness;
  activation: WindowActivationBroker;
  shutdown: ShutdownCoordinator;
  createIpcScope(): IpcScope;
  createSplashWindow(options: { onShown(at: number): void }): Electron.BrowserWindow | null;
  createWindowManager(): WindowManager;
  createChatShell(): ReactChatWindowHandle;
  registerProtocolHandlers(): void;
  registerShellIpc(ipc: IpcScope): void;
  createTray(requestActivation: (request: WindowActivationRequest) => void): Electron.Tray;
  flushTokenUsage(): void;
}

export interface ShellResult {
  ipc: IpcScope;
  splashWindow: Electron.BrowserWindow | null;
  loadingShownAt: number | undefined;
  windowManager: WindowManager;
  chat: ReactChatWindowHandle;
  tray: Electron.Tray;
}

export async function startShell(deps: ShellDependencies): Promise<ShellResult>;
```

- [x] **Step 1: Write failing shell tests**

```ts
it("shows Loading but leaves the chat renderer unloaded", async () => {
  const deps = makeShellDeps();
  const shell = await startShell(deps);
  expect(deps.createSplashWindow).toHaveBeenCalledBefore(deps.createChatShell);
  expect(shell.chat.load).not.toHaveBeenCalled();
  expect(shell.windowManager.createPetWindow).not.toHaveBeenCalled();
  expect(deps.readiness.getPhase()).toBe("shell-ready");
});

it("routes tray actions through the activation broker", async () => {
  const deps = makeShellDeps();
  await startShell(deps);
  deps.fireTrayChat();
  expect(deps.activation.request).toHaveBeenCalledWith({ kind: "chat" });
});
```

- [x] **Step 2: Run and verify RED**

```powershell
npx vitest run src/main/application/shell-bootstrap.test.ts
```

- [x] **Step 3: Implement shell order**

The exact order is:

```text
write banner and startup log
create/show splash and capture loadingShownAt
create IpcScope
create WindowManager
create unloaded chat shell
bind activation actions, but do not mark ready
register protocol handlers and shell-safe IPC
create tray using activation requests
transition readiness to shell-ready
```

Shell-safe IPC is limited to handlers whose complete dependencies already exist. Any handler used by chat but dependent on core is registered in Task 8 before `chat.load()`.

- [x] **Step 4: Register shell cleanup**

Register tray/window manager/IPC scope cleanup in `stopLocalResources`. Attach `query-session-end` and `session-end` to the chat window shell immediately after creation. Register `flushTokenUsage` in both `flushPersistence` and emergency flush.

- [x] **Step 5: Run focused tests and build**

```powershell
npx vitest run src/main/application/shell-bootstrap.test.ts src/main/tray.test.ts src/main/windows src/main/startup
npm run build:main
```

- [x] **Step 6: Commit**

```powershell
git add -- src/main/application/context.ts src/main/application/shell-bootstrap.ts src/main/application/shell-bootstrap.test.ts src/main/tray.ts src/main/windows/window-manager.ts src/main/startup/create-splash-window.ts src/main/index.ts
git commit -m "refactor(app): extract shell bootstrap"
```

### Task 8: Build the Core Bootstrap and Load the Main Window Safely

**Files:**
- Create: `src/main/application/core-bootstrap.ts`
- Create: `src/main/application/core-bootstrap.test.ts`
- Modify: `src/main/application/context.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `ShellResult`, base service factories currently at `index.ts:217-234`, existing migrations, skills, sandbox, tools, RAG, Agent Runtime, channel/scheduler constructors and all IPC registration functions.
- Produces:

```ts
export interface CoreDependencies {
  shell: ShellResult;
  readiness: StartupReadiness;
  activation: WindowActivationBroker;
  shutdown: ShutdownCoordinator;
  migrateStagedExternalContent(): Promise<void>;
  initSkills(): void | Promise<void>;
  initSandbox(): void | Promise<void>;
  initPlanMode(): void;
  registerAllTools(): void;
  initRag(): Promise<void>;
  createRuntime(): AgentRuntime;
  createServices(): CoreResult["services"];
  createChannels(runtime: AgentRuntime, services: CoreResult["services"]): ChannelsSubsystem;
  createScheduler(runtime: AgentRuntime): SchedulerSubsystem;
  registerCoreIpc(input: {
    ipc: IpcScope;
    runtime: AgentRuntime;
    services: CoreResult["services"];
    channels: ChannelsSubsystem;
    scheduler: SchedulerSubsystem;
  }): void;
  loadGeneralSettings(): GeneralSettings;
  revealStartupWindows(input: RevealStartupWindowsOptions): Promise<void>;
}

export interface CoreResult {
  runtime: AgentRuntime;
  services: {
    runtimeState: ReturnType<typeof createRuntimeStateService>;
    tts: TtsSynthesisService;
    embedding: EmbeddingIndexService;
    proactive: ProactiveLifecycle;
    git: GitService;
    lsp: LspManager;
    screenshot: ScreenshotService;
    music: MusicBootstrap;
  };
  channels: ChannelsSubsystem;
  scheduler: SchedulerSubsystem;
}

export async function startCore(deps: CoreDependencies): Promise<CoreResult>;
```

- [x] **Step 1: Write failing core order tests**

```ts
it("registers every renderer IPC handler before loading chat", async () => {
  const calls: string[] = [];
  await startCore(makeCoreDeps(calls));
  expect(calls.indexOf("register-core-ipc")).toBeLessThan(calls.indexOf("chat-load"));
  expect(calls.indexOf("channels-initialize")).toBeLessThan(calls.indexOf("chat-load"));
  expect(calls).not.toContain("channels-start");
  expect(calls).not.toContain("scheduler-start");
});

it("degrades RAG failure but still loads chat", async () => {
  const deps = makeCoreDeps([]);
  vi.mocked(deps.initRag).mockRejectedValue(new Error("rag offline"));
  await expect(startCore(deps)).resolves.toBeDefined();
  expect(deps.readiness.getDegradedReasons().has("rag")).toBe(true);
  expect(deps.chat.load).toHaveBeenCalledOnce();
});

it("treats chat load failure as fatal", async () => {
  const deps = makeCoreDeps([]);
  vi.mocked(deps.shell.chat.load).mockRejectedValue(new Error("renderer failed"));
  await expect(startCore(deps)).rejects.toThrow("renderer failed");
  expect(deps.activation.markReady).not.toHaveBeenCalled();
});
```

- [x] **Step 2: Run and verify RED**

```powershell
npx vitest run src/main/application/core-bootstrap.test.ts
```

- [x] **Step 3: Move core construction from `index.ts` in exact dependency order**

```text
migrateStagedExternalContent
initSkills
create low-cost services and config getters
initSandbox with degraded logging
create Git and LSP services
init plan paths/broadcaster
registerAllTools
init RAG with degraded result
create Agent Runtime
create and initialize scheduler/channels without start
initialize screenshot/music/TTS/call/permission without heavyweight connection
register every remaining renderer IPC handler
```

Move `reconcileUserMemoryIndex`, reranker initialization, embedding refresh, MCP restore, channel start, scheduler start, screenshot prewarm and update check to Task 9.

- [x] **Step 4: Load and reveal windows**

After all IPC registration completes:

```ts
await shell.chat.load();
if (loadGeneralSettings().petVisible) {
  shell.windowManager.createPetWindow(false);
}
readiness.transition("core-ready");
await revealStartupWindows({
  splashWindow: shell.splashWindow,
  chatWindow: shell.chat.window,
  loadingShownAt: shell.loadingShownAt,
  minimumDurationMs: SPLASH_MIN_MS,
});
await activation.markReady();
```

Do not create the desktop pet at all when `petVisible` is false.

- [x] **Step 5: Register core resource ownership**

Register exact phases:

```text
stopActiveWork: Agent Runtime cancellation, TTS sessions, active screenshot capture
stopExternalConsumers: channels.shutdown
stopLocalResources: screenshot.shutdown, lsp.disposeAll, git.dispose, music.shutdown
```

Scheduler and proactive trigger are registered by background bootstrap because they are started there.

- [x] **Step 6: Run focused and feature tests**

```powershell
npx vitest run src/main/application/core-bootstrap.test.ts src/main/startup/startup-window-reveal.test.ts src/main/window-visibility-settings.test.ts src/main/music src/main/lsp src/main/code-git src/main/tts
npm run build:main
```

- [x] **Step 7: Commit**

```powershell
git add -- src/main/application/core-bootstrap.ts src/main/application/core-bootstrap.test.ts src/main/application/context.ts src/main/index.ts
git diff --cached --name-only
git commit -m "refactor(app): extract core bootstrap"
```

All IPC registration files were committed in Task 5. If the compiler exposes a missed IPC adapter, add that exact file to Task 5's commit before beginning Task 8. Confirm the user-owned dispatcher and native directory are absent from this commit.

### Task 9: Add Tracked Background Startup with MCP Timeout

**Files:**
- Create: `src/main/application/background.ts`
- Create: `src/main/application/background.test.ts`
- Create: `src/main/orchestrator/mcp-manager.test.ts`
- Modify: `src/main/application/context.ts`
- Modify: `src/main/orchestrator/mcp-manager.ts`
- Modify: `src/main/screenshot/screenshot-lifecycle.ts`
- Modify: `src/main/updater/github-app-updater.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `CoreResult`, `StartupReadiness`, `ShutdownCoordinator`, explicit channels/scheduler lifecycle.
- Produces:

```ts
export interface BackgroundDependencies {
  core: CoreResult;
  readiness: StartupReadiness;
  shutdown: ShutdownCoordinator;
  pruneRemovedMcp(signal: AbortSignal): Promise<void>;
  syncBuiltInMcp(signal: AbortSignal): Promise<void>;
  restoreMcp(signal: AbortSignal): Promise<void>;
  reconcileMemory(signal: AbortSignal): Promise<void>;
  scheduleEmbeddingRefresh(signal: AbortSignal): Promise<{ dispose(): void } | void>;
  initializeReranker(signal: AbortSignal): Promise<void>;
  prewarmScreenshot(signal: AbortSignal): Promise<void>;
  scheduleUpdateCheck(signal: AbortSignal): Promise<{ dispose(): void } | void>;
  startProactiveTrigger(signal: AbortSignal): Promise<{ dispose(): void } | void>;
}

export interface BackgroundHandle {
  settled: Promise<void>;
  stop(signal?: AbortSignal): Promise<void>;
}

export interface BackgroundTaskRunner {
  run<T>(id: string, task: (signal: AbortSignal) => Promise<T>): Promise<T>;
  stop(signal?: AbortSignal): Promise<void>;
}

export function startBackground(deps: BackgroundDependencies): BackgroundHandle;
```

Set `MCP_RESTORE_BARRIER_TIMEOUT_MS = 30_000`.

- [x] **Step 1: Write failing background dependency tests**

```ts
it("starts channels and scheduler after MCP succeeds", async () => {
  const calls: string[] = [];
  const background = startBackground(makeBackgroundDeps(calls));
  await background.settled;
  expect(calls).toEqual(expect.arrayContaining(["mcp", "channels", "scheduler"]));
  expect(calls.indexOf("mcp")).toBeLessThan(calls.indexOf("channels"));
});

it("continues after MCP barrier timeout and marks degradation", async () => {
  vi.useFakeTimers();
  const deps = makeBackgroundDeps([], { restoreMcp: () => new Promise(() => undefined) });
  const background = startBackground(deps);
  await vi.advanceTimersByTimeAsync(30_000);
  await background.settled;
  expect(deps.channels.start).toHaveBeenCalledOnce();
  expect(deps.scheduler.start).toHaveBeenCalledOnce();
  expect(deps.readiness.getDegradedReasons().has("mcp")).toBe(true);
});
```

- [x] **Step 2: Write failing cancellation and late-result tests**

```ts
it("aborts cooperative tasks and disposes resources returned after stop", async () => {
  const lateDispose = vi.fn();
  const deferred = createDeferred<{ dispose(): void }>();
  const runner = createBackgroundTaskRunner();
  const running = runner.run("late", async () => deferred.promise);
  const stopping = runner.stop();
  deferred.resolve({ dispose: lateDispose });
  await Promise.allSettled([running, stopping]);
  expect(lateDispose).toHaveBeenCalledOnce();
});
```

- [x] **Step 3: Run and verify RED**

```powershell
npx vitest run src/main/application/background.test.ts
```

- [x] **Step 4: Implement the tracked runner**

Each task receives an AbortSignal and remains in the runner map until it settles. `stop()` aborts the shared controller, prevents new tasks, waits only up to the shutdown signal, and disposes any late result exposing `dispose()`.

- [x] **Step 5: Implement background dependency groups**

```text
Group A: prune removed MCP → sync built-ins → restore MCP with 30s barrier
         → initialize/start channels → start scheduler → start proactive trigger
Group B: reconcile memory → schedule embedding refresh → initialize reranker
Group C: screenshot prewarm
Group D: schedule update check
```

Groups A–D start concurrently. Inside Group A, the arrows are strict. `settled` resolves after every group succeeds, fails, or times out, then transitions readiness to `ready`; failures update `degradedReasons` without rejecting the overall handle.

- [x] **Step 6: Add MCP AbortSignal support where possible**

Change startup restore to:

```ts
export async function initMcpManager(options: { signal?: AbortSignal } = {}): Promise<void>
```

Check `signal.aborted` before each server connect and after each awaited connect. If an underlying SDK call cannot be aborted, keep its Promise tracked and disconnect a connection that completes after shutdown.

- [x] **Step 7: Register background shutdown ownership**

```text
quiesce: BackgroundTaskRunner.stop
stopProducers: proactive trigger, scheduler, update-check timer
stopExternalConsumers: channels
stopExternalProviders: MCP manager
```

- [x] **Step 8: Run focused tests and build**

```powershell
npx vitest run src/main/application/background.test.ts src/main/orchestrator/mcp-manager.test.ts src/main/channels src/main/scheduler src/main/screenshot src/main/updater
npm run build:main
```

- [x] **Step 9: Commit**

```powershell
git add -- src/main/application/background.ts src/main/application/background.test.ts src/main/application/context.ts src/main/orchestrator/mcp-manager.ts src/main/orchestrator/mcp-manager.test.ts src/main/screenshot/screenshot-lifecycle.ts src/main/updater/github-app-updater.ts src/main/index.ts
git commit -m "refactor(app): soft start background services"
```

### Task 10: Route Update Installation and Windows Session End Through Shutdown

**Files:**
- Modify: `src/main/updater/app-update-ipc.ts`
- Modify: `src/main/updater/app-update-ipc.test.ts`
- Modify: `src/main/updater/app-update-service.ts`
- Modify: `src/main/updater/app-update-service.test.ts`
- Modify: `src/main/application/electron-lifecycle.ts`
- Modify: `src/main/application/electron-lifecycle.test.ts`
- Modify: `src/main/application/shell-bootstrap.ts`

**Interfaces:**
- Consumes: `ShutdownCoordinator.requestControlledShutdown()` and `attachWindowsSessionEndHandlers()`.
- Produces: update IPC installation handler that resolves cleanup before invoking `quitAndInstall()`, plus this service contract change:

```ts
export interface AppUpdateService {
  getState(): AppUpdateState;
  check(): Promise<AppUpdateState>;
  download(): Promise<AppUpdateState>;
  canInstall(): boolean;
  install(): boolean;
  onStateChanged(listener: (state: AppUpdateState) => void): () => void;
}

export interface UpdateLifecycleLike {
  on(event: "before-quit-for-update", listener: () => void): void;
  removeListener(event: "before-quit-for-update", listener: () => void): void;
}

export function installUpdateShutdownFallback(input: {
  updater: UpdateLifecycleLike;
  coordinator: ShutdownCoordinator;
  finalAction(): void;
}): () => void;
```

- [x] **Step 1: Write failing update coordination test**

```ts
it("completes controlled shutdown before quitAndInstall", async () => {
  const order: string[] = [];
  const ipc = createFakeIpcScope();
  const requestControlledShutdown = vi.fn(async ({ finalAction }) => {
    order.push("cleanup");
    finalAction();
  });
  const service = makeUpdateService({ install: () => { order.push("install"); return true; } });
  registerAppUpdateIpc({ service, ipc, requestControlledShutdown });
  await ipc.handlers.get(IPC.APP_UPDATE_INSTALL)?.({});
  expect(order).toEqual(["cleanup", "install"]);
});
```

- [x] **Step 2: Write failing native update fallback test**

Emit `before-quit-for-update` from a fake `autoUpdater`; assert it enters the same coordinator once. Then emit the finalizing `before-quit` from the fake Electron app; assert the app handler does not call `preventDefault()` again.

- [x] **Step 3: Run and verify RED**

```powershell
npx vitest run src/main/updater/app-update-ipc.test.ts src/main/application/electron-lifecycle.test.ts
```

- [x] **Step 4: Inject controlled shutdown into update IPC**

The `APP_UPDATE_INSTALL` handler becomes async:

```ts
ipc.handle(IPC.APP_UPDATE_INSTALL, async () => {
  if (!service.canInstall()) return false;
  await shutdown.requestControlledShutdown({
    reason: "update-install",
    finalAction: () => service.install(),
  });
  return true;
});
```

Split the existing phase check from `install()` into `canInstall()` so no installer is launched before cleanup. Register `installUpdateShutdownFallback()` against the `electron-updater` `autoUpdater` instance as the defensive path for callers outside this IPC handler.

- [x] **Step 5: Wire Windows session events on the chat shell**

In shell bootstrap, call `attachWindowsSessionEndHandlers()` immediately after creating the chat `BrowserWindow`. The emergency callback calls only registered synchronous flushers and does not stop MCP, channels, LSP, Git or music.

- [x] **Step 6: Run tests and build**

```powershell
npx vitest run src/main/updater src/main/application/electron-lifecycle.test.ts src/main/application/shutdown.test.ts src/main/application/shell-bootstrap.test.ts
npm run build:main
```

- [x] **Step 7: Commit**

```powershell
git add -- src/main/updater/app-update-ipc.ts src/main/updater/app-update-ipc.test.ts src/main/updater/app-update-service.ts src/main/updater/app-update-service.test.ts src/main/application/electron-lifecycle.ts src/main/application/electron-lifecycle.test.ts src/main/application/shell-bootstrap.ts
git commit -m "fix(app): coordinate update and windows shutdown"
```

### Task 11: Install the Thin Application Composition Root

**Files:**
- Create: `src/main/application/application.ts`
- Create: `src/main/application/application.test.ts`
- Modify: `src/main/application/context.ts`
- Rewrite: `src/main/index.ts`
- Modify: `src/main/music/bootstrap.ts`
- Modify: `src/main/music/bootstrap.test.ts`
- Modify: `src/main/music/shutdown-latch.ts`
- Modify: `src/main/music/shutdown-latch.test.ts`

**Interfaces:**
- Consumes: all previous task outputs.
- Produces:

```ts
export interface ApplicationDependencies {
  app: Pick<Electron.App, "whenReady" | "quit" | "on" | "removeListener">;
  dialog: Pick<typeof import("electron").dialog, "showErrorBox">;
  readiness: StartupReadiness;
  activation: WindowActivationBroker;
  shutdown: ShutdownCoordinator;
  prepare(): PreReadyResult;
  startShell(): Promise<ShellResult>;
  startCore(shell: ShellResult): Promise<CoreResult>;
  startBackground(core: CoreResult): BackgroundHandle;
  logFatal(error: unknown): void;
}

export interface Application {
  prepareBeforeReady(): void;
  isPrimaryProcess(): boolean;
  start(): Promise<void>;
  installLifecycleHandlers(): void;
  handleFatalStartup(error: unknown): Promise<void>;
}

export function createApplication(deps?: ApplicationDependencies): Application;
```

- [x] **Step 1: Write failing top-level lifecycle test**

```ts
it("runs shell, core, reveal, and background in order", async () => {
  const calls: string[] = [];
  const app = createApplication(makeApplicationDeps(calls));
  app.prepareBeforeReady();
  await app.start();
  expect(calls).toEqual([
    "pre-ready",
    "shell",
    "core",
    "background",
  ]);
});

it("routes fatal startup through one failed state and controlled shutdown", async () => {
  const deps = makeApplicationDeps([]);
  vi.mocked(deps.startCore).mockRejectedValue(new Error("fatal"));
  const app = createApplication(deps);
  await expect(app.start()).rejects.toThrow("fatal");
  await app.handleFatalStartup(new Error("fatal"));
  expect(deps.readiness.getPhase()).toBe("failed");
  expect(deps.shutdown.requestControlledShutdown).toHaveBeenCalledOnce();
});
```

- [x] **Step 2: Run and verify RED**

```powershell
npx vitest run src/main/application/application.test.ts
```

- [x] **Step 3: Implement application orchestration**

`createApplication()` may construct only readiness, activation, shutdown and dependency factories. `start()` stores stage results in local constants, creates a complete `ApplicationContext` only after `startBackground()` returns its handle, and exposes no context to bootstrap modules.

The final `index.ts` must be structurally equivalent to:

```ts
import { app } from "electron";
import { createApplication } from "./application/application";

const application = createApplication();
application.installLifecycleHandlers();
application.prepareBeforeReady();

if (application.isPrimaryProcess()) {
  void app.whenReady()
    .then(() => application.start())
    .catch((error) => application.handleFatalStartup(error));
}
```

- [x] **Step 4: Remove legacy global ownership**

Delete from `index.ts`:

- all business subsystem imports;
- top-level service construction;
- mutable tray/scheduler/channels/screenshot/window/LSP/Git variables;
- direct IPC registration;
- direct `before-quit` cleanup;
- direct `activate` and second-instance window opening;
- splash timing and reveal logic.

Keep all behavior in the explicit application modules.

`handleFatalStartup()` must execute exactly once: transition to `failed`, write the structured error log, close Loading if it exists, show `dialog.showErrorBox("Cyrene 启动失败", message)`, then request controlled shutdown with `app.quit()` as the final action.

- [x] **Step 5: Retire the independent music shutdown latch**

Music remains lazy through `bootstrapMusicService()`. Register `musicBootstrap.shutdown` in `stopLocalResources`; remove the production call to `installShutdownLatch`. Keep or replace its tests with an assertion that music shutdown is owned by the central coordinator. Delete `shutdown-latch.ts` only after `rg "installShutdownLatch" src` returns no production references.

- [x] **Step 6: Run application tests and build**

```powershell
npx vitest run src/main/application src/main/index.test.ts src/main/music src/main/single-instance.test.ts src/main/startup src/main/windows
npm run build:main
```

Also run:

```powershell
rg -n "ApplicationContext" src/main/application/*-bootstrap.ts src/main/application/pre-ready.ts src/main/application/background.ts
```

Expected: no bootstrap module receives or imports `ApplicationContext`; only `application.ts` constructs and retains it.

- [x] **Step 7: Verify structural acceptance**

```powershell
(Get-Content -LiteralPath 'src/main/index.ts').Count
rg -n "createAgentRuntime|register.*Ipc|new LspManager|createWindowManager|before-quit|let (tray|scheduler|channels|screenshot|windowManager|lspManager|codeGit)" src/main/index.ts
```

Expected: line count is at most 30; `rg` returns no matches.

- [x] **Step 8: Commit the cutover**

```powershell
git add -- src/main/application src/main/index.ts src/main/music/bootstrap.ts src/main/music/bootstrap.test.ts src/main/music/shutdown-latch.ts src/main/music/shutdown-latch.test.ts
git diff --cached --name-only
git commit -m "refactor(app): install thin main process composition root"
```

### Task 12: Full Regression, Packaged Smoke Test, and Cleanup

**Files:**
- Modify only files required by failures found in this task.
- Update: `docs/design/2026-08-30-main-process-composition-root-redesign.md` only if the implementation intentionally differs from the approved interface.
- Update: `docs/design/2026-08-30-main-process-composition-root-construction-plan.md` checkbox state during execution.

**Interfaces:**
- Consumes: completed application composition root.
- Produces: verified build with no legacy startup path.

- [x] **Step 1: Search for legacy ownership and untracked async startup**

```powershell
rg -n "installShutdownLatch|void initChannels|void screenshotService\.prewarm|app\.on\(\"before-quit\"|createReactChatWindow\(\).*load" src/main
rg -n "void (init|start|initialize|prewarm|restore)" src/main/application src/main/index.ts
```

Expected: no old composition-root startup or independent music latch remains. Any intentional `void` must be owned inside `BackgroundTaskRunner` and documented next to the call.

- [x] **Step 2: Run the complete test suite**

```powershell
npm test
```

Expected: all test files and tests pass with exit code 0; count is at least the 345-file/2712-test baseline.

- [x] **Step 3: Run all builds**

```powershell
npm run build:main
npm run build:preload
npm run build:renderer
```

Expected: every command exits with code 0.

- [ ] **Step 4: Create a Windows unpacked package**

```powershell
npm run package:win:dir
```

Expected: Electron Builder completes and produces `release/win-unpacked/Cyrene.exe`.

- [ ] **Step 5: Perform packaged startup smoke cases**

Run these cases and record the result in the execution summary:

1. Set `petVisible=false`, quit, relaunch: no pet appears or flashes; chat opens after Loading.
2. Set `petVisible=true`, quit, relaunch: pet appears only after core IPC is ready.
3. During Loading, click tray “打开聊天窗口”: Loading receives focus; chat does not appear before `mainWindowActivationReady`.
4. During Loading, launch a second instance: one pending activation is consumed after readiness.
5. Make MCP unavailable: chat still opens; channels start after the 30-second barrier and health is degraded.
6. Trigger update installation in a test build with a downloaded update: controlled cleanup finishes before installer launch.
7. Trigger Windows sign-out or restart in a disposable test session: emergency token-usage flush runs without waiting for external services.

- [x] **Step 6: Review the final diff**

```powershell
git status --short
git diff --check
git diff --stat 343708a..HEAD
git log --oneline --decorate -15
```

Confirm:

- `src/main/channels/dispatcher.ts` user changes remain uncommitted and intact;
- `native/cyrene-gamebot/` remains outside these commits;
- no IPC channel string or persisted data schema changed;
- `src/main/index.ts` is at most 30 lines.

- [ ] **Step 7: Restart verification after any regression fix**

If Step 2–6 finds a failure, stop this task, return to the task that owns the failing module, add a focused regression test, apply the minimal fix, run that task's focused command, and commit using that task's exact path list. Then restart Task 12 from Step 1. If no failure occurs, do not create an empty commit.
