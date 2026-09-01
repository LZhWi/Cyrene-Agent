# manifest.json 规范

## 完整示例

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

## 字段表

| 字段 | 类型 | 必填 | 规则 |
|---|---|---|---|
| `apiVersion` | number | 是 | 当前必须为 `1` |
| `id` | string | 是 | 匹配 `^[a-z0-9]+(-[a-z0-9]+)*$`，全小写连字符 |
| `name` | string | 是 | 非空显示名 |
| `version` | string | 是 | 严格 SemVer，如 `1.2.0`、`2.0.0-beta.1`（不能写 `1.0` 或 `v1.0`） |
| `description` | string | 是 | 非空简介 |
| `author` | string | 是 | 非空作者 |
| `entry` | string | 是 | 插件目录内裸文件名；支持 `.cjs`、`.js`、`.mjs`；不能含子目录或 `..` |
| `icon` | string | 否 | 插件目录内裸文件名；支持 `.png`/`.jpg`/`.jpeg`/`.webp`/`.svg`；≤2MiB；设置页卡片左侧展示；不合法时静默忽略，不影响加载 |
| `defaultEnabled` | boolean | 否 | 缺省 true，**只对内置插件生效**；用户插件首次发现一律停用 |
| `deps` | string[] | 否 | 可选值仅 `channels`、`llm`；未知值（含拼写错误）会让整个 manifest 失败 |

## 拒绝加载的情况

- `apiVersion` 缺失或不兼容
- version 不是 SemVer
- `deps` 含未知值或不是数组
- `defaultEnabled` 不是布尔值
- entry 含子目录、`..`、扩展名不受支持
- entry 不存在、不是普通文件，或经符号链接指向插件目录外

## id 的作用

`id` 决定三件事，必须保持一致：

1. 安装目录名：`userData/plugins/<id>/`
2. 工具 id 前缀：所有工具必须叫 `<id>_xxx`
3. IPC 通道前缀：`plugin:<id>:<channel>`

---

# 入口契约

CommonJS（推荐，`.cjs`）：

```js
"use strict";

module.exports = {
  async register(ctx) {
    // 启用时调用；在这里注册工具、IPC、渠道
    ctx.log("enabled");
  },
  async unregister() {
    // 停用/刷新/退出时调用；关窗口、清定时器和子进程；必须可重复调用
  },
  async open() {
    // 可选；实现了它，设置页卡片会出现"打开"按钮
  },
};
```

ESM 可用默认导出或命名导出。必须提供 `register(ctx)`，其余可选。

## ctx API 一览

| 方法 | 说明 |
|---|---|
| `ctx.registerTool(spec)` | 注册 AI 工具，id 必须 `<插件id>_` 前缀 |
| `ctx.unregisterTool(id)` | 只能注销本插件注册过的工具 |
| `ctx.registerIpc(channel, handler)` | 注册私有 IPC，实际通道名 `plugin:<id>:<channel>`；channel 只允许字母数字 `.` `_` `-`，≤64 字符 |
| `ctx.storage.set(key, value)` / `ctx.storage.get(key)` | 私有 JSON 存储，key 匹配 `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$` |
| `ctx.registerChannelAdapter(adapter)` | 注册渠道适配器（需声明 `deps: ["channels"]`） |
| `ctx.deps.llm.generateText(messages, opts)` | 调用宿主 LLM（需声明 `deps: ["llm"]`） |
| `ctx.deps.channels.has(id)` | 只读查询渠道是否已存在 |
| `ctx.log(msg)` | 打日志 |

---

# 工具 spec 详解

```js
ctx.registerTool({
  id: "my-plugin_hello",        // 铁律：<插件id>_ 前缀
  name: "打招呼",
  description: "用户让你打招呼时使用",  // 写给 AI 看，决定 AI 是否调用
  enabled: true,
  risk: "safe",
  effectKind: "read",           // read（只读）/ write（有副作用）
  inputSchema: {
    type: "object",
    properties: {
      minutes: { type: "number", description: "多少分钟后" },
      text: { type: "string", description: "提醒内容" },
    },
    required: ["minutes"],
  },
  async execute(args) {
    // args 由 AI 按 schema 填好传入
    return "返回字符串进入对话上下文";
  },
});
```

---

# LLM 依赖

manifest：`"deps": ["llm"]`

```js
const text = await ctx.deps.llm.generateText(
  [{ role: "user", content: "把这段话翻译成英文：……" }],
  {
    purpose: "summary",    // 仅诊断标签，不影响模型选择
    maxTokens: 1024,       // 1-8192，缺省 1024
    timeoutMs: 30000,      // 1000-300000，缺省封顶 120 秒
  }
);
```

走宿主的模型配置、队列、限流、重试和用量统计，无需自带 key。

---

# 生命周期与状态

```text
scan -> disabled（用户插件首次发现默认停用）
  -> 用户开启 -> starting -> running
  -> 用户停用 -> stopping -> disabled
  -> 启动报错 -> failed（设置页显示错误，卡片有"重试"）
```

- 所有 enable/disable/open/rescan/install/uninstall 操作走同一串行队列，不会并发重复注册
- 设置页区分 `configuredEnabled`（用户想不想开）与 `status`（实际运行状态）

---

# 目录与 zip 导入限制

## 插件目录

```text
userData/plugins/<plugin-id>/      # 用户插件（打包版 = %APPDATA%\live2d-cyrene\plugins\）
src/plugins/<plugin-id>/           # 内置插件（随应用构建）
userData/plugin-data/<plugin-id>/  # 插件私有数据，卸载不删
```

## zip 结构（两种都行）

```text
my-plugin.zip
└── my-plugin/
    ├── manifest.json
    └── index.cjs
```

或 manifest + 入口直接放 zip 根目录。

## 导入校验限制

- zip ≤ 50 MiB；条目 ≤ 2000；单文件解压后 ≤ 50 MiB；总解压量 ≤ 200 MiB
- 拒绝：加密 zip、绝对路径、`..` 路径、符号链接、Windows 保留路径、大小写冲突路径、异常压缩比
- 新导入一律停用；替换已有插件会先确认、备份旧目录、失败自动回滚，且保留 `plugin-data/` 与启用状态
- 导入走 staging 临时目录 + 原子 rename，不会出现装了一半的插件

## 刷新与更新

设置页"刷新插件"会重扫目录、清 CommonJS 模块缓存、以 cache-busting 重新导入 ESM、重新激活。改了代码不生效就点它。
