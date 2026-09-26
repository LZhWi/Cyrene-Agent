# Chat／Collab 复刻缺口审计（2026-09-19）

范围：只比较本地 `Cyrene-Agent` 的日常 Chat／Collab 管线与当前
`Cyrene-Agent-N/.upstream-latest` 的桌面 Chat。Work、Code、Learn、朋友圈、外部渠道和独立插件聊天
不属于本轮目标。本文同时记录已经落地的最小改造结论。

## 已由插件或现有最小宿主边界覆盖

- `companion-chat` 已提供本地人格稳定前缀、五套风格、本地内容加上游 V5.1 算法的 WorldBook、
  `[你的生活]` 和默认关闭的受控主动消息。
- `companion-memory` 已提供独立 L0/L1/L2、来源证据、历史原文绑定、词面／向量／重排检索、DMAE、
  Resolver、压缩、Reflection、生命周期、梦境草稿和 archived 冷召回。
- 自动提取已按当前目标改为每 10 个成功轮次一次，并只读附带此前最多 2 轮上下文。
- 后台候选收集、Resolver、压缩、Reflection、生命周期和近似空闲梦境均已提供默认关闭的插件调度；
  Resolver、压缩、生命周期和梦境叙事的自动应用分别需要第二重授权，并保留撤销或来源快照保护。
- 陪伴后端已旁路桌面 Chat 的上游原生记忆、关系上下文与关系回合记录、社交原子、`chat_history` RAG、
  原生记忆工具、原生 WorldBook 和本地主动消息，避免双重读取、写入、注入或投递；默认原生后端、
  外部渠道与其他模式不变。关系门禁的验证证据见
  [原生关系状态旁路验收记录](NATIVE-RELATIONSHIP-BYPASS-ACCEPTANCE-2026-09-20.md)。
- 动态提示词消费回执与最终消息落盘确认共同约束 WorldBook／记忆状态提交；取消、失败、截断或未落盘
  不推进插件私有状态。
- 本地“近期关系线索”已由插件从已保存的成功伴聊轮次只读派生，复用相同情绪与回应提示规则；不复制
  第二份聊天正文、不调用模型，也不启用上游会写宿主数据库的社交原子。桌面成功事件携带轮次开始时
  冻结的 `chatBackend`，插件只摄取明确为 companion 的回合，native 与旧宿主未标注事件均拒绝。
- 本地可选 `short_term/open_loop` 连续性已迁入插件私有存储：保持默认关闭、逐字用户证据、14 天／
  3 天 TTL、同会话相关检索、最多 3 条注入、显式回忆恢复和明确完成时关闭。抽取只发生在 companion
  成功落盘后；原生后端、渠道和其他模式不参与。通用 Prompt 输入现已提供宿主解析后的只读 IANA
  聊天时区，时间标签无需读取宿主私有配置即可与本地版跨时区对齐。
- 动态 Prompt Provider 现有通用 `priority` 顺序契约；两个陪伴插件明确声明 life=100、memory=200、
  WorldBook=300，使本地 Soul 的主要动态层稳定为“生活 → 记忆／历史／连续性 → WorldBook”，不再依赖
  插件目录扫描或启用顺序。旧 Provider 未声明时仍为 0，同值保持注册顺序。
- 陪伴桌面 Chat 的顶部状态徽标复用插件生成 life-context 的同一个活动源，显示“正在××／休息中”；
  它不建立第二份日程状态，也不改变模型上下文。原生后端、其他模式、面板打开及插件不可用时隐藏。

## 已完成的核心管线对齐

### 1. 带工具 Chat 的循环结构

本地版 `runTwoPhaseFcLoop` 是严格两阶段：

1. Tool 阶段只使用 `tools_system.md`、工具 schema 和对话；可执行多轮工具。
2. Tool 阶段没有 `tool_calls` 时，其自由文本不写入对话也不展示。
3. Soul 阶段换用完整人格与动态资料，不携带 tools，再请求一次模型生成最终回复。

桌面 Chat 现已保留 `CyreneHarness` 的工具执行能力，但使用 `handoff` 终态把已闭合工具 transcript 交给
无 tools 的 Soul 请求。Tool 阶段的自由文本和 reasoning 不进入用户回复；Tool 请求不含 Soul 人格，Soul
请求不含工具 schema 或调度规则。

