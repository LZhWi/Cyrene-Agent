---
name: cyrene-learn-mode-obsidian-mvp
overview: 为 Cyrene 的 Learn 模式实现 Obsidian 知识库接入 MVP：复用 chat 的 TwoPhaseFC Loop，新增 6 个 Obsidian 工具 + Learn 专属 Skills + 静默学习进度更新，不含 langgraph。
todos:
  - id: unblock-learn-routing
    content: Unblock Learn 模式路由：修改 agui-bridge.ts 移除 learn 拒绝、cyrene-agent.ts 的 resolveExecutionMode 识别 learn、build-options.ts 检测 learn 模式走 chat prompt 路线并强制 legacy runtime
    status: completed
  - id: create-learn-prompt
    content: 创建 Learn 模式 Prompt 体系：新建 prompts/learn_system.md（基于 chat_system.md + 学习教学规则），修改 index.ts 的 buildSystemPrompt 在 learn 模式下加载 chat_system.md
    status: completed
    dependencies:
      - unblock-learn-routing
  - id: add-learn-to-react-session
    content: 修复 React 渲染进程：openSessionByDeps.ts 添加 learn 到 ReactSessionMode，确认 ChatPage.tsx 的 ModeSwitch 和 getConversationMode 类型兼容
    status: completed
    dependencies:
      - unblock-learn-routing
  - id: create-obsidian-core
    content: 构建 Obsidian 核心模块：obsidian-markdown.ts（AST 解析+标题树）、obsidian-workspace-service.ts（文件 IO+搜索+章节读写）、obsidian-open.ts（obsidian:// 协议）
    status: completed
  - id: register-obsidian-tools
    content: 注册 6 个 Obsidian 工具到 ToolRegistry：obsidian_list_files、obsidian_search、obsidian_read_file、obsidian_read_section、obsidian_edit、obsidian_open_note，条件暴露仅在 learn 模式且 Vault 有效时
    status: completed
    dependencies:
      - create-obsidian-core
      - unblock-learn-routing
  - id: create-progress-module
    content: 创建静默学习进度模块：learn-progress-extractor.ts（轻量结构化模型调用）、learn-progress-service.ts（读写 progress.md）、learn-progress-types.ts（类型定义）
    status: completed
    dependencies:
      - unblock-learn-routing
  - id: wire-post-turn-hook
    content: 接入 LearnPostTurnHook：在 agui-bridge.ts 的 onAgentRunFinished 后追加，非阻塞异步执行，失败不影响正常回复
    status: completed
    dependencies:
      - create-progress-module
      - unblock-learn-routing
  - id: create-learn-skills
    content: 使用 [skill:skill-creator] 创建 Learn 专属 Skills：cyrene-learn-tutor/SKILL.md，指导模型如何整理学习资料、追踪学习进度、复习策略、教学方法
    status: completed
    dependencies:
      - register-obsidian-tools
  - id: integration-testing
    content: 端到端集成验证：Unblock 后创建 learn 会话 → 绑定 Vault → 测试读取笔记章节 → 测试编辑回写 → 验证进度更新 → 确认 Skills 注入
    status: completed
    dependencies:
      - wire-post-turn-hook
      - create-learn-skills
      - add-learn-to-react-session
---

## 用户需求

为 Cyrene 的 Learn 模式接入 Obsidian 知识库管理能力，使其成为一个功能完整的 AI 学习助手。

## 产品概述

Learn 模式**直接照搬 Daily 模式的执行逻辑**（executionMode = "work" + agentRuntime = "legacy" + TwoPhaseFC），在此基础上新增 Obsidian Vault 读写工具、静默学习进度追踪，以及 Learn 专属的 Skills 指导模型如何教学。

**不新增 Prompt 文件**：复用 daily 已有的 prompt 体系（即 `work_system.md`），不在 `buildSystemPrompt` 中增加 learn 分支，只在 `agui-bridge.ts` 的路由层把 learn 当做 daily 处理。

## 核心功能

- **Unblock Learn**：`agui-bridge.ts` 中移除 learn 的拒绝逻辑，把 learn 并入 daily 的执行路径
- **Obsidian 工具集**：6 个工具（list_files、search、read_file、read_section、edit、open_note），按标题路径精准读取 Markdown 章节，仅 `mode === "learn"` 时暴露
- **静默进度更新**：每轮回复后轻量结构化模型调用，更新 learn/progress.md，失败不影响正常回复
- **Learn Skills**：一组按需调取的 Skills，指导模型如何整理资料、追踪进度、复习、教学
- **路径安全**：Vault 沙箱、原子写入、contentHash 冲突检查

## 技术栈

- 语言：TypeScript（主进程 + 渲染进程）
- Markdown 解析：unified + remark-parse（AST 方案，不用正则）
- 运行链：直接复用 daily 的 TwoPhaseFC Loop（`agentRuntime = "legacy"`）
- Prompt 体系：复用 daily/work 的现有 `work_system.md`，不新增 prompt
- 工具注册：复用现有 `ToolRegistry`，按 `mode === "learn"` 条件暴露

## 实现方案

### 核心策略：Learn = Daily + Obsidian

Learn 不是独立 Agent 链，是 Daily 模式的超集：

1. **agui-bridge.ts 路由**：`mode === "learn"` 走和 daily 完全一样的路径：

- `agentExecutionMode = "work"`
- `agentRuntime = "legacy"`（TwoPhaseFC）
- `optimizeFirstRound = true`
- 需要 workspaceBinding

2. **不新增 prompt 分支**：不创建 `learn_system.md`，不改 `buildSystemPrompt`，learn 直接吃 daily 的 `work_system.md`
3. **工具暴露**：Obsidian 工具仅在 `mode === "learn" && obsidian.enabled && vaultPath 有效` 时注册到 `toolRegistry`
4. **进度更新**：在 `onAgentRunFinished` 后追加 `LearnPostTurnHook`，异步非阻塞

### 关键决策

1. **为什么照搬 daily**：daily 已经是 `executionMode = work + legacy runtime + TwoPhaseFC`，这正是 learn 需要的——有工具、不走 langgraph。用户明确要求照搬。
2. **为什么不加 prompt**：daily 用的 `work_system.md` 已经足够；learn 的教学行为由 Skills 的按需注入来引导，不需要单独的系统 prompt。
3. **为什么强制 legacy runtime**：用户明确要求不走 LangGraph，TwoPhaseFC 足够处理 Learn 的工具交互。

### 性能与可靠性

- 进度提取使用轻量结构化模型调用（单轮、小 budget），不阻塞主回复
- 进度更新失败仅 log warn，永不抛出异常上浮
- Markdown AST 解析仅在需要按标题读写时触发，常规搜索/列表不走 AST
- 原子写入保证 Obsidian 用户正在读取的文件不会被损坏

## Agent Extensions

### Skill

- **skill-creator**
- 用途：参考 skill 创建模板和规范，指导 Learn 教学类 Skills 的编写
- 预期结果：产出符合 Cyrene Skill 规范的 SKILL.md 文件，包含教学策略、资料整理、进度追踪、复习方法等指导规则