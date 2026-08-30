# **Electron（跨平台桌面应用框架）**主进程应用组合根重构方案

> 状态：设计稿 v2，已确认定稿方向
>
> 日期：2026-08-30
>
> 性质：架构重构，不增加新功能
>
> 目标文件：`src/main/index.ts`
>
> 行为基线：`343708a fix(app): respect pet visibility and promote chat window`
>
> v1 设计提交：`bb4a88b docs(app): design phased main-process composition root`

## 1. 目标

把 `src/main/index.ts` 从同时负责实例化、启动、窗口、后台任务和退出清理的“大入口”，收敛为 15～30 行的 **Composition Root（应用组合根）**入口；业务行为保持不变，并让启动顺序、软启动、降级和退出等待都可以独立测试。

本次重构完成后：

- 聊天窗口是主交互窗口；桌宠是受设置控制的可选窗口。
- 现有 **Loading（启动加载页）**继续复用，并尽早显示。
- 用户能进入聊天所必需的能力直接启动；不影响首屏的能力软启动或按需启动。
- 后台能力失败时有明确降级状态，不再靠散落、无人持有的异步任务静默失败。
- 退出时统一等待异步清理，避免资源残留或数据未落盘。
- Windows 系统关机、重启或注销时执行极短的关键数据落盘，不依赖常规退出事件。

## 2. 约束与非目标

### 2.1 约束

1. 冻结新功能开发，只做架构重构和缺陷修复。
2. 保持现有 **IPC（进程间通信）**频道名称及渲染进程调用契约不变。
3. 保持设置、聊天、桌宠、托盘、协议唤起和单实例行为不变。
4. 优先复用仓库已有的 `bootstrap` 模块、Electron 生命周期和 Loading 页面。
5. 每一个迁移步骤都必须可验证，最终切换不保留两套并行启动路径。

### 2.2 非目标

- 不重写 **Agent（智能体）**、工具、记忆、音乐、频道或调度器的业务实现。
- 不改变渲染层页面结构和视觉设计。
- 不引入新的 **Dependency Injection（依赖注入）**框架。
- 不借重构改变产品功能、默认设置或用户数据格式。
- 不把 `Application` 再做成新的万能上帝类。

## 3. 现状与问题

当前 `src/main/index.ts` 约有：

- 607 行代码；
- 96 个导入声明；
- 7 个顶层可变变量；
- 多处顶层服务构造、IPC 注册和未跟踪异步任务。

它混合承担了以下职责：

| 职责 | 当前问题 |
| --- | --- |
| Electron 就绪前配置 | 与业务服务导入、构造混在一起，边界不清晰 |
| 服务实例化 | 顶层构造导致依赖顺序隐式化，测试必须加载大量真实模块 |
| IPC 注册 | 基础 IPC、运行时 IPC 和功能 IPC 没有分层 |
| 窗口创建 | Loading、聊天、桌宠和托盘的显示条件分散 |
| 启动编排 | 同步、阻塞异步和后台任务混排，依赖关系靠代码位置表达 |
| 错误处理 | 有的抛出、有的记录、有的 `void`，无法统一判断是否可用 |
| 退出清理 | `before-quit` 中多数异步清理未被 Electron 等待 |

已确认的具体风险：

1. `createChannelsSubsystem()` 内部会立即异步初始化频道，但频道注释要求在 **RAG（检索增强生成）**和 **MCP（模型上下文协议）**之后启动；当前顺序不满足这一依赖。
2. Loading 创建得较晚，前面的迁移、工具、技能、音乐和协议等工作全部不可见。
3. MCP 配置恢复、RAG 初始化等非首屏能力会阻塞后续窗口呈现。
4. 主动服务和触发器启动过早，运行时依赖未形成明确屏障。
5. `before-quit` 中频道、截图、**LSP（语言服务器协议）**和 **Git（分布式版本控制系统）**等清理使用未等待的异步调用，进程可能先退出。
6. `app.whenReady().then(async ...)` 缺少统一的顶层失败出口。
7. 当前 `index.test.ts` 实际没有覆盖入口生命周期，只覆盖了单个 MCP 同步工具。
8. `createReactChatWindow()` 会立即加载渲染页面；如果重构后窗口早于核心 IPC 注册，渲染进程会遇到“没有已注册处理器”的竞态。
9. 托盘、第二实例、协议唤起和应用激活当前可以直接创建或显示窗口，缺少统一的启动就绪门禁。
10. Windows 系统关机、重启或注销不会触发常规 `before-quit`、`will-quit` 和 `quit` 事件，退出落盘不能只依赖 `before-quit`。
11. 后台任务并行启动后，清理函数的注册顺序取决于完成速度，不能代表资源依赖的逆序。

