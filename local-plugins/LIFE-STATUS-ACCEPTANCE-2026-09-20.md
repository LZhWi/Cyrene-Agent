# 生活状态显示验收记录（2026-09-20）

## 目标

在不建立第二份生活状态、不改变模型上下文的前提下，让陪伴桌面 Chat 显示与本地版一致的
“昔涟 · 正在××／休息中”。原生 Chat 后端和其他模式必须保持原界面与原行为。

## 最小边界

- `companion-chat` 从既有 life-context 生成器公开只读 `life-status` IPC；文本和休息状态与模型收到的
  `[你的生活]` 使用同一个活动源。
- preload 只暴露读取方法；渲染层每 60 秒刷新，不写插件状态、不触发模型请求。
- 徽标只在桌面 Chat、`chatBackend=companion`、无覆盖面板且插件返回有效状态时显示。
- 插件缺席、停用、读取失败、原生后端、Work／Code／Learn 或打开其他面板时静默隐藏。

## 自动化结果

- life-context 单元测试确认状态与上下文同源、休息状态正确、功能关闭后不返回状态。
- bridge 和导航单元测试确认 IPC 数据校验、Chat 专属显示及其他模式隐藏。
- `npm.cmd run verify`：50 个测试文件通过、4 个按条件跳过；321 项通过、13 项跳过；类型检查、
  两个插件构建、隔离宿主与构建产物加载全部通过。
- 测试夹具改为逐用例清理自己创建的目录；清除 24 个旧遗留目录后重新验证，结束时 `.test-runtime`
  只出现空父目录并已精确删除。

## 完整 Electron 复核

一次性隔离宿主以合成会话启动真实渲染页，DOM 中成功读取到带“昔涟 · ”前缀的生活状态徽标；最终结果：

- `ok=true`、`exitCode=0`、`companionLifeStatusVisible=true`；
- `nativeTurnPassed=true`、`promptProviderOrderPassed=true`、`nativeRelationshipBypassed=true`；
- 四个正式数据保护根 `changedRoots=[]`，`protectedUserDataUnchanged=true`；
- 未复制真实数据、未访问网络或真实模型；本次隔离 `userData` 和运行目录在退出后自动清除。

GPU shared-context 与受控子进程沙箱的降级日志来自隔离验收环境；验收脚本明确拦截相关辅助进程，
不影响上述宿主、渲染和数据保护断言。