桌面 Chat 即使本轮最终没有调用工具，也固定先完成 Tool 决策再生成 Soul 回复，与本地 Collab 的逐调用
结构一致。代价是每轮固定多一次模型请求、延迟和 token 消耗；这是用户明确选择的行为。

### 2. 稳定工具提示词的插件入口

`PluginStablePromptProvider` 已增加向后兼容的 `soul`、`tool`、`tone` 与 `soul-tail` 目标。陪伴插件分别
注入本地 Soul 人格、`tools_system.md`、`tone-rules.md` 和最终近端 `tone-anchor.md`；旧 Provider 缺省仍
进入 Soul。`tone` 继续复用上游场景匹配器，`soul-tail` 只在 Tool transcript 闭合后的最终 Soul 请求中
追加，不进入 Tool 阶段或持久化历史。插件同时提供只读按需记忆查询工具；屏幕观察通过
受限宿主服务返回视觉摘要，原始截图不写盘、不返回插件。

主程序 Chat 风格选择器现为唯一入口：五种内建 ID 通过稳定 Provider 映射到本地
`01_default` 至 `05_sweet` 文本；其正文与当前本地项目逐字符一致（仅工作区行尾格式可能不同）。
陪伴后端不再额外注入上游内建风格，插件设置页也不再保存第二套风格选择。`custom` 由插件提供无风格
基础人格、主程序注入自定义文本，避免重复或冲突；采样参数仍由主程序现有模型兼容逻辑决定。

风格收口离线验收：五份插件风格文件与当前本地项目归一化行尾后逐字符一致；主程序定向 59 项、插件
定向 43 项通过，插件完整验证 326 项与隔离宿主 7 项通过（13 项按环境条件跳过）；`build:main`、
插件类型检查、SDK schema／打包校验及三份插件产物 smoke 均通过。未启动 Electron、未访问正式用户
数据、未调用网络或真实模型。

时间结构也已按本地原有实现收口，但严格限定在桌面 `companion` Chat：用户与助手历史消息均使用
`[YYYY-MM-DD HH:mm, IANA/Timezone]` 方括号前缀，Soul 动态区保留本地“时间戳使用规则”和超过一小时
时的“对话时间信息”；运行环境只显示日期，分钟级当前时间仍作为最终 Soul 近端锚点保留。没有采用删除
前部重复绝对时间的优化。原生后端、渠道以及 Work、Code、Learn 继续使用上游时间结构。定向时间／构建
测试 69 项、两阶段相邻链路 106 项和 `build:main` 均通过；未启动 Electron、未访问用户数据或模型。

### 3. 非核心、可延后的宿主能力

系统级真实空闲时间、宿主统一 LLM 队列优先级、宿主 BGE-M3／向量库、完整模型档案选择，以及与原生
记忆库的同事务更新仍不在官方插件 API 中。当前插件已有私有替代实现；它们不阻塞桌面 Chat 的行为复刻，
不应为了本轮目标扩大主程序改动。

## 上游实现优于本地版的部分

上游 Harness 已具备本地 2FC 循环没有的通用执行能力：安全只读工具并发、重试与熔断、`ask_user` 排他、
未知非幂等副作用防重放、完整工具输出旁路保存、运行检查点／恢复、循环中上下文压缩和统一终态结算。
直接把上游带工具 Chat 替换为本地 `runTwoPhaseFcLoop` 会丢失这些能力，也会复制一套后续需要跟随上游
维护的工具执行器。

## 已采用的最小宿主改造

不移植或复制本地工具执行器，保留上游 Harness 作为唯一工具执行权威：

1. 为稳定提示词 Provider 增加可选目标层，允许陪伴插件提供 `tool`、`tone` 与 `soul-tail` 层；旧
   Provider 缺省仍是 `soul`，保持向后兼容。
2. 为 Harness 增加可选的 `handoff` 终态：模型不再调用工具时，丢弃该轮自由文本、不发最终回复，返回
   已闭合的工具 transcript；宿主随后用无 tools 的 `runChatLoop`、Soul 人格和同一动态资料生成最终回复。
3. 本地 Tool 规则已绑定单一 `companion-chat_memory_search`：涉及历史细节、稳定资料、长期偏好、持续
   目标或明确“回忆／想起来”时必须检索。没有恢复上游已删除的 `music_present_tracks` 链路。