## 4. 方案选择

### 4.1 采用：分阶段函数式组合根

采用“薄入口 + 显式上下文 + 分阶段启动 + 统一退出”的函数式结构。

选择理由：

- 与仓库现有的 `scheduler/bootstrap.ts`、`channels/bootstrap.ts`、`music/bootstrap.ts` 和 `startup/bootstrap-config.ts` 风格一致，可直接复用。
- 依赖关系通过函数参数和阶段返回值表达，便于替换假实现并测试。
- 不需要新的运行时容器，不增加装饰器、反射或隐式解析。
- 允许一次性替换组合根，同时把内部迁移拆成可验证的小步骤。

### 4.2 不采用：单一 **Application（应用程序）**大类

生命周期类能减少全局变量，但如果所有服务和步骤都塞进一个类，只是把 600 行 `index.ts` 搬到 `application.ts`，不会真正改善职责边界。

### 4.3 不采用：第三方 **DI（依赖注入）**容器

**InversifyJS（依赖注入库）**、**Awilix（依赖注入库）**等成熟方案能提供依赖解析，但当前问题主要是启动编排，不是大规模可替换服务图。引入容器会增加运行时魔法、类型适配和维护成本，收益低于显式工厂函数。

因此只保留少量项目自身的胶水层，不重复实现通用容器能力。

## 5. 总体架构

```text
src/main/index.ts
        │
        ▼
createApplication()
        │
        ├── prepareBeforeReady() ── Electron 就绪前配置
        │
        ├── start()
        │      ├── startShell() ───── Loading / 基础 IPC / 未加载页面的窗口壳
        │      ├── startCore() ────── 核心能力 / 完整 IPC / 加载聊天页面
        │      └── startBackground() ─ 后台恢复 / 预热 / 索引
        │
        ├── 窗口激活代理 ─────────── 托盘 / 第二实例 / 协议 / activate
        │
        └── installLifecycleHandlers()
                         ├── 受控退出
                         └── 紧急落盘

只有 application.ts 持有完整应用上下文；各阶段只接收窄依赖并返回阶段结果。
```

设计后的入口只表达生命周期，不知道任何业务子系统细节：

```ts
const application = createApplication();

application.prepareBeforeReady();

if (application.isPrimaryProcess()) {
  app.whenReady()
    .then(() => application.start())
    .catch((error) => application.handleFatalStartup(error));
}

application.installLifecycleHandlers();
```

## 6. 模块划分

```text
src/main/
├── index.ts
└── application/
    ├── application.ts       # 对外生命周期门面，仅负责阶段编排
    ├── context.ts           # 完整运行上下文类型，仅供编排器组装
    ├── pre-ready.ts         # Electron ready 之前允许执行的配置
    ├── shell-bootstrap.ts   # Loading、基础 IPC、协议、窗口、托盘
    ├── core-bootstrap.ts    # 迁移、技能、本地工具、RAG、智能体运行时
    ├── background.ts        # MCP、频道、调度、索引、预热、更新
    ├── window-activation.ts # 启动期主窗口激活门禁
    ├── readiness.ts         # 生命周期阶段、健康状态和等待屏障
    └── shutdown.ts          # 受控退出、紧急落盘和固定清理阶段
```

### 6.1 各模块职责

| 模块 | 允许做的事 | 禁止做的事 |
| --- | --- | --- |
| `index.ts` | 创建应用、绑定 Electron 生命周期 | 导入或构造业务服务 |
| `application.ts` | 按顺序调用阶段，处理顶层失败 | 实现任何子系统业务 |
| `context.ts` | 定义完整运行上下文；只供 `application.ts` 组装 | 被各启动模块当作服务定位器传递 |
| `pre-ready.ts` | 执行 Electron 要求的就绪前配置 | 创建窗口或访问就绪后 **API（应用程序接口）** |
| `shell-bootstrap.ts` | 建立最小可见外壳 | 启动重型后台能力 |
| `core-bootstrap.ts` | 建立聊天可用所需能力 | 恢复非必要远端连接 |
| `background.ts` | 按依赖启动并跟踪后台任务 | 阻塞 Loading 关闭 |
| `window-activation.ts` | 合并启动期窗口激活请求 | 绕过核心就绪状态直接显示功能窗口 |
| `readiness.ts` | 发布生命周期阶段和独立健康状态 | 直接操纵窗口 |
| `shutdown.ts` | 固定阶段清理、总超时和紧急落盘 | 依据异步任务完成顺序决定清理顺序 |

## 7. **ApplicationContext（应用上下文）**设计

