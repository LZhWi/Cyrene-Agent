# Cyrene 提示词缓存分层设计

日期：2026-08-14

状态：待用户审查

范围：Chat、Work、Learn、Code、Task 子代理的模型请求组装与厂商缓存提示

## 1. 背景

Cyrene 已能从模型响应的 `usage` 中读取输入、输出和缓存命中 token，也已经具备部分厂商缓存支持：

- Anthropic 协议对 Claude、MiniMax 的 system block 添加 `cache_control: ephemeral`；
- Kimi 的 OpenAI 兼容请求添加 `prompt_cache_key`；
- 其他 OpenAI 兼容厂商依赖服务端自动前缀缓存。

当前主要问题不是缺少统计，而是请求前缀不够稳定。Harness 每轮把 Todo 拼入 system prompt；时间、环境、关系、记忆、临时 Skill 等动态信息也可能进入前部 system 内容。任意一处变化都可能使厂商无法复用已经缓存的提示词前缀。

本设计只优化 Prompt Cache（提示词缓存）命中，不实现模型回复缓存，也不复用旧回答。

## 2. 设计目标

1. 固定人设、模式规则和工具规范形成稳定前缀。
2. 工作区、权限和可用能力形成 Run 内稳定的会话前缀。
3. Todo、时间、进度和临时状态只作为请求末尾的动态上下文。
4. 动态上下文只在发送请求时注入，不写入真实对话历史。
5. Chat、Harness 和 Task 子代理通过同一个组装边界生成请求。
6. 厂商未返回缓存统计时保持“暂无数据”，不估算缓存命中。
7. 不减少模型当前能够看到的信息，不改变 Agent 的结束权、工具调用语义和取消语义。

## 3. 非目标

- 不在本阶段引入独立 Cache Manager。
- 不缓存或复用模型最终回答。
- 不为每个中转站维护价格与缓存计费表。
- 不修改上下文压缩算法，只保证压缩后重新建立稳定前缀。
- 不要求所有厂商都支持显式缓存；不支持时仍保持正确的消息顺序。

## 4. 核心模型

### 4.1 三层提示词

新增统一结构：

```ts
interface PromptLayers {
  stablePrefix: string;
  sessionPrefix?: string;
  runtimeContext?: string;
}
```

#### stablePrefix

只有发布版本、用户固定配置或模式规则变化时才变化：

- Cyrene 人设或精简人设；
- Chat / Work / Learn / Code 固定规则；
- Harness 协议和工具使用规范；
- Ask、Todo、Skill、内部上下文保护规则；
- Task 子代理固定 Profile；
- 提示词格式版本号。

#### sessionPrefix

一个对话或 Run 内保持稳定，切换工作区、权限或能力配置时允许变化：

- 当前模式；
- 绑定工作区；
- 权限与沙箱策略；
- 固定排序后的工具目录和 Skill 路由目录；
- 模型能力配置；
- Task 子代理身份与可用能力。

#### runtimeContext

每轮允许变化，只能作为后缀：

- Todo 当前快照；
- 当前时间和距离上一条消息的时间信息；
- 当前进度和本轮阶段；
- `uncertainEffects`；
- 动态关系、记忆、环境和附件信息；
- 被激活 Skill 的完整正文；
- Git 当前变化摘要；
- 子代理结果和临时运行状态。

### 4.2 类型层约束

逐步废弃调用方直接传入总字符串：

```ts
systemPrompt: string;
```

主模型循环改为接收：

```ts
prompt: PromptLayers;
```

唯一允许产生最终 wire request 的入口为：

```ts
composeModelRequest(prompt, messages, tools, providerCapability)
```

Harness、Chat Loop、Task Runtime、记忆辅助调用不得各自重新决定三层顺序。

## 5. 消息顺序

统一逻辑顺序：

```text
1. stablePrefix
2. sessionPrefix
3. 已持久化的真实 conversation messages
4. runtimeContext 临时消息
```

`runtimeContext` 使用明确的私有标签：

```xml
<runtime_context>
...
</runtime_context>
```

稳定前缀必须包含现有 Internal Context Policy，明确该内容仅供推理，禁止在用户可见回复中复述。

动态消息是 wire-only：

```text
compose request
  -> 临时追加 runtimeContext
  -> 发送给厂商
  -> 丢弃临时消息
```

它不得进入：

- `messages[]` 持久历史；
- checkpoint transcript；
- Chat 数据库存储；
- 下一轮由历史恢复出的真实消息。

## 6. 不同模式的归类

### 6.1 Chat

`stablePrefix`：完整人设、Chat 行为规则、内部上下文规则。

`sessionPrefix`：用户固定设置、模型能力。

`runtimeContext`：关系记忆、时间、社会上下文、附件、临时情绪和环境。

### 6.2 Work

`stablePrefix`：精简人设、Work 规则、Harness 规则、工具与 Todo 规范。

`sessionPrefix`：工作区、权限模式、工具目录、Skill 目录。

`runtimeContext`：Todo、进度、临时 Skill、时间、未确定副作用。

### 6.3 Code

`stablePrefix`：精简人设、Code 规则、Harness 规则、代码施工规范。

`sessionPrefix`：代码工作区、权限、沙箱、工具、Skill、LSP 能力目录。

`runtimeContext`：Todo、分支与 Git 变化、临时 Skill、子代理结果。

完整 Diff 或文件内容不得进入稳定前缀。

### 6.4 Learn

`stablePrefix`：精简人设、Learn 教学规则、Harness 规则。

`sessionPrefix`：学习项目、学习结构、可用工具和 Skill。

`runtimeContext`：当前章节、学习进度、Todo、近期掌握情况。

### 6.5 Task 子代理