桌面 Chat 已固定使用该两阶段路径，并默认暴露所有对 Chat 可见的已启用工具；上游 Chat 工具总开关已从
界面和运行时路径移除，逐工具 `override.chat=false` 仍作为紧急关闭口。Work、Code、Learn、朋友圈、渠道、
插件 Agent 继续使用上游原生路径。

## 验收条件

- Tool 请求不含 Soul 人格；Soul 请求不含 tools schema 或工具调度规则。
- Tool 最后一轮自由文本不进入历史、UI 或 Soul transcript；只有真实 tool call／tool result 保留。
- Soul 能读取完整、按序且经过上游截断策略处理的工具结果。
- 上游 Harness 的权限、重试、副作用、检查点、压缩和取消语义不退化。
- 仅 companion 桌面 Chat 命中新路径；所有原生路径的黄金投影保持不变。
- 跨插件动态层按显式优先级稳定拼接；Provider 仍并行生成，超时、预算和消费回执语义不变。
- 离线单元与完整隔离 Electron 测试通过，四个正式用户数据保护根哈希不变；真实模型验证仍保持一次性、
  限额和显式隔离。

2026-09-20 完整 Electron 合成轮次已通过：`ok=true`、`nativeTurnPassed=true`、
`promptProviderOrderPassed=true`、`nativeRelationshipBypassed=true`、`companionLifeStatusVisible=true`，四个保护根
`changedRoots=[]`，运行目录已清理。该轮没有复制真实数据，也没有调用网络或真实模型。

## 2026-09-20：梦境三阶段剩余差异与决策点

本地版 `runDreamCycle` 把下列行为绑定在一个总开关和同一次空闲周期中：

1. 按 active 300、工作集 800、`weight × 30 天时近度` 自动降级全部溢出项；
2. 只把本轮刚降级的最多 20 条记忆生成并直接保存为叙事；
3. 对 aging 向量以 0.82 阈值做种子聚类，最多请求 5 组；模型只要返回不少于 5 字的总结即自动合并。

插件已分别具备同参数的容量计划、梦境叙事、0.82 聚类和最多 5 组限制，但刻意保留了更严格的状态边界：

- 容量变更、叙事保存和压缩应用分别需要第二重授权，默认均关闭；
- 压缩每组限制为 3 至 5 条，并要求结构化 `mergeable`、置信度至少 0.80、完整覆盖确认，且来源与证据
  快照未变化；实际合并可严格撤销；
- 近似空闲梦境当前从既有 aging 条目中选择材料，而非只使用同周期容量计划刚降级的条目；若直接串联，
  会有重复叙述旧材料、与每 20 轮压缩调度重复处理的风险；
- 本地版在向量库不可用时连容量阶段也跳过，插件容量计划本身不依赖向量，能够独立工作。

因此不能简单同时启用原有三套调度。现已采用安全协调模式：

- 保留当前压缩门槛和每组 5 条上限；单一梦境周期按容量瘦身、本轮降级项叙事、aging 聚类压缩顺序运行，
  复用已有可撤销事务。独立的每 20 轮压缩只处理 active 0.85 候选，梦境尾段只处理 aging 0.82 候选；
  两者可同时启用但不会处理同一状态组，已有压缩复核组也会从后续候选中排除。
- 没有采用原版“模型输出有效文本即合并”：叙事保存和压缩应用仍分别授权，压缩继续要求置信度至少
  0.80、完整覆盖和来源快照未变化。用户活动会取消尚未完成的模型阶段，已提交的前置阶段不回滚。

## 2026-09-20：Tool 阶段收口与独立推理设置

桌面 Chat 两阶段链路继续保留上游 Harness，但 Tool 阶段现已收窄到本地等价职责：

- 只注入工具稳定规则、运行环境和恢复所需上下文，不再向 Tool 阶段提供 Soul 人格、插件记忆、
  WorldBook、生活上下文、计划 Skill、CITA response context 或 TODO 工作簿；这些资料仍只在 Soul 阶段使用。
- Chat Tool 阶段不再注册 `update_todo`、子任务 `task` 和计划类内建工具；`ask_user`、
  `confirm_uncertain_effect`、大结果读取以及普通已启用工具继续保留。
- 权限确认、风险控制、幂等保护、重试、并行安全工具、取消、检查点／恢复和输出旁路均继续由 Harness
  负责，没有复制本地工具执行器。