`ApplicationContext` 是应用完全组装后的内部记录，只允许 `application.ts` 持有。各启动模块不能接收完整上下文，避免退化为 **Service Locator（服务定位器）**：

```ts
interface ApplicationContext {
  base: BaseServices;
  shell: ShellResult;
  core: CoreResult;
  background: BackgroundHandle;
  readiness: StartupReadiness;
  shutdown: ShutdownCoordinator;
}
```

阶段间通过窄输入和不可变结果衔接：

```ts
const shell = await startShell({ settings, activation, readiness, shutdown });
const core = await startCore({ shell, toolRegistry, readiness, shutdown });
const background = startBackground({ runtime: core.runtime, readiness, shutdown });
```

关键规则：

1. 只有 `application.ts` 能持有完整 `ApplicationContext`；启动模块只能接收自身所需的窄依赖。
2. 启动过程中使用局部阶段结果；完整上下文只在组装成功后生成，不使用大量可选字段或非空断言模拟生命周期。
3. 顶层不再保留可变服务变量；已创建资源立即把清理函数注册到明确的退出阶段，因此中途失败也能清理。
4. 所有进入应用编排层的 `createXxx()` 工厂只能构造，禁止隐式启动、连接或创建长期任务。
5. 有副作用或先决条件的子系统必须暴露显式 `start()`、`initialize()` 或 `load()`，并由对应启动阶段调用。
6. 阶段返回创建结果，业务模块不能自行跨阶段启动另一个子系统。
7. `runtimeStateService` 继续表示 Agent 执行状态；新的 `StartupReadiness` 只表示应用生命周期和能力健康度，两者不混用。

## 8. 启动分层

### 8.1 阶段定义

| 阶段 | 用户可见 | 是否阻塞 Loading | 主要内容 |
| --- | --- | --- | --- |
| `preReady` | 否 | 是 | 单实例、协议权限、**GPU（图形处理器）**参数和沙箱权限 |
| `shellReady` | Loading | 是 | 设置、基础 IPC、协议、窗口壳、激活代理、托盘 |
| `coreReady` | Loading → 聊天 | 是 | 数据迁移、技能、本地工具、RAG、完整 IPC、加载功能页面 |
| `backgroundReady` | 聊天已可用 | 否 | MCP、频道、调度、记忆索引、预热、更新检查 |
| `onDemand` | 仅请求时 | 否 | 音乐后端、LSP 服务、Git 监听、语音合成与识别连接 |

这里的“阶段完成”表示该阶段的任务已经成功或明确降级，而不是要求每个可选能力都成功。

### 8.2 `preReady`：必须立即同步执行

执行内容：

1. 配置文档索引队列的进程级参数。
2. 获取单实例锁；非主实例立即退出。
3. 注册特权协议 **Scheme（协议方案）**。
4. 设置 GPU 和 **Chromium（浏览器内核）**启动参数。
5. 尝试修复 GPU 沙箱访问控制列表；失败只记录告警，不阻止启动。

此阶段必须保持小、同步、无业务服务构造，因为 Electron 要求相关操作发生在 `ready` 之前。

### 8.3 `shellReady`：尽早出现 Loading

执行顺序：

1. 初始化日志和启动计时。
2. 立即复用 `src/renderer/public/splash.html` 创建并显示 Loading；实际调用 `show()` 后记录 `loadingShownAt`。
3. 创建设置、缓存和窗口管理所需的轻量服务。
4. 注册设置、窗口、聊天存储等基础 IPC。
5. 注册应用协议和文档打开队列。
6. 创建隐藏的 **BrowserWindow（浏览器窗口）**对象作为聊天窗口壳，但禁止调用 `loadURL()` 或 `loadFile()`。
7. 创建 **WindowActivationBroker（窗口激活代理）**，接管托盘、第二实例、协议唤起和 `activate`。
8. 创建托盘；所有功能窗口入口必须经过激活代理，退出菜单仍可立即使用。

`shellReady` 不加载聊天、桌宠、设置、侧边栏等功能页面。启动期间收到窗口激活请求时：

```text
requestWindowActivation(kind)
        │
        ├── mainWindowActivationReady ── 是 ── 创建或显示目标窗口
        │
        └── 否 ────────────────────────────── 合并为一个待处理请求，并聚焦 Loading
```

主窗口可激活后只消费最新的等价请求，避免第二实例、协议和托盘重复创建窗口。桌宠不接受通用主窗口激活请求。

Loading 只负责启动反馈，不重新实现一套 **React（前端界面库）**页面，也不复用音乐播放器内部的 `LoadingScreen`。后者属于音乐渲染树，强行共享会引入额外打包和路由依赖。

### 8.4 `coreReady`：聊天可用的最小核心

