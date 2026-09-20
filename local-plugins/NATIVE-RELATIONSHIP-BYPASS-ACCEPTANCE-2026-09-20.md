# 原生关系状态旁路验收记录（2026-09-20）

## 目标

当桌面 Chat 在轮次开始时冻结为 `companion` 后端时，只使用插件提供的近期关系上下文，不再读取或写入
上游原生 relationship 状态。原生后端、外部渠道以及 Work／Code／Learn 等其他模式必须保留原行为。

## 实现边界

- `buildAgentRunOptions` 复用既有 `shouldUseNativeChatSystems` 判定，仅在原生路径调用
  `buildRelationshipContext`。
- `onAgentRunFinished` 复用成功回合的冻结后端判定，仅在原生路径调用 `recordRelationshipTurn`。
- 没有删除原生 relationship 实现，没有改变它的数据格式，也没有让插件读取宿主私有文件。
- 运行状态、表情和贴纸等非 relationship 副作用不受本次门禁影响。

## 自动化验证

在 `Cyrene-Agent-N/.upstream-latest` 内执行：

```powershell
$env:ELECTRON_OVERRIDE_DIST_PATH='E:\Philia093 demo\Cyrene-Agent\node_modules\electron\dist'
npm.cmd exec vitest run src/main/orchestrator/build-options.test.ts
npm.cmd run build:main
```

结果：

- `build-options.test.ts`：56 项通过；
- 主进程 TypeScript 构建通过；
- companion 桌面 Chat 不调用原生 relationship 构建或写入；
- 同一配置下的外部渠道仍调用原生 relationship 构建；
- companion 配置下的非 Chat 模式仍保留原生成功回合写入。

测试只读复用了既有 `Cyrene-Agent/node_modules/electron/dist` 作为 Electron 模块的可执行文件解析目录；
未启动该程序，未修改其依赖或用户数据。测试产生的构建输出仅位于 `Cyrene-Agent-N`。

## 完整 Electron 复核

随后在一次性隔离 `userData` 中完成三轮合成原生 Chat。轮次成功、最终消息落盘并由插件摄取后，隔离
目录中仍不存在 `relationship-log.json`，结果为 `nativeRelationshipBypassed=true`。同一运行同时确认：

- companion 插件正常启用并收到成功落盘生命周期；
- 原生 Chat 的插件记忆、历史、生活上下文和 WorldBook 在下一轮可见；
- 四个正式数据保护根前后哈希一致，`changedRoots=[]`；
- 一次性测试目录在退出后删除。

该复核使用合成数据和固定回复，不复制真实用户数据，不调用网络或真实模型。