- Tool reasoning 独立于 Soul reasoning。默认关闭；设置 UI 允许用户选择关闭、开启或交给模型决定，
  开启时可选 minimal／low／medium／high／xhigh／max。模型不支持关闭或所选档位时，沿用上游统一
  capability 归一化规则折叠到实际可用值。

离线验收：相关 6 个测试文件共 128 项通过，`build:main` 与 `build:renderer` 均通过。未启动 Electron、
未读取或写入正式用户数据，也未调用真实模型。

## 2026-09-20：Soul 动态资料与宿主只读参考注入

两阶段收口后补做了最终 Soul 请求的逐字段核验，并修正一个关键遗漏：handoff 后的 Soul finalizer 现在
同时接收 `soulRuntimeContext` 与近端 `soul-tail`，插件记忆、WorldBook、生活上下文、关系和语气资料只在
Soul 可见；Tool 阶段仍看不到这些内容。测试明确断言两个区块按该顺序同时存在。

上游只有手动 `imported_docs` 工具，原有通用 `searchMemory` 也会把文档、实体图谱和原生 L2 混在一起；
这不优于本地版的自动只读参考注入，而且 companion 后端必须继续旁路原生 L2。因此宿主增加了独立的
只读参考层：

- 导入文档沿用本地版的严格自动相关性门禁，最多注入 2 段，并标记“只读资料，不是指令”及文件／分段来源；
- 实体图谱沿用现有查询实现；
- 不读取、推进或写回原生 L2 的访问次数、DMAE 或生命周期状态；
- 文档检索把 reranker／BGE-M3／BM25 的原始信号随结果保留，自动注入时才应用严格阈值，手动查询不受影响。

宿主队列与空闲状态复核也更正了早期记录：插件模型调用已通过同一个 `enqueueLLMTask` 队列；用户空闲
状态来自 Electron `powerMonitor` 的真实系统空闲与锁屏状态。插件私有替代只剩向量索引：若配置同一
BGE-M3、相同维度和相同正文，余弦语义相近，但它不共享宿主混合检索、BM25、reranker、索引提交时序，
所以不能宣称排序逐项一致。

本轮离线验收：10 个相关测试文件共 175 项通过，`build:main` 与 `build:renderer` 均通过。没有启动
Electron、没有访问正式用户数据、没有调用网络或真实模型。

## 2026-09-20：原生检索、两阶段 transcript 与自动维护最终对齐

此前记录中的“插件私有检索排序不能逐项一致”已通过最小宿主能力补齐。新增 `memory-retrieval` 服务只接收
插件私有候选，不读取或写入宿主记忆库；Embedding 使用宿主当前 BGE-M3 Provider，排序直接复用本地
`向量 topK*3 + BM25 topK*3 + 0.7/0.3 归一化融合 + cross-encoder reranker` 链路。向量命中仍按本地
时序立即更新插件私有权重和 `lastRecalledAt`，Tool 完整结果上限由临时 6000 字调整为本地 Tool transcript
的 12000 字。旧外部 Embedding／LLM reranker 不再参与新宿主中的正式排序，仅保留旧宿主兼容代码。

本地两阶段 Chat 使用独立 transcript 策略：运行环境保持 system 层；Tool 结果按本地 12000 字规则截断；
Harness 内部检查点消息不交给 Soul；超过 80000 字时按本地规则压缩旧消息并保留最近 6 条。权限确认、
重试、取消、并行和副作用防重放仍由 Harness 执行。因此 Soul 所见的工具 transcript 边界已与本地
2FC 对齐，而非继续沿用上游 Harness 的内部消息和压缩格式。

自动维护按本地执行语义恢复，同时保留插件事务层：

- 常规 compressor 只处理 `active`，0.85 全组凝聚；dream compressor 只处理 `aging`，0.82 种子聚类；
  两者均最多 5 组，来源都归档并生成一条 active 摘要。
- 两条链不再互相抑制，因为候选状态天然互斥；若候选生成后生命周期已改变，来源快照校验会拒绝旧提案，
  防止同一组被重复压缩。
- Resolver 对通过结构校验且无需澄清的本地计划自动应用，不再增加 0.90 置信门槛或把直接冲突强制留给
  人工；每次修改仍保存来源快照、结果和严格 `undo-plan`。