执行内容及顺序：

1. 完成外部内容和配置迁移。
2. 扫描技能与提示词。
3. 初始化沙箱，再注册本地工具。
4. 创建计划路径和运行广播器。
5. 初始化 RAG；失败时记录降级，聊天仍允许启动。
6. 创建 **Agent Runtime（智能体运行时）**。
7. 构造频道、调度器等后台子系统并注册其 IPC，但不调用 `start()`。
8. 注册所有聊天渲染进程可能调用的 IPC；后台能力未就绪时，处理器本身必须已存在并执行就绪门禁。
9. 调用聊天窗口壳的显式 `load()`，等待 `loadURL/loadFile` 成功。
10. 同时监听主框架的 `did-fail-load`，并为 `ready-to-show` 设置有限超时。
11. 仅当桌宠设置开启时，在桌宠 IPC 已注册后创建并加载桌宠窗口。
12. 推进到 `coreReady`，但窗口激活代理仍保持关闭。
13. 等待最短展示剩余时长，然后关闭 Loading 并显示聊天窗口。
14. 标记 `mainWindowActivationReady`，再消费待处理的窗口激活请求。

最短展示时长必须按剩余时间计算：

```ts
const elapsedSinceSplashShown = monotonicNowMs() - loadingShownAt;
const remaining = Math.max(0, minimumDurationMs - elapsedSinceSplashShown);
```

这样既避免闪烁，也不会在核心已经耗时很久后额外完整等待一次。

### 8.5 `backgroundReady`：不阻塞首屏的软启动

后台任务必须交给统一的 **BackgroundTaskRunner（后台任务运行器）**跟踪。它负责记录开始、结束、失败和中止请求；禁止直接写无人持有的 **Promise（异步结果对象）**，例如 `void someAsyncTask()`。

`BackgroundTaskRunner` 为每项任务提供 **AbortSignal（中止信号）**，采用协作式取消：

- 支持 AbortSignal 的底层操作必须及时停止并释放部分资源。
- 不支持 AbortSignal 的操作只能标记为“不再等待并禁止启动后继任务”，不能宣称已经取消。
- 不可取消任务若在退出后才完成，运行器必须立即执行其返回的清理函数，禁止产生无所有者资源。

依赖关系如下：

```text
coreReady
   │
   ├── MCP 清理 / 内置配置同步 / 已启用连接恢复尝试
   │          │
   │          └── 成功 / 失败 / 超时后形成已结算结果
   │                     ├── 频道初始化
   │                     │      └── 主动触发器
   │                     └── 调度器启动
   │
   ├── 记忆协调 / 向量索引 / 重排序器预热
   ├── 截图服务预热
   └── 更新检查
```

其中 **Embedding（向量嵌入）**索引和 **Reranker（重排序器）**失败只影响检索质量；MCP 或频道失败只影响对应外部能力。所有失败都进入 `degradedReasons`，但不会重新打开 Loading 或关闭聊天窗口。

MCP 连接恢复可以并发，但要设置合理并发上限和总超时，避免同时拉起过多子进程或永久阻塞频道。屏障等待的是“恢复尝试已结算”：成功、明确失败或超时后，频道与调度器都可以继续启动。超时不会让底层任务失去所有权；应优先向管理器传递 AbortSignal，暂不支持取消时继续跟踪其迟到结果并在退出状态下立即清理。优先复用现有管理器，不另造连接池。

### 8.6 `onDemand`：保持现有按需语义

当前代码已经具备以下延迟行为，本次只保持并重新归位，不改变启动语义：

- 音乐后端：首次打开音乐或调用音乐能力时启动。
- LSP：首次打开代码会话或请求语言服务时启动具体服务进程。
- Git：服务对象可预先存在，但仓库监听只在打开仓库后启动。
- **TTS（文本转语音）**和 **ASR（自动语音识别）**：首次语音请求时连接。

如果某个能力在实施核验中被发现当前并非延迟启动，本次按原有行为迁移，并记录为后续独立优化；不得在组合根重构中顺手改变。已有的并发首次调用、初始化 Promise 缓存和失败重试策略均保持不变。

## 9. 窗口职责

### 9.1 主窗口

聊天窗口是应用主窗口，负责：

- 作为托盘“显示主窗口”的最终目标；
- 作为第二实例和协议唤起的最终目标；
- 作为 **macOS（苹果桌面操作系统）**的 `activate` 等标准应用激活行为的最终目标；
- 在核心就绪后成为 Loading 的下一可见界面。

上述入口不直接调用聊天窗口，全部先进入窗口激活代理。

### 9.2 桌宠窗口

桌宠是独立可选能力：

