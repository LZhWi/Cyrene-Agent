# 本地 Ollama 全面隔离验收（2026-09-21）

## 结论

`Cyrene-Agent-N` 使用其独立持久目录中已保存的 OpenAI-compatible 本地模型配置完成了真实模型验收。
默认模型为 `qwen3.5:9b`，端点限定为回环地址。最终完整 Electron 页面轮次、两阶段 Tool/Soul
链路、插件记忆、消息落盘与摄取、用量记录均通过。视觉模型未配置，因此没有发送真实图片；视觉部分只用
隔离固定回包验证截图、协议、工具调用和 Soul 交接通路。

四个正式用户数据保护根在全部测试前后的内容哈希逐项一致；一次性 Electron 运行目录已经清除。

## 验收范围与结果

### 1. 本地模型基础能力

通过 `scripts/verify/local-openai-model.mjs` 只读加载 `Cyrene-Agent-N/AppData` 中的默认模型档案：

- `GET /models`：通过，列出 4 个模型。
- 普通非流式文本回复：通过；耗时约 7.6 秒。
- OpenAI-compatible 强制工具调用：通过；模型返回 `echo_probe`，耗时约 2.3 秒。
- 视觉：按本次验收约束跳过真实请求，只保留离线通路测试。
- API Key 未写入日志或报告。

### 2. 完整 Electron + 插件 + 真实 Soul

最终命令：

```text
node local-plugins/scripts/run-full-electron-host-smoke.mjs --bounded-model-ui-turn --local-model
```

最终结果 `ok=true`：

- `companion-chat@0.13.0`、`companion-memory@0.54.0` 均在真实 PluginManager 中启动。
- `toolPhaseCalls=5`，`soulPhaseCalls=3`，没有意外模型请求。
- 记忆查询工具被调用且结果进入 Soul；屏幕观察工具被调用且固定视觉摘要进入 Soul。
- 视觉固定回包调用 1 次，图片没有外发。
- 只有目标 Soul 回复连接本机 Ollama：`liveCalls=1`。
- 真实回复非流式完成，`finishReason=stop`，可见文本 24 字符，reasoning 169 字符。
- 本轮真实请求用量：输入 10385 tokens，输出 111 tokens。
- 第二轮回复成功落盘，插件随后摄取；屏幕轮回复也成功落盘并摄取。
- 独立 `userData`、原生记忆旁路和临时目录清理均通过。

此前两次运行的模型回复、落盘和插件链路本身也都成功；失败只来自验收脚本仍以旧 Kimi 模型名和旧计数
条件核对用量。脚本已改为读取当前本地模型名并按本地模型分支计数，最终重跑通过。

### 3. 离线与构建回归

- 主项目完整构建：main、preload、CLI、renderer 全部通过；只有既有 Vite chunk-size 警告。
- 插件 `npm run verify`：326 个测试通过，13 个按设计跳过；隔离宿主及打包产物 smoke 通过。
- 视觉通路专项：10 个测试文件、74 个测试通过，覆盖截图服务、图片发送策略、视觉 caption、协议、
  helper、OpenAI 适配器和图片 URL 工具。
- 主项目完整测试共 468 个文件、4086 个测试。普通受限进程中有 4 个 Windows 集成文件因
  `uv_os_get_passwd ENOMEM`、`C:\cyrene-*` 写权限和 `taskkill` 受限失败；在允许相应 Windows
  集成权限后单独重跑这 4 个文件，25/25 通过，且没有残留测试进程。

## 用户数据隔离证明

测试前后内容哈希完全一致：

| 保护根 | SHA-256 |
| --- | --- |
| `%APPDATA%/live2d-cyrene` | `ea4a408c367990937a23850d1c714b9d40659ae5a0e796822a9ecd159bf8ca22` |
| `%LOCALAPPDATA%/live2d-cyrene` | `a4004f151c8bd852ca176e9b14b9b8b6514b8d48fb1bb2b81d13c3c5a486ed8a` |
| `Cyrene-Agent/UserData` | `a4004f151c8bd852ca176e9b14b9b8b6514b8d48fb1bb2b81d13c3c5a486ed8a` |
| `Cyrene-Agent/UserData_backup` | `da9c3f2a5a43b21976b5fefe7ebd836cf6d2ea776c9528c667c48f959e3c87e5` |

完整 Electron 测试报告同时返回 `protectedUserDataUnchanged=true`、`changedRoots=[]`。

## 限定

- 本轮没有真实视觉模型质量结论；只证明无视觉模型时相关调用边界和两阶段通路正确。
- Tool 阶段的真实工具协议由同一 Ollama 模型单独强制调用验证；完整 Electron 的 Tool 决策使用固定回包，
  以保证记忆、屏幕和 Soul 路由的确定性。完整 Electron 中的最终 Soul 回复是真实模型输出。
- 本轮使用合成聊天事实，不读取或发送正式聊天正文，也不修改正式记忆激活值。
