# 记忆压缩模式与最近记录隔离验收（2026-09-20）

## 结论

`companion-memory@0.49.0` 已完成压缩交互收口：用户可明确选择“生成建议后手动确认”或
“符合安全条件时自动压缩”；自动模式置信度下限为 0.80。至少 3 条 aging、非置顶、非摘要来源、
模型确认完整覆盖、提交前重新核对记忆与证据快照、严格撤销等约束保持不变。

界面顶部展示最近 3 个已应用或已撤销的压缩组，包括状态、实际应用／撤销时间、总结与来源条目。
新记录保存 `appliedAt`／`undoneAt`；旧记录无需迁移，没有时间字段时回退显示原记录时间。

## 自动化结果

`npm.cmd run verify` 全部通过：

- TypeScript 类型检查通过；
- 插件测试 48 个文件通过、4 个文件按条件跳过；306 项通过、11 项按条件跳过；
- 三个插件产物构建成功；
- 隔离 host smoke 5 项通过；
- 构建产物 smoke 全部通过。

定向测试同时确认：置信度 0.80 可进入安全自动路径，0.79 保持 pending；应用与撤销时间会保存；
模式切换、取消授权、顶部最近记录过滤和新旧排序均符合预期。

## 完整 Electron 隔离验收

执行：

```powershell
node scripts/run-full-electron-host-smoke.mjs --preflight
node scripts/run-full-electron-host-smoke.mjs --companion-acceptance
```

结果为 `ok=true`、`exitCode=0`、`companionAcceptancePassed=true`。真实 `PluginManager` 加载
`companion-memory@0.49.0` 后确认：

- 新安装默认使用手动确认模式；
- 顶部最近压缩区域存在，空库显示“暂无压缩记录”；
- 自动压缩应用需要在后台压缩之外再次显式授权；
- 关闭后台压缩会同步清除自动应用授权。

## 数据隔离

验收前先对 Roaming Cyrene、Local Cyrene、原项目 `UserData` 和 `UserData_backup` 四个保护根
执行只读全树 SHA-256 预检。Electron 的 `APPDATA`、`LOCALAPPDATA`、`USERPROFILE`、`HOME`、
`TEMP`、npm cache 与 `userData` 全部重定向到 `Cyrene-Agent-N` 内的一次性目录。

退出结果为 `protectedUserDataUnchanged=true`、`changedRoots=[]`；一次性测试目录随后已清除。
本次没有读取真实聊天正文，也没有调用真实模型。
