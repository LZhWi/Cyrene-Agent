# Cyrene 插件开发规范

本文描述 Cyrene-Agent 插件系统 v1。插件以“目录 + `manifest.json` + JavaScript 入口文件”交付，应用启动时扫描，用户可在设置页的“功能插件”中启停。

> 安全提示：插件入口运行在 Electron 主进程中，拥有与 Cyrene 相同的本机权限。只安装和启用你信任的插件。

## 目录与扫描位置

用户插件目录：

```text
userData/plugins/<id>/
  manifest.json
  index.cjs
```

内置插件由 `src/plugins/<id>/` 编译到 `dist/main/plugins/<id>/`。运行时先扫描内置目录，再扫描用户目录；重复 id 保留先扫描到的插件。扫描只检查根目录下的一级子目录。

插件数据不会写回代码目录，而是保存在 `userData/plugin-data/<id>/`。

## manifest.json

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 唯一 id，须匹配 `^[a-z0-9]+(-[a-z0-9]+)*$` |
| `name` | string | 是 | 设置页显示名 |
| `version` | string | 是 | 插件版本 |
| `description` | string | 是 | 简短说明 |
| `author` | string | 是 | 作者 |
| `entry` | string | 是 | 插件目录内的裸文件名，支持 `.cjs`、`.js`、`.mjs` |
| `defaultEnabled` | boolean | 否 | 初次发现时是否启用，缺省为 `true` |
| `deps` | string[] | 否 | 主程序能力白名单，v1 支持 `channels`、`llm` |

示例：

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "An example Cyrene plugin",
  "author": "Your Name",
  "entry": "index.cjs",
  "defaultEnabled": false
}
```

`entry` 不允许包含子目录或 `..`。缺少必填字段、入口不存在或扩展名不受支持时，该目录会被跳过。

## 入口契约

入口必须导出 `register(ctx)`，可以导出 `unregister()` 和 `open()`：

```js
module.exports = {
  register(ctx) {
    ctx.log("enabled");
  },
  unregister() {
    // Close windows, timers, and other plugin-owned resources here.
  },
  open() {
    // Optional controlled entry called by the settings UI.
  },
};
```

ESM 入口可用命名导出或默认导出。启用时调用 `register`；停用和退出时调用 `unregister`，随后框架清理通过 context 注册的资源。

## PluginContext

### 工具

`ctx.registerTool(tool)` 将工具加入主程序的 `ToolRegistry`。工具 id 必须以 `<plugin-id>_` 开头，且不能与现有工具重复。

```js
ctx.registerTool({
  id: "my-plugin_hello",
  name: "Hello",
  description: "Return a greeting",
  enabled: true,
  inputSchema: { type: "object", properties: {}, required: [] },
  execute: async () => "Hello from my plugin",
});
```

可用 `ctx.unregisterTool(id)` 主动注销；停用插件时框架也会兜底清理。

### IPC

`ctx.registerIpc(channel, handler)` 注册的通道会自动变为 `plugin:<id>:<channel>`：

```js
ctx.registerIpc("ping", () => "pong");
```

使用 `ctx.unregisterIpc(channel)` 主动注销。

### 私有存储

```js
ctx.storage.set("config", { endpoint: "https://example.com" });
const config = ctx.storage.get("config");
ctx.storage.rootDir();
```

每个 key 对应一个 JSON 文件。key 须匹配 `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`，写入使用临时文件加 rename。

### 主程序依赖

插件不得直接导入 `src/main/**` 或 `src/shared/**` 的内部模块。需要能力时，在 manifest 的 `deps` 中声明：

- `channels`：提供 `ctx.deps.channels.channelManager` 的 `register`、`unregister`、`startOne`。
- `llm`：提供 `ctx.deps.llm.generateText(messages)`，使用当前主聊天模型执行一次非流式文本请求。

未声明的依赖不会注入。渠道 adapter id 不能覆盖已注册渠道，并且仍须属于主程序的 `ChannelId`；新增渠道类型需要先扩展主程序类型定义。

## 生命周期

```text
应用启动
  -> 扫描并校验 manifest
  -> 读取 app-settings.json 中的插件开关
  -> 加载已启用插件并调用 register(ctx)

设置页切换
  -> 启用：加载入口并 register(ctx)
  -> 停用：unregister()，然后清理工具、IPC 和渠道 adapter

应用退出
  -> stop() 清理全部已启用插件
```

启停状态保存在通用设置的 `plugins` 映射中。插件在运行中启停无需重启；新增或删除插件目录后需要重启以重新扫描。

## 带 UI 的插件

v1 不提供动态 renderer bundle。插件可导出 `open()` 作为受控入口；设置页只会为已启用且实现 `open()` 的插件显示“打开”按钮。内置插件如需完整渲染页面，仍需在主项目构建配置中显式加入页面入口。

插件应在 `unregister()` 中关闭自己创建的窗口、定时器和后台任务。

## 验证

```bash
npx vitest run src/plugins
npm run build:main
```

建议逐项确认：

1. 设置页能显示插件并持久化开关。
2. 工具和 IPC 在启用后出现、停用后消失。
3. `register()` 失败时已注册资源会回滚。
4. 插件数据只写入 `userData/plugin-data/<id>/`。
5. 带 `open()` 的插件只能在启用状态打开。

仓库内的 `src/plugins/demo/` 是一个默认关闭的最小内置示例。
