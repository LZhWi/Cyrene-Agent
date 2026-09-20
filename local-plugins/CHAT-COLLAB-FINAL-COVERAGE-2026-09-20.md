# Chat／Collab 主线收口记录（2026-09-20）

## 结论

当前定义范围内的本地 Chat／Collab 复刻主线已经完成。上游桌面 Chat 在 `companion` 后端中使用本地
Tool→Soul 两阶段、人设与提示词层、插件记忆／检索、WorldBook、life-context、屏幕观察和主动消息；
Work、Code、Learn、朋友圈与外部渠道继续使用上游原生实现。

“完成”表示功能管线、状态边界和隔离验收已对齐，不表示任意输入下的模型回复措辞必然逐字一致。

## 已覆盖

- Tool 与 Soul 严格分阶段；工具自由文本不泄漏，Soul 不携带工具 schema，保留上游 Harness 的执行安全能力。
- Soul、Tool、tone、soul-tail 与动态 life → memory → WorldBook 顺序稳定；无工具普通聊天也走相同结构。
- 插件私有 L0/L1/L2、来源证据、历史绑定、词面／向量／重排、DMAE、生命周期、Resolver、压缩、
  Reflection、梦境、archived 冷召回和十轮提取＋前两轮上下文。
- companion 后端旁路上游冲突的原生记忆、关系、WorldBook、社交原子和原生主动消息；原生后端与其他
  模式保持原行为。
- 屏幕观察、天气、用户活动、主动消息、反馈学习门禁和成功投递回执；回应反馈学习默认关闭。
- life-context 模型注入与“昔涟 · 正在××／休息中”界面状态同源。

## 最终回归

- 插件 `npm.cmd run verify`：50 个测试文件通过、4 个按条件跳过；321 项通过、13 项跳过；类型检查、
  构建、隔离宿主与产物加载全部通过。
- 完整 Electron 合成原生 Chat：`ok=true`、`nativeTurnPassed=true`、`promptProviderOrderPassed=true`、
  `nativeRelationshipBypassed=true`、`companionLifeStatusVisible=true`、`changedRoots=[]`。
- 主程序广覆盖回归：排除 3 个会越出 `Cyrene-Agent-N` 或依赖真实进程树权限的上游测试文件后，
  其余 463 个文件、4044 项测试全部通过。462 个文件／4035 项在工作区沙箱内通过；唯一因沙箱令
  `os.userInfo()` 返回 `ENOMEM` 的 `environment.test.ts`，单独提升权限后 9/9 通过，临时目录仍位于
  `Cyrene-Agent-N` 并已清理。
- 排除项为 `shell-job.test.ts`（真实子进程树）以及两个会写固定 `C:\cyrene-*` 的 Work Harness 测试；
  它们不属于本轮桌面 Chat／Collab 范围。首次无 Electron 覆盖路径的全量运行不计为产品失败。

## 数据隔离

所有完整 Electron 验收均把 `userData`、缓存、临时文件和外部桌面指向 `Cyrene-Agent-N` 的随机运行目录。
正式 Roaming／Local Cyrene、原项目 `UserData` 和备份目录只读校验，最终 `changedRoots=[]`；运行快照、
隔离模型配置和测试目录在退出后清除。本轮收口没有新增真实模型调用。

## 不属于当前复刻缺口

- 手动话题边界与多 persona／会话记忆命名空间是新增产品设计，不是本地版现有行为。
- 模型生成日程、日记与朋友圈联动是后续新增模块；当前 life-context 已按本地静态日程行为复刻。
- 多样本回复质量统计和真实截图外发评测属于质量／隐私专项，不改变当前功能完成结论。
- 系统级真实空闲时间、统一 LLM 队列、宿主 BGE-M3 和完整模型档案选择已有插件私有替代，不阻塞
  Chat／Collab 行为复刻。
