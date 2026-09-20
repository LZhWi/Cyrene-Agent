# 桌面 Chat 两阶段管线隔离验收（2026-09-19）

## 结论

桌面原生 Chat 已按本地 Collab 目标采用严格的 `Tool → Soul` 两阶段结构，并在完整 Electron 页面中通过合成数据、真实数据快照和一次受控 Kimi K2.6 请求验收。Work、Code、Learn、朋友圈和渠道模式不在本次改动范围内。

本次测试没有修改正式用户数据。Roaming Cyrene、Local Cyrene、原项目 `UserData` 和 `UserData_backup` 四个保护根在每次运行前后均进行完整内容校验，最终 `changedRoots=[]`。一次性快照、隔离会话、截图、缓存和模型配置副本均位于 `Cyrene-Agent-N/local-plugins/.test-runtime/` 的随机 `run-*` 目录，退出后已清除。

## 覆盖范围

- 普通聊天也先经过 Tool 阶段；无工具时丢弃工具决策文本，只由 Soul 生成用户可见回复。
- 记忆问题由 `companion-chat_memory_search` 在 Tool 阶段只读查询，结果进入 Soul transcript。
- 屏幕问题由 `companion-chat_screen_observation` 在 Tool 阶段执行；截图不写盘、不返回插件。本次视觉请求使用隔离固定回包，图片没有外发。
- 三轮回复都从原生 Chat 页面发送、保存到隔离会话，并由记忆插件在成功终态后摄取。
- 上游 Chat 工具总开关不参与桌面 Chat 能力解析；单项工具覆盖仍可作为紧急禁用手段。

## 验收数据

### 零外发合成彩排

- Tool 阶段：5 次。
- Soul 阶段：3 次。
- 固定模型回包：9 次，其中视觉固定回包 1 次。
- 真实模型请求：0 次；意外请求：0 次。
- 记忆工具和屏幕观察工具均实际执行，最终回复均正常落盘并被插件摄取。

### 真实数据快照零外发彩排

- 快照源数据约 7.35 GB；复制前后内容一致，退出后删除。
- 导入对账：L2 150 条、证据 144 条、DMAE 状态 132 条、1024 维向量 120 条。
- 记忆 Tool 结果：8 条、3561 字符；目标记忆正文进入 Soul 请求。
- Tool 阶段 5 次、Soul 阶段 3 次、视觉固定回包 1 次。
- 真实模型请求 0 次；意外请求 0 次。
- `nativePromptInjectionPassed=true`、`boundedModelPassed=true`、`changedRoots=[]`。

### 一次受控 Kimi K2.6 验收

- Tool 阶段全部使用固定回包；只有第二轮 Soul 请求访问 `api.moonshot.cn/v1/chat/completions`。
- 真实 Kimi 请求：1 次；意外模型请求：0 次；输出上限 4096。
- 发送给 Soul 的真实记忆范围仍为 8 条、3561 字符。
- 流结束原因 `stop`；可见回复 64 字符，推理文本只记录长度 2780 字符。
- 模型上报输入 12207、输出 1631 token。
- 回复成功保存、无工具协议泄漏，并由插件摄取。
- 密钥、请求体、真实记忆正文、模型回复和推理正文均未写入报告或日志。
- `boundedModelPassed=true`、`realSnapshotMemoryInjected=true`、`changedRoots=[]`，临时快照与隔离密钥副本已清除。

## 验收中发现并修复的问题

1. `searchForTool` 复用本地检索计划：普通语义 Top 5，普通 DMAE 最终最多 10 条，范围清单最多 13 条/3000 正文字符，穷举清单最多 20 条/4000 正文字符；格式化后的完整工具块另设 6000 字符硬保护。保持 `commit:false`，工具预览不会提前推进 DMAE 或激活状态。
2. 上游 Harness 的模型可见工具 observation 同时携带相同的 `message`、`preview`、`output`，导致正文在下一轮和 Soul handoff 中重复三次。现只保留单一 `output`；完整输出引用与 checkpoint 仍独立保存。
3. 隔离入口已升级为两阶段状态机，能分别校验 Tool、Soul、记忆工具、屏幕工具、视觉请求和唯一真实模型请求，不再依赖旧的单阶段 ChatLoop 假设。

## 尚未证明的内容

- 本次证明单个真实记忆样本能经过 Tool→Soul 生成有效回复，不等于多样本回复质量已与旧本地版完全等价。
- 屏幕观察验证了完整工具链、后台变化检测和宿主视觉边界，但验收没有把真实截图发送给外部视觉模型；
  这是隐私边界，不是当前功能缺口。
- 后台周期屏幕观察、life-context、主动消息与天气场景后来均已完成并通过独立 Electron 隔离验收，
  不再属于剩余差距；见 [主动消息与天气验收](PROACTIVE-WEATHER-ACCEPTANCE-2026-09-20.md)和
  [生活状态显示验收](LIFE-STATUS-ACCEPTANCE-2026-09-20.md)。
