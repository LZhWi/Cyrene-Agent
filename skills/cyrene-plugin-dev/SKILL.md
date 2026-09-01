---
name: cyrene-plugin-dev
description: 当用户想为 Cyrene 开发插件（扩展昔涟的工具、做插件弹窗、接入渠道）、调试插件报错，或询问插件怎么写时使用。涉及 Cyrene 本体源码的功能开发不使用本 Skill。
version: 1.0.0
effectKind: mutation
modes:
  - code
  - work
---

# Cyrene 插件开发

本 Skill 指导如何为 Cyrene 开发运行时插件：从需求到可安装的 zip 包，一次做对。

## 何时使用

- 用户想给 Cyrene 加新能力，且明确走插件形式（而不是改本体源码）
- 用户拿来的插件报错，需要排查（启用失败、工具不生效、弹窗异常）
- 用户询问插件怎么写、能做什么

不使用：改 Cyrene 本体源码的普通开发任务；只是使用已装插件。

## 前置知识：先读再写

动手前必须先读这三处，以它们为准（本 Skill 只讲流程，不背抄规范）：

1. `docs/plugins/plugin-dev-guide.md` —— 教程版开发指南，含最小可用模板
2. `docs/plugins/plugin-authoring.md` —— 完整接口规范（manifest 字段表、生命周期、zip 导入限制）
3. `examples/system-status/` —— 官方示例插件，覆盖工具 + 弹窗 + IPC 全部知识点；写新插件前通读一遍

## 开发流程

### 1. 明确插件形态

先和用户确认要做的是哪类能力，通常是一种或多种组合：

| 形态 | 特征 |
| --- | --- |
| 纯工具插件 | 只注册 `registerTool`，AI 对话中自动调用（最常见） |
| 带界面插件 | 额外实现 `open()` 弹独立窗口 |
| 调用 LLM 的插件 | manifest 声明 `"deps": ["llm"]` |
| 渠道插件 | `ctx.registerChannelAdapter`（进阶，先确认用户真的需要） |

### 2. 搭骨架

在一个独立目录（如 `examples/<plugin-id>/` 或用户指定目录）创建：

```text
<plugin-id>/
  manifest.json
  index.cjs
```

manifest 必填字段：`apiVersion: 1`、`id`、`name`、`version`（严格三段式 SemVer）、`description`、`author`、`entry`。`id` 全小写连字符，它决定工具 id 前缀和安装目录名。

### 3. 实现

铁律（违反会直接启用失败或行为异常）：

- **工具 id 必须以 `<插件id>_` 开头**，如插件 `my-plugin` 的工具叫 `my-plugin_hello`
- **工具的 `description` 是写给 AI 看的**：写清"什么场景该用"，含参数说明
- 只读工具 `risk: "safe"` + `effectKind: "read"`；有副作用的用 `effectKind: "write"`
- 弹窗用 `BrowserWindow` 加载插件目录内的 HTML，`nodeIntegration: true` + `contextIsolation: false`
- 窗口实例、定时器、子进程必须在 `unregister()` 里清理，且该函数要能重复调用不崩
- 渲染进程与插件通信：IPC 通道名是 `plugin:<插件id>:<channel>`
- 数据采集优先 Node 原生（`os`、`fs`），不够再用 PowerShell / nvidia-smi 等子进程；子进程要设超时并处理失败降级

### 4. 本地验证

装进用户目录前，先用 Node 模拟注册做冒烟测试：

```js
// node -e 直接跑：模拟 ctx 调用 register，确认不抛错、工具 id 合法
const p = require("./<plugin-id>/index.cjs");
p.register({
  registerTool: (t) => { if (!t.id.startsWith("<plugin-id>_")) throw new Error(t.id); },
  registerIpc: () => {},
  log: () => {},
});
```

涉及弹窗的逻辑无法脱离 Electron 验证，跳过此步，靠安装后实测。

### 5. 打包安装

- 把插件目录压成 zip：`Compress-Archive -Path <plugin-id>/* -DestinationPath <plugin-id>-<version>.zip`
- zip 限制：≤50 MiB、≤2000 条目、解压总量 ≤200 MiB；不能有符号链接和 `..` 路径
- 开发期也可以直接把文件复制到 `%APPDATA%\live2d-cyrene\plugins\<plugin-id>\`（与 zip 导入等价）
- 安装后**默认停用**，需用户在 设置 → 功能插件 里打开开关

### 6. 安装后实测

告诉用户验证三件事，缺一不可：

1. 设置页插件状态为 `running`
2. 有弹窗的：点“打开”按钮窗口正常显示、关闭再开正常
3. 有工具的：对话里问一个应触发工具的问题，确认 AI 调用并转述结果

## 排查既有插件问题

按优先级查：

1. **启用报错** → 设置页卡片会显示具体 error，对照铁律清单（九成是 id 前缀 / SemVer / deps 拼写）
2. **启用成功但 AI 不用工具** → description 没写清场景，或对话上下文没触发
3. **改了代码不生效** → 设置页点“刷新插件”（会清模块缓存）
4. **弹窗白屏/报错** → 开发者工具看渲染端异常（`win.webContents.openDevTools()`）；多为 IPC 通道名拼错或 HTML 路径不对
5. **扫描警告“缺少 manifest.json”** → 插件目录层级错了（zip 解压多套/少套了一层目录）

## 安全与边界

- 插件与宿主同权限运行（无沙箱）。为用户写插件时只用可审查的标准库和明确说明用途的子进程调用
- 不覆盖、不删除用户插件目录和 `plugin-data/` 下的数据
- 更新插件：导入同名新版 zip 走替换流程，不要手动删旧目录再装（会丢启用状态）
