# Cyrene Runtime Plugin API v1

本文描述 Cyrene-Agent 的可信本地运行时插件系统。插件以“目录 + `manifest.json` +
JavaScript 入口”交付，可注册工具、插件私有 IPC、渠道 adapter，并按声明使用 Cyrene
提供的 LLM 服务。

## 安全与信任边界

> 插件入口在 Electron Main Process 中执行，拥有与 Cyrene 相同的本机权限。它不是
> 沙箱、Web 扩展或权限隔离进程。只安装你能审查且信任其来源的插件。

`manifest.deps` 表示“希望 Cyrene 注入哪些主程序服务”，不是操作系统权限清单。
插件代码仍可直接使用 Node.js 能力，因此：

- 用户插件首次发现后一律保持停用，即使 manifest 声明 `defaultEnabled: true`。
- 设置页显示插件来源、实际路径、API 版本、运行状态和最后一次错误。
- 只有用户明确点击“启用”后，用户插件入口才会被加载。
- 内置插件可使用 `defaultEnabled`，因为它与应用一起构建和发布。

## 目录与扫描来源

用户插件：

```text
userData/plugins/<plugin-id>/
  manifest.json
  index.cjs
```

打包版 Windows 默认对应：

```text
%APPDATA%\live2d-cyrene\plugins\<plugin-id>\
```

运行时始终以 Electron `app.getPath("userData")` 的实际返回值为准；如果开发者或测试显式
覆盖了 `userData`，插件根目录也会随之变化。

内置插件：

```text
src/plugins/<plugin-id>/
  manifest.json
  index.ts
```

内置插件由构建流程复制/编译到 `dist/main/plugins`。插件私有数据位于：

```text
userData/plugin-data/<plugin-id>/
```

扫描只读取每个根目录的一级子目录。单个无效插件、不可读目录或错误 manifest 会记录为
扫描问题并展示在设置页，不会阻止 Cyrene 启动。重复 ID 保留先扫描到的插件；内置目录
优先于用户目录，因此用户插件不能覆盖内置插件。

## manifest.json

完整示例：

```json
{
  "apiVersion": 1,
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "An example Cyrene plugin",
  "author": "Your Name",
  "entry": "index.cjs",
  "defaultEnabled": false,
  "deps": ["llm"]
}
```

| 字段 | 类型 | 必填 | 规则 |
|---|---|---|---|
| `apiVersion` | number | 是 | 当前必须为 `1` |
| `id` | string | 是 | 匹配 `^[a-z0-9]+(-[a-z0-9]+)*$` |
| `name` | string | 是 | 非空显示名 |
| `version` | string | 是 | 严格 SemVer，例如 `1.2.0`、`2.0.0-beta.1` |
| `description` | string | 是 | 非空简介 |
| `author` | string | 是 | 非空作者 |
| `entry` | string | 是 | 插件目录内裸文件名；支持 `.cjs`、`.js`、`.mjs` |
| `defaultEnabled` | boolean | 否 | 缺省 true，但只对内置插件生效 |
| `deps` | string[] | 否 | 可选 `channels`、`llm` |

以下情况会拒绝加载：

- 缺少或不兼容的 `apiVersion`；
- version 不是 SemVer；
- `deps` 含未知值或不是数组；
- `defaultEnabled` 不是布尔值；
- entry 包含子目录、`..`、扩展名不受支持；
- entry 不存在、不是普通文件，或通过符号链接指向插件目录外。

未知依赖会使 manifest 整体失败，不会静默过滤。这样可以尽早暴露 `lllm` 一类拼写错误。

## 入口契约

CommonJS：

```js
module.exports = {
  async register(ctx) {
    ctx.log("enabled");
  },
  async unregister() {
    // Close plugin-owned windows, timers and background work.
  },
  async open() {
    // Optional controlled entry called from Settings.
  },
};
```

ESM 可使用默认导出或命名导出。必须提供 `register(ctx)`；`unregister()` 与
`open()` 可选。

## 稳定 Plugin API

插件面向的类型统一定义在 `src/plugins/api.ts`。该文件不导入 `src/main/**` 或
`src/shared/**`；Cyrene 内部类型只在 context adapter 边界转换。第三方插件不应直接
导入应用内部模块。

### 工具

```js
ctx.registerTool({
  id: "my-plugin_hello",
  name: "Hello",
  description: "Return a greeting",
  enabled: true,
  risk: "safe",
  effectKind: "read",
  verificationPolicy: "none",
  inputSchema: {
    type: "object",
    properties: {},
    required: []
  },
  execute: async () => "Hello from my plugin"
});
```

工具 ID 必须以 `<plugin-id>_` 开头。Context 会拒绝重复 ID，也拒绝插件注销核心工具或
其他插件的工具：

```js
ctx.unregisterTool("my-plugin_hello"); // allowed
ctx.unregisterTool("read_file");       // rejected
```

### IPC

```js
ctx.registerIpc("ping", () => "pong");
```

实际 Electron IPC 名称为 `plugin:<plugin-id>:ping`。channel 只允许字母、数字、
`.`、`_`、`-`，长度不超过 64。插件只能注销当前 context 注册过的 IPC。

### 私有存储

```js
ctx.storage.set("config", { endpoint: "https://example.com" });
const config = ctx.storage.get("config");
```

每个 key 对应一个 JSON 文件。key 必须匹配
`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`。写入使用临时文件和 rename，避免进程崩溃留下
半份 JSON。