- 设置关闭时，启动阶段不得创建后又隐藏，更不得先闪现。
- 设置开启且桌宠 IPC 已注册后才创建；运行中开关负责创建、显示或隐藏。
- 桌宠关闭或隐藏不影响聊天窗口生命周期。
- 桌宠不能再作为通用的 `mainWindow` 被其他模块隐式依赖。

### 9.3 Loading 窗口

Loading 是一次启动会话的临时窗口：

- `shellReady` 开始时尽快显示。
- 只由启动编排器关闭。
- 关闭条件是 `coreReady`、聊天窗口可展示、最短时长满足。
- 如果 Loading 创建失败，则不应用最短展示时长，直接以聊天核心就绪条件继续。
- 后台能力失败不延长 Loading。
- 核心致命失败时，Loading 关闭后显示错误并退出。

### 9.4 窗口激活代理

`WindowActivationBroker` 是所有功能窗口激活请求的唯一入口：

- `coreReady` 之前不加载功能页面；`mainWindowActivationReady` 之前不显示功能页面，只聚焦 Loading 并合并待处理请求。
- `mainWindowActivationReady` 由核心就绪、聊天页面可展示和 Loading 最短展示时长共同决定。
- `mainWindowActivationReady` 之后把请求交给 `WindowManager`。
- 第二实例携带的协议或会话参数必须保留到待处理请求中。
- 重复的“打开聊天”请求只保留一个；带不同会话参数的请求按现有业务语义保留最新值。
- 应用进入 `stopping` 后拒绝新激活请求。

## 10. **Readiness（就绪状态）**与错误模型

### 10.1 生命周期阶段与健康状态

`StartupReadiness` 将生命周期 `phase` 与 **health（健康状态）**分开：

```ts
type StartupPhase =
  | "preparing"
  | "shell-ready"
  | "core-ready"
  | "background-starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";

interface StartupReadiness {
  phase: StartupPhase;
  degradedReasons: Map<CapabilityId, DegradedReason>;
}
```

`degraded` 不是生命周期阶段。应用可以处于 `ready`，同时 MCP 或 RAG 降级；能力恢复后可以移除对应原因而无需倒退生命周期。`isDegraded` 由 `degradedReasons.size > 0` 派生。

生命周期只能由应用编排器推进；子系统通过返回结果报告成功、降级或恢复，不能自行修改 `phase`。

`mainWindowActivationReady` 是由核心、页面加载和 Loading 时长共同完成的一次性等待屏障，不是新的生命周期阶段，也不写入 `phase`。

### 10.2 致命与可降级边界

| 失败点 | 处理 |
| --- | --- |
| 获取不到单实例锁 | 正常退出当前实例，不视为故障 |
| GPU 权限修复失败 | 记录告警，继续 |
| 设置读取损坏 | 复用现有默认值/恢复策略，记录降级 |
| Loading 创建失败 | 记录告警，继续尝试创建聊天窗口 |
| 聊天窗口创建失败 | 致命：显示错误并退出 |
| 聊天页面 `loadURL/loadFile` 失败 | 致命：页面不可用，显示错误并退出 |
| 聊天页面 `ready-to-show` 超时 | 致命：结束等待，显示错误并退出 |
| 基础 IPC 无法注册 | 致命：应用无法正常交互 |
| Agent Runtime 无法创建 | 致命：核心聊天不可用 |
| 技能、RAG 或单个本地工具失败 | 记录降级，聊天继续可用 |
| MCP、频道、调度、索引、截图预热失败或超时 | 记录降级，聊天继续可用 |
| 更新检查失败 | 仅记录日志 |

顶层致命错误统一执行：结构化日志 → 关闭 Loading → Electron 原生错误框 → 请求退出。禁止在各阶段重复实现退出逻辑。

## 11. 统一退出

新增 `ShutdownCoordinator`，吸收并推广音乐模块现有 **shutdown latch（退出闩锁）**的可靠等待思路，不引入第三方生命周期库。退出分为 **Controlled Shutdown（受控退出）**与 **Emergency Flush（紧急落盘）**两个等级。

### 11.1 受控退出

适用于用户退出、`app.quit()`、更新安装和启动致命失败：

1. 所有入口调用同一个 `requestControlledShutdown(reason, finalAction)`；`before-quit` 只作为兜底入口。
2. 第一次进入时推进到 `stopping`，后续请求复用同一个 Promise。
3. 阻止默认退出，拒绝新的 Agent 运行、窗口激活、按需初始化和后台任务。
4. 按固定清理阶段顺序执行；同一阶段内使用 `Promise.allSettled()` 并行，单项失败不跳过后续阶段。
5. 设置总超时，记录未完成的阶段与资源。
6. 标记 `stopped`，切换到 `finalizing`，解除退出拦截并执行最终动作；最终动作触发的事件不得再次拦截退出。