- 人工多来源合并继续使用 `merged/mergedInto`；本地常规压缩与 dream 原本都是 `archived`，不是
  `merged`。所有自动压缩仍记录审计项并可严格撤销。

离线验收：主项目相关 4 个测试文件 41 项通过，`build:main`、SDK schema 与 SDK 打包校验通过；插件完整
`verify` 通过 50 个测试文件／325 项（另 13 项按环境跳过）、7 项真实 PluginManager 隔离加载、全部构建和
产物 smoke。未启动 Electron、未访问正式用户数据、未调用网络或真实模型。

## 2026-09-20：Soul 请求消息结构与传输行为对齐

桌面 Chat 的最终 Soul 请求已继续按本地 2FC 收口，改动不进入 Tool、Work、Code、Learn 或渠道路径：

- Soul 固定使用非流式请求；模型完整返回后，界面一次性收到正文，不再模拟逐字揭示；
- 消息顺序恢复为本地结构：开头 system 为稳定人格加本轮动态资料，中间为已闭合的用户／工具
  transcript，`soul-tail` 作为生成点前最后一条独立 system；这些临时层均不写回持久化历史；
- OpenAI-compatible 多轮在厂商 capability 明确声明 `reasoning_content` 或 `thinking` 时，按本地行为回传
  assistant 的隐藏推理字段。该字段不进入可见 `content`；未声明支持的厂商绝不裸发；
- 上游 Responses 的无状态回放、Anthropic 原始 content block 回放、缓存身份和统一适配器继续保留。

风格采样保留上游实现，但默认风格明确保持本地参数口径：不发送 temperature、top-p 或重复惩罚，由模型
使用自身默认值；只有用户选择其他风格或自定义风格，并且当前模型在白名单中，才发送对应采样字段。

两阶段 Soul 失败已恢复本地诊断回复：显示中断原因以及 transcript 中已经完成的工具步骤和最多 200 字结果。
为避免诊断文本意外泄漏凭据，Bearer、`sk-` token、API key 和 Authorization 值会定向遮蔽；request id、
HTTP 状态和普通服务端错误正文仍保留，便于定位具体失败点。用户主动取消继续按取消处理，不生成伪失败回复。

该轮尚未改成本地的只有 system 内部区块位置：当时继续让稳定人格在易变环境／时间之前，以保留厂商前缀
缓存。后续已按用户选择改为本地顺序，见下方“Soul system 内部顺序对齐本地 2FC”。

本轮离线验收：Soul／Prompt／Build Options／OpenAI Adapter 共 5 个测试文件 128 项通过，`build:main`
通过。未启动 Electron、未访问正式用户数据、未调用网络或真实模型。

## 2026-09-21：风格与时间结构完整隔离 Electron 验收

两类隐藏 Electron 验收均使用合成数据和硬网络阻断，`APPDATA`、`LOCALAPPDATA`、`USERPROFILE`、`TEMP`
及 Electron `userData` 全部重定向到 `Cyrene-Agent-N` 的一次性运行目录。正式 Roaming、Local、项目
`UserData` 与 `UserData_backup` 四个保护根在运行前后哈希一致，均为 `changedRoots=[]`；两次运行目录均
在退出后清理。

- 合成 companion Chat 轮次确认：本地默认风格正文、用户与助手方括号时间戳、本地时间戳使用规则、
  日期型运行环境、末尾分钟级时钟、记忆摄取、Provider 顺序、原生关系旁路和生活状态全部通过；
- UI 宿主确认：主程序 Chat 显示 6 项唯一风格入口（五种内建加自定义），插件窗口没有旧
  `persona-style` 选择器并显示统一入口说明；
- 同轮顺带复核主动消息反馈默认关闭／显式开关、手动压缩模式、梦境与压缩双重授权以及共享压缩服务，
  `companionAcceptancePassed=true`。

UI 验收首次运行在已经过时的“梦境启用时独立压缩应被 suppressed”断言处失败；新增风格入口检查当时已经
通过，正式数据仍为 `changedRoots=[]` 且临时目录已清理。按当前 active／aging 分流实现修正验收断言后
重跑为 `ok=true`；合成 Chat 验收也为 `ok=true`。全程未复制真实数据、未调用网络或真实模型。

## 2026-09-21：非流式 Soul 全链路与一次性 Kimi K2.6 验收