### Channels

渠道注册必须通过 Context：

```js
await ctx.registerChannelAdapter(adapter);
await ctx.unregisterChannelAdapter(adapter.id);
```

Context 会跟踪 adapter 所有权并在插件停用时兜底清理。插件不能注销内置渠道或其他插件
注册的渠道。

当 manifest 声明 `"deps": ["channels"]` 时，仅额外提供只读发现能力：

```js
ctx.deps.channels.has("feishu");
```

内置 adapter 会在插件激活前完成注册。ChannelManager 对重复 ID 直接报错，不再覆盖已经
启动的实例。

### LLM

manifest：

```json
{
  "deps": ["llm"]
}
```

调用：

```js
const text = await ctx.deps.llm.generateText(
  [{ role: "user", content: "Summarize this text" }],
  {
    purpose: "summary",
    maxTokens: 1024,
    timeoutMs: 30000,
    signal: abortController.signal
  }
);
```

LLM 请求使用当前默认模型档案，并统一经过 Cyrene 的 `LlmClient`、后台 FIFO 队列、
限流重试、timeout、取消、token usage 与请求日志。限制：

- `maxTokens`：1-8192，缺省 1024；
- `timeoutMs`：1000-300000；缺省使用聊天超时并封顶 120 秒；
- `purpose`：只用于诊断标签，不影响模型选择。

## 生命周期和状态

```text
scan
  -> disabled
  -> starting
  -> running
  -> stopping
  -> disabled

starting --error--> failed
failed --retry--> starting
```

设置页区分：

- `configuredEnabled`：用户希望插件启用；
- `status`：`disabled | starting | running | stopping | failed`；
- `error`：最后一次激活失败原因。

因此“配置为启用但 register 失败”不会伪装成普通停用。用户可以重试，也可以关闭 desired
state，避免每次启动重复尝试。

所有 enable、disable、open、rescan、uninstall、stop 操作经过同一生命周期队列串行执行，
避免并发点击或多个 renderer 请求造成重复注册和 context 泄漏。

## 刷新、更新与模块缓存

设置页“刷新插件”会：

1. 重新扫描内置和用户目录；
2. 停止并移除已删除插件；
3. 清理活动插件资源；
4. 清除该插件目录下的 CommonJS `require.cache`；
5. 使用 cache-busting URL 重新导入 ESM 入口；
6. 重新激活仍配置为启用的插件；
7. 展示 manifest、重复 ID 和目录读取问题。

活动插件会在手动刷新时重新加载，即使 manifest 没变。新增用户插件仍保持停用。

## 卸载用户插件

设置页只对用户插件显示“卸载”。卸载事务按以下顺序执行：

1. 确认目标来自用户插件扫描源；内置插件拒绝卸载；
2. 确认目标是用户插件根目录中的一级普通目录，并通过真实路径再次验证没有越界；
3. 停止插件并释放工具、IPC、渠道适配器等运行资源；
4. 清除该插件的持久启停记录，确保删除失败时也不会在下次扫描自动重启；
5. 清理模块缓存并递归删除插件程序目录；
6. 执行一次不重启其他活动插件的增量重扫。

卸载只删除 `userData/plugins/<plugin-id>/` 中的插件程序。默认保留
`userData/plugin-data/<plugin-id>/` 中的插件私有数据，避免卸载误删用户内容；如需彻底清除，
应由用户另行确认后手动删除对应数据目录。

## 应用退出

插件清理加入新版应用退出协调器的固定阶段。Cyrene 会依次等待：

1. 插件 `unregister()`；
2. Context 工具、IPC、渠道资源回收；
3. 插件在 `stopActiveWork` 阶段完成后，再在 `stopExternalConsumers` 阶段关闭内置 Channels；
4. 截图服务、LSP、Git 与音乐等本地资源关闭。

受控退出总等待上限为 10 秒，超时后中止继续等待并执行最终退出动作。插件仍应让
`unregister()` 有界且可重复调用。

## 从最初 v1 草案迁移

旧 manifest：

```json
{
  "id": "my-plugin",
  "version": "1.0.0"
}
```

必须增加：

```json
{
  "apiVersion": 1
}
```

其他行为变化：

- 用户插件不再自动启用；
- `deps.channels.channelManager` 已移除，改用 Context 注册方法和
  `deps.channels.has()`；
- 非法 deps 不再过滤，而是拒绝 manifest；
- version 必须为 SemVer；
- 注销非本插件资源会抛错；
- 插件列表 IPC 返回 `{ plugins, issues }`，不再只返回数组。

## 验证

```bash
npx vitest run src/plugins src/main/plugin-llm.test.ts src/main/channels/manager.test.ts
npm run build
```

建议人工验收：

1. 新用户插件出现但不会自动执行；
2. 启用/停用后工具、IPC 和 adapter 对称增减；
3. register 失败后设置页显示 `failed` 和具体错误；
4. 修改入口后点击刷新，运行行为切换到新版本；
5. 用户插件点击卸载并确认后，程序目录、资源和启停记录消失，私有数据目录保留；
6. 重复使用 `feishu` 等内置渠道 ID 时启用失败，内置渠道仍正常；
7. 退出时异步 `unregister()` 在退出协调器内完成，并严格早于内置 Channels 关闭。

仓库内 `src/plugins/demo/` 是默认停用的最小内置示例。