固定清理阶段如下：

| 清理阶段 | 目标资源 |
| --- | --- |
| `quiesce` | 中止后台启动、拒绝新工作、停止窗口激活 |
| `stopProducers` | 主动触发器、调度器、更新检查定时器 |
| `stopActiveWork` | Agent 运行、TTS 会话、截图捕获等进行中任务 |
| `stopExternalConsumers` | 频道和其他消费 MCP 能力的外部接入 |
| `stopExternalProviders` | MCP 连接和子进程 |
| `stopLocalResources` | 截图辅助进程、LSP、Git 监听、音乐后端、窗口管理器 |
| `flushPersistence` | 令牌用量和其他必要持久化状态 |

清理函数注册时必须声明阶段；不使用“反向注册顺序”等价替代资源依赖顺序。每个清理函数都必须幂等，并接受剩余超时或 AbortSignal。

### 11.2 Windows 紧急落盘

Windows 系统关机、重启或用户注销时，Electron 不保证触发应用级常规退出事件。因此聊天主窗口及其替代实例统一绑定：

- `query-session-end`：立即执行同步、幂等、极短的关键数据落盘；通常不阻止用户关机。
- `session-end`：再次调用同一个紧急落盘函数作为兜底，不能阻止系统退出。

紧急落盘不等待网络、不优雅关闭所有子进程、不执行完整受控退出。重要数据必须在运行期间增量、原子持久化，紧急落盘只缩小最后一次防抖尚未写入的窗口，不能成为唯一保存机制。

### 11.3 更新安装

项目使用 **electron-updater（Electron 自动更新库）**。更新 IPC 不能直接调用 `quitAndInstall()`，而应：

1. 请求受控退出并完成可等待清理。
2. 把 `quitAndInstall()` 作为 `finalAction` 执行。
3. 同时监听 Electron `autoUpdater` 的 `before-quit-for-update` 作为防御性兜底，保证外部路径直接触发更新时仍能进入同一个幂等协调器。

不得假设更新安装与普通 `app.quit()` 具有相同窗口关闭顺序。

## 12. IPC 注册策略

IPC 按可用时机拆分，但公开契约不变：

1. 基础 IPC：设置、窗口、聊天存储、应用信息等，在 `shellReady` 注册。
2. 核心 IPC：Agent 运行、工具调用、计划等，在依赖创建后、加载聊天页面之前注册。
3. 功能 IPC：音乐、代码、Git、截图等在加载聊天页面之前注册轻量处理器，由处理器保持现有按需行为。
4. 后台相关 IPC：处理器本身必须在加载聊天页面前存在；后台能力尚未完成时，内部等待对应 readiness 或返回可识别的暂不可用状态。
5. 只有确认所有聊天渲染进程可能调用的处理器均已注册后，编排器才允许调用聊天窗口的 `load()`。

每个注册函数返回 **disposer（注销函数）**；测试和退出可显式移除 IPC 处理器，避免重复注册污染。

## 13. 测试设计

### 13.1 单元测试

新增对应用编排层的测试，所有 Electron 和子系统依赖使用假实现：

1. `preReady` 必须发生在 `app.whenReady()` 之前。
2. 启动阶段严格按 `shell → core → background` 推进。
3. 聊天 `BrowserWindow` 可以先创建，但核心 IPC 注册完成前不得调用 `loadURL/loadFile`。
4. Loading 在核心就绪前保持，在核心就绪和窗口可展示后关闭。
5. Loading 最短时长从 `loadingShownAt` 计算剩余时长，不重复完整等待。
6. 设置关闭桌宠时，启动过程中不创建/显示桌宠。
7. 第二实例、托盘、协议和应用激活在 `mainWindowActivationReady` 前只形成待处理请求并聚焦 Loading。
8. 即使已经 `coreReady`，Loading 最短展示时长结束前也不能通过激活入口提前显示聊天窗口。
9. `mainWindowActivationReady` 后只消费一次等价的待处理激活请求。
10. 聊天页面加载失败或 `ready-to-show` 超时进入 `failed`，只触发一次退出。
11. 频道只在核心完成且 MCP 恢复尝试成功、失败或超时后启动。
12. MCP 超时不会遗留无所有者的迟到任务或子进程。
13. 生命周期可以是 `ready`，同时健康状态包含降级原因；能力恢复只修改健康状态。
14. AbortSignal 能中止支持协作取消的后台任务；不支持取消的任务被准确标记并继续受所有权跟踪。
15. 受控退出按固定阶段执行，同阶段并行，顺序不受任务启动完成速度影响。
16. Windows 会话结束只执行幂等紧急落盘，不进入慢速完整清理。
17. 更新安装先完成受控退出，再调用 `quitAndInstall()`。