`stablePrefix`：子代理通用协议与固定 Profile。

`sessionPrefix`：选定黄金裔身份、工具能力和父任务边界。

`runtimeContext`：本次委托、父任务摘要、后续追加指令和当前 Todo。

子代理生命周期上下文可以保留，但每次追加指令仍只能进入动态后缀。

## 7. 工具与 Skill 稳定性

工具定义属于请求前缀的一部分，必须满足确定性：

1. 工具按规范化 `name` 固定排序。
2. JSON Schema 使用稳定字段顺序序列化。
3. 同一模式下不能因 Map、Set 或文件扫描顺序改变工具排列。
4. 临时权限由 Runtime 执行门控制，不通过随机删除工具描述表达。
5. Skill 路由目录可进入 `sessionPrefix`。
6. 被激活 Skill 的完整正文进入 `runtimeContext`。
7. 不在抽取池中的子代理名字属于动态能力状态，不进入全局稳定前缀。

## 8. 厂商策略

### 8.1 Anthropic 协议：Claude 与 MiniMax

把 `stablePrefix + sessionPrefix` 作为可缓存 system block，并保留：

```json
{
  "type": "text",
  "text": "<stable and session prefix>",
  "cache_control": { "type": "ephemeral" }
}
```

`runtimeContext` 作为末尾临时消息发送，不能进入该 system block。

第一阶段不扩展工具定义上的额外缓存断点；如后续要做，必须先根据当前 SDK 类型和官方协议验证支持范围。

### 8.2 OpenAI 与 OpenAI 兼容厂商

依赖服务端自动前缀缓存。Cyrene 保证以下内容在相同配置下字节级稳定：

- stable system；
- session system；
- 工具顺序与 Schema；
- 未被压缩改写的历史前缀。

### 8.3 Kimi

`prompt_cache_key` 使用稳定指纹：

```text
cyrene:<provider>:<model>:<mode>:<promptVersion>:<stablePromptHash>:<toolSchemaHash>
```

缓存键不得包含：

- `conversationId`；
- `runId`；
- 时间；
- Todo；
- 用户输入；
- 当前轮数。

### 8.4 未明确支持缓存的厂商

不发送未经验证的厂商私有字段，只保持稳定前缀。缓存是否生效以厂商返回的 usage 为准。

## 9. Harness 数据流

旧流程：

```text
base system + Todo
  -> 每轮生成新的 roundSystemPrompt
  -> callLLM
```

新流程：

```text
Run 启动
  -> 构造 stablePrefix
  -> 构造 sessionPrefix

每一轮
  -> 从 state 生成 runtimeContext
  -> composeModelRequest
  -> 临时注入动态后缀
  -> callLLM
  -> 只把 assistant / tool result 写入历史
```

Todo 更新不再改变稳定 system 的 hash。

上下文压缩仍可改变历史前缀，因此压缩后的第一次请求允许重新预热缓存；之后的轮次继续复用新前缀。

## 10. 错误与降级

- `runtimeContext` 为空时不创建空消息。
- 厂商拒绝缓存私有字段时，按现有明确不支持逻辑降级，但不得重放已经产生增量的半截请求。
- 缓存键生成失败时回退为无显式缓存键，不阻断模型调用。
- 提示词组装器不得吞掉任何原有上下文；迁移时使用快照测试核对信息完整性。
- 厂商没有返回缓存字段时，统计 UI 显示“暂无数据”；返回明确 0 时显示 0。

## 11. 测试与验收

### 11.1 纯函数测试

- 相同稳定配置产生相同 `stablePrefix` 和缓存指纹。
- Todo、时间和进度变化只改变 `runtimeContext`。
- 工具输入顺序变化不会改变规范化后的工具 Hash。
- 动态上下文为空时不生成临时消息。

### 11.2 循环测试

- Harness 连续两轮更新 Todo，system 前缀完全一致。
- Ask、工具结果、Todo、子代理结果在下一轮仍可见。
- 临时 runtime message 不进入 checkpoint 和持久历史。
- Chat、Work、Learn、Code 的提示词快照符合各自分层。
- Task 子代理追加任务时不重建稳定前缀。

### 11.3 厂商适配器测试

- Claude / MiniMax 只缓存稳定 system block。
- Kimi 缓存键不含会话、Run、时间和 Todo。
- OpenAI 兼容请求保持稳定工具排序。
- 不支持缓存的厂商不收到未知私有字段。

### 11.4 运行验收

- 调整前后模型可见信息集合不减少。
- 模型工具选择、最终回复、Ask 和取消行为无回归。
- 同一长任务多轮推进时，支持缓存的厂商开始返回缓存命中 token。
- 缓存统计只使用厂商返回值，不做本地估算。

## 12. 迁移顺序

1. 引入 `PromptLayers` 和纯函数组装器，不改变现有输出。
2. 迁移 Harness，把 Todo 移至 wire-only `runtimeContext`。
3. 迁移 Chat，并将关系、时间、附件等动态内容后移。
4. 迁移 Task 子代理。
5. 固定工具和 Skill 目录排序。
6. 更新 Anthropic 缓存边界与 Kimi 缓存键。
7. 增加缓存前缀诊断 Hash，仅写日志，不记录提示词正文。
8. 运行全量测试和四模式人工验收。

## 13. 冻结不变量

1. 稳定内容永远位于动态内容之前。
2. Todo 永远不进入可缓存 system block。
3. 动态上下文永远不进入持久历史。
4. Runtime 仍只负责执行安全，不以缓存为由改变 Agent 决策。
5. 缓存优化不得改变工具调用、Ask、取消、结算和副作用安全语义。
6. 缓存命中数据只信任厂商响应。
