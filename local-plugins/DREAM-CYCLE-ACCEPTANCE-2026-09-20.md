# 统一梦境周期验收（2026-09-20）

## 结论

`companion-memory@0.50.0` 已把容量维护、梦境叙事复核与安全压缩串成同一后台周期：

1. 先按 300 条 active／800 条工作集上限执行可撤销的生命周期变更；
2. 仅从本轮降级的 aging 或 archived 记忆中选择最多 20 条生成梦境叙事草稿；
3. 再按 0.82 向量相似度审查最多 5 个压缩候选组；
4. 只有用户另外启用自动应用，且置信度、覆盖和提交前快照检查全部通过时，压缩建议才会落地。

统一周期启用期间，旧的独立“每 20 轮压缩”计时器会暂停，避免两套后台任务重复处理同一批记忆。
梦境叙事失败不会阻断后续压缩阶段；失败阶段只记录为结构化状态，不保存模型错误正文。

## 安全边界

- 人工梦境复核仍只接受 aging 记忆；统一周期的内部复核才可处理本轮刚降级为 archived 的记忆。
- 梦境草稿存在时不会开始下一轮容量变更，避免来源在用户确认前再次迁移。
- 待确认梦境来源不会同时进入同轮压缩候选；其他互不重叠的压缩候选仍可处理。
- 梦境应用不再因无关记忆修改而整体失效，但每条来源的正文、状态和版本快照仍须完全一致。
- 容量变更沿用现有生命周期事务，可通过已有维护记录撤销。

## 自动化结果

定向回归：

```powershell
npm.cmd test -- --run tests/auto-dream.test.ts tests/dream.test.ts tests/auto-compression.test.ts tests/ui.test.ts
```

结果：4 个测试文件、40 项测试全部通过。

全量验证：

```powershell
npm.cmd run verify
```

结果：

- TypeScript 类型检查通过；
- 插件测试 48 个文件通过、4 个文件按条件跳过；310 项通过、11 项按条件跳过；
- 三个插件产物构建成功；
- 隔离 host smoke 5 项通过；
- 构建产物 smoke 全部通过。

测试覆盖了 archived 本轮来源、叙事失败后继续压缩、无叙事候选时仍执行压缩尾段、阶段计数、
独立压缩暂停与恢复，以及真实 `PluginManager` 设置联动。

## 完整 Electron 隔离验收

原 Cyrene 退出后执行：

```powershell
node scripts/run-full-electron-host-smoke.mjs --preflight
node scripts/run-full-electron-host-smoke.mjs --companion-acceptance
```

结果为 `ok=true`、`exitCode=0`、`companionAcceptancePassed=true`。真实 `PluginManager` 加载
`companion-chat@0.10.0` 与 `companion-memory@0.50.0` 后确认：

- 梦境周期启用时独立压缩暂停；关闭梦境周期后独立压缩恢复；
- 梦境叙事自动应用、压缩自动应用和回应反馈学习均保持默认关闭，且只能显式启用；
- 关闭对应后台调度会同步清除自动应用授权；
- 压缩模式默认为手动确认，最近压缩组区域正常显示；
- 天气能力与主动消息宿主接口可由插件解析。

Electron 的 `APPDATA`、`LOCALAPPDATA`、`USERPROFILE`、`HOME`、`TEMP`、npm cache 与
`userData` 均指向 `Cyrene-Agent-N` 内的一次性目录。退出后结果为
`protectedUserDataUnchanged=true`、`changedRoots=[]`、`isolatedUserDataConfirmed=true`；
本次临时快照和运行数据已清除。

## 上游同步

GitHub 上游从 `eb6c311` 更新到 `0d24a7b`；功能代码没有变化，仅 README 的克隆地址改为
`https://github.com/Playa-Cyrene/Cyrene-Agent.git`。本地已采用这一行文档更新，没有在脏工作树上
执行 rebase 或 merge。