### 13.2 集成与冒烟测试

- 运行现有主进程测试和完整测试集。
- 运行主进程 **TypeScript（类型脚本语言）**构建。
- **Windows（微软桌面操作系统）**开发版冷启动：桌宠开/关各一次。
- Windows 打包版冷启动：桌宠关闭后重启，不得闪现或残留。
- MCP 不可用、RAG 初始化失败、频道配置错误各进行一次降级启动。
- MCP 恢复永久不返回时，频道仍须在屏障超时后启动并标记降级。
- 应用启动中退出、正常运行后退出、安装更新退出各进行一次固定阶段清理验证。
- Windows 测试环境执行一次系统注销或重启，确认紧急落盘路径被调用。

当前行为基线是 345 个测试文件、2712 个测试通过；重构不得降低此基线。

## 14. 实施顺序

虽然最终接受一次性重写整个应用组合根，实施仍按以下顺序保持每步可回归；最终只保留新路径，不做长期双轨：

1. 补入口阶段顺序、Loading、窗口激活和退出行为的特征测试。
2. 把 `createChannelsSubsystem()` 等隐式自启动工厂改为显式 `create + start`，先建立组合根不变量。
3. 提取 `pre-ready.ts`。
4. 提取 `shutdown.ts`，同时纳入 Windows 会话结束和更新安装语义。
5. 建立简单 `StartupReadiness`，分离生命周期阶段与健康状态。
6. 提取 `shell-bootstrap.ts` 和 `window-activation.ts`，解决渲染页面加载与 IPC 注册竞态。
7. 提取 `core-bootstrap.ts`，把完整 IPC、页面加载和 Agent Runtime 放到明确屏障内。
8. 提取 `background.ts`，修正 MCP → 频道/调度器顺序，并加入超时和 AbortSignal。
9. 原样迁移音乐、LSP、Git、TTS/ASR 的现有延迟行为，不做新的启动优化。
10. 将 `index.ts` 切换到新组合根，删除旧启动路径、死导入和顶层可变变量。
11. 运行完整验证和 Windows 打包版冒烟测试。

每一步只做搬迁、依赖显式化或已确认缺陷修复，不顺带增加功能。

## 15. 验收标准

必须同时满足：

- `src/main/index.ts` 不超过 30 行，且不直接导入业务子系统。
- 入口不存在业务服务顶层构造和可变运行句柄。
- 完整 `ApplicationContext` 只在 `application.ts` 可见；启动模块使用窄依赖和阶段结果。
- `createXxx()` 工厂无隐式启动、连接或长期异步副作用。
- 所有启动任务属于明确阶段，所有后台 Promise 都被跟踪。
- 聊天页面只在全部可调用 IPC 处理器注册后加载。
- 启动期所有功能窗口激活请求经过统一代理，在 `mainWindowActivationReady` 前不能提前显示功能页面。
- 频道在核心就绪且 MCP 恢复尝试成功、失败或超时后才启动。
- Loading 尽早显示，并从实际显示时间计算最短展示剩余时长。
- 聊天窗口是唯一主交互窗口；桌宠完全服从可见性设置。
- 生命周期阶段与健康降级状态互相独立。
- 可选能力失败可降级；页面加载失败、页面就绪超时或核心失败有唯一顶层出口。
- 受控退出按固定阶段等待，过程幂等且有总超时。
- Windows 会话结束具有独立的同步紧急落盘路径，关键数据不只在退出时保存。
- 更新安装先进入退出协调器，再执行 `quitAndInstall()`。
- 音乐、LSP、Git、TTS/ASR 保持当前延迟启动语义，不引入额外行为变化。
- IPC 公开频道和用户数据格式不变。
- 完整测试、主进程构建和打包版冒烟测试通过。

## 16. 风险与回滚