受控模型验收器已与当前产品链路同步：Tool 阶段只接受流式请求，最终 Soul 阶段只接受不带 tools 的
非流式 JSON 请求。固定响应验收先独立跑通三轮原生 Chat：5 次 Tool 请求、3 次 Soul 请求、1 次隔离视觉
请求；记忆工具结果进入第二轮 Soul，屏幕观察结果进入第三轮 Soul，三轮回复均成功落盘并被插件摄取。
该轮 `fixtureCalls=9`、`liveCalls=0`、`unexpectedModelCalls=0`，最终报告为 `ok=true`。

随后只放行一次官方 `api.moonshot.cn` HTTPS 请求，使用原版配置中的 `kimi-k2.6`，其余 8 次请求继续由
固定响应接管。真实请求为最终非流式 Soul，请求不带工具，模型能够依据插件记忆回答；结果
`fixtureCalls=8`、`liveCalls=1`、`unexpectedModelCalls=0`、`finishReason=stop`，可见正文 11 字，隐藏推理
92 字，provider usage 为输入 9461、输出 58 tokens，测试侧输出上限为 512。最终回复成功保存且无
`tool_call`／`invoke` 标记泄漏，后续屏幕观察轮也正常闭环，最终报告为 `ok=true`。

第一次尝试真实验收时，旧脚本仍要求 Soul 流式返回，因此在网络放行前即拒绝，`liveCalls=0`；修正后又发现
外层汇总把受控模型模式重复套用普通原生轮次条件。两项均只属于验收脚本过时，并未改动产品链路。最终两轮
成功验收中，正式 Roaming、Local、项目 `UserData` 与 `UserData_backup` 四个保护根均为
`changedRoots=[]`，密钥未出现在输出中，所有一次性运行目录均在退出后清除。

## 2026-09-21：Soul system 内部顺序对齐本地 2FC

陪伴桌面 Chat 不再沿用“稳定人格在前、动态资料在后”的上游缓存优先顺序，改为与本地 2FC 一致的单条
首部 system：环境与 Soul 工具阶段结束约束 → 对话时间规则 → 完整人格与所选风格 → 语气规则 →
life/记忆/WorldBook 插件资料 → 文档与实体引用 → 附件。最终分钟级时钟与 `tone-anchor` 仍作为 transcript
之后的独立 system，Tool 阶段仍只看到工具规则和环境，不会看到人格、语气或自动注入记忆。

该变化只作用于 `chatBackend=companion` 的桌面 Chat。原生 Chat、渠道、Work、Code、Learn 继续使用上游
分层和顺序。陪伴路径同时停止执行原生 `buildAlwaysOnContext`，改为只走一次专用只读文档/实体引用入口，
避免同一文档或实体命中被重复检索和重复注入；原生路径不变。

离线验收：时间、Build Options、ChatLoop、CyreneAgent、Harness Adapter、两阶段 transcript 和 OpenAI
Adapter 共 8 个测试文件 176 项通过，`build:main` 通过。新增黄金顺序测试锁定上述七个区块的相对位置、
空 `soulRuntimeContext`、原生引用链不执行以及 Tool 阶段不泄漏插件记忆。

原版 Cyrene 退出后完成两轮隔离 Electron 复验。合成原生 IPC 回合确认完整 Soul system 中环境／时间规则、
人格、默认风格、life-context、插件记忆、WorldBook 的顺序正确，历史消息使用本地方括号时间戳，末尾分钟级
时钟保留，原生关系记忆继续旁路；结果为 `nativeTurnPassed=true`、`promptProviderOrderPassed=true`。
受控模型 UI 回合以固定本地响应完成 5 次 Tool、3 次非流式 Soul 和 1 次隔离视觉请求，记忆查询与屏幕观察
工具结果均进入 Soul，三轮回复均成功落盘并被插件摄取；结果为 `fixtureCalls=9`、`liveCalls=0`、
`unexpectedModelCalls=0`、`boundedModelPassed=true`。

首次原生复验失败是验收脚本仍从已清空的 `soulRuntimeContext` 查找动态区块，并非产品链路缺失；改为检查
合并后的 `soulSystemBaseContent` 和带时间戳的历史消息后重跑通过。两轮正式 Roaming、Local、项目
`UserData` 与 `UserData_backup` 四个保护根均为 `changedRoots=[]`，临时快照及运行目录均在退出后清理，
没有调用网络或真实模型。