| 风险 | 控制措施 |
| --- | --- |
| 搬迁时改变隐式初始化顺序 | 先写阶段顺序特征测试，再移动代码 |
| IPC 注册晚于渲染进程调用 | 核心 IPC 全部注册后才加载聊天页面；后台 handler 预注册并在内部门禁 |
| 启动期激活绕过 Loading | 托盘、第二实例、协议和 activate 统一经过窗口激活代理 |
| 上下文变成服务定位器 | 完整上下文仅限 `application.ts`，启动模块使用窄参数和阶段结果 |
| 软启动造成首次调用竞争 | 每项按需初始化缓存同一个 Promise |
| 后台失败难以发现 | 统一记录任务名、耗时、错误和降级原因 |
| MCP 恢复永久等待 | 恢复屏障总超时 + 协作取消 + 迟到资源继续受所有权管理 |
| 并行启动打乱清理顺序 | 使用固定清理阶段，同阶段并行，不依赖注册先后 |
| 退出等待导致卡住 | 单项错误隔离 + 总超时 + 未完成阶段日志 |
| Windows 系统退出不触发常规事件 | 运行期持续持久化 + 窗口会话结束紧急落盘 |
| 一次性切换回归范围大 | 小步骤实现并保持测试绿色，最后一次切换入口 |

若最终入口切换后出现不可接受回归，回滚整个组合根提交即可；用户数据迁移和 IPC 契约在本设计中不发生变化，因此不需要数据回滚。

## 17. 已确定的设计决策

1. 复用现有 `splash.html`，不新造 Loading 组件。
2. 聊天窗口是主窗口，桌宠是独立可选窗口。
3. Loading 只等到 `coreReady`，不等待后台恢复完成。
4. RAG、技能、单个工具、MCP、频道和索引失败均允许降级；Agent Runtime 或聊天窗口失败属于致命错误。
5. 使用显式工厂和上下文，不引入 DI 容器。
6. 完整上下文只允许应用编排器持有，各启动模块只接收窄依赖。
7. 所有 `createXxx()` 只构造，长期任务必须显式启动。
8. 聊天渲染页面在全部可能调用的 IPC 处理器注册后才加载。
9. 所有窗口激活请求通过统一代理，并受 `mainWindowActivationReady` 门禁。
10. 生命周期阶段和能力健康状态分离。
11. MCP 屏障以成功、失败或超时为结算结果，不允许永久阻塞频道。
12. 后台取消采用 AbortSignal 协议，不把不可取消 Promise 伪装为已取消。
13. 受控退出按固定阶段清理；Windows 系统退出使用独立紧急落盘。
14. 更新安装先清理，再调用 `quitAndInstall()`。
15. 本次只保持现有按需行为，不额外改变启动语义。
16. 最终不保留新旧两套启动路径。

## 18. 官方依据

- [Electron `app` 生命周期](https://www.electronjs.org/docs/latest/api/app)：Windows 系统关机、重启或注销不会触发 `before-quit`、`will-quit` 和 `quit`。
- [Electron `BaseWindow` 会话结束事件](https://www.electronjs.org/docs/latest/api/base-window)：`query-session-end` 可短暂延迟会话结束，`session-end` 无法阻止退出。
- [Electron `autoUpdater`](https://www.electronjs.org/docs/latest/api/auto-updater)：`quitAndInstall()` 会改变窗口关闭与 `before-quit` 的触发顺序，并提供 `before-quit-for-update`。

## 19. 实现偏差记录（2026-08-30 实施）

实现与 v2 设计的接口签名存在以下有意偏差，行为语义保持一致：

1. **CoreServices 扩展**：在设计的 8 项服务之外增加 `llm`、`cita`、`social`、`ttsSession`、`update`，保证 Agent Runtime 与旧入口复用同一批服务实例（避免重复构造）。
2. **ShellDependencies 签名**：`createChatShell(windowManager)` 与 `registerShellIpc({ ipc, windowManager, live2dWindowLifecycle })` 传入壳阶段已创建的对象，替代旧入口的模块级 getter；`createTray` 额外接收 `togglePetWindow`（桌宠开关保持立即执行）。
3. **CoreDependencies 签名**：`registerAllTools(services)`、`createChannels/createScheduler(runtime, services)`、`applyGeneralSettings(settings, services)` 显式传参；`createLowCostServices()` 同时完成截图/音乐/更新服务的构造（无网络副作用）。
4. **桌宠启动语义微调**：`petVisible === true` 时以 `createPetWindow(true)` 创建（页面 ready-to-show 后显示），避免空窗口闪现；alwaysOnTop 与 zoom 在创建后立即应用，登录项同步经 `applyGeneralSettings` 执行。
5. **退出清理归属**：`music.shutdown`、`screenshot.shutdown`、`lsp.disposeAll`、`git.dispose`、`channels.shutdown` 在 core 阶段注册；`scheduler.stop`、主动触发器、更新检查定时器在 background 阶段注册；窗口激活代理 `stop()` 注册在 quiesce 阶段。
6. **音乐退出闩锁退役**：`music/shutdown-latch.ts` 及其测试已删除，生产路径无残留引用。
7. **受控退出终态**：致命启动路径最终 phase 为 `stopped`（failed → stopping → stopped），错误框与退出动作只执行一次。
