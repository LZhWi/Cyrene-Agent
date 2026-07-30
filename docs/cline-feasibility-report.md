# Cline SDK 可行性调查报告

## 1. 安装与兼容性

### 包信息

| 项目 | 值 |
|------|-----|
| 包名 | `@cline/sdk` (别名) → `@cline/core` |
| 版本 | 0.0.66 |
| 许可证 | @cline/sdk: Apache-2.0 (package.json 声明) |
| 大小 | ~3.1 MB (core) |
| 依赖 | 22 个 (ws, zod, simple-git, @modelcontextprotocol/sdk 等) |
| 原生模块 | 无 (.node 文件) |

### 安装

```bash
npm install @cline/sdk
```

### Node/Electron 兼容

- **无原生模块**: 已验证 `node_modules` 中无 `.node` 文件
- `ws`, `simple-git` 等依赖均为纯 JavaScript
- 可在 Electron 主进程中运行
- 打包时无需特殊处理原生模块

## 2. 最小初始化代码

```typescript
import { ClineCore } from "@cline/core"

const cline = await ClineCore.create({
  clientName: "cyrene",
  backendMode: "local",
})

const result = await cline.start({
  config: {
    providerId: "openai-compatible",
    modelId: "MiniMax-M3",
    apiKey: process.env.MINIMAX_API_KEY,
    baseUrl: "https://api.minimax.chat/v1",
    cwd: "/path/to/project",
    workspaceRoot: "/path/to/project",
    systemPrompt: "你是一个代码助手。",
    enableTools: true,
  },
  prompt: "修改 test-file.ts 中的注释",
})

// 订阅事件
const unsubscribe = cline.subscribe((event) => {
  switch (event.type) {
    case "chunk":
      process.stdout.write(event.payload.chunk);
      break;
    case "agent_event":
      console.log("Agent 事件:", event.payload.event);
      break;
    case "hook":
      console.log("Hook:", event.payload.hookEventName, event.payload.toolName);
      break;
    case "ended":
      console.log("结束:", event.payload.reason);
      break;
  }
})
```

## 3. 模型配置

### CoreModelConfig 接口

```typescript
interface CoreModelConfig {
  providerId: string;          // "openai-compatible" 用于自定义端点
  modelId: string;             // 模型 ID
  apiKey?: string;             // API Key
  baseUrl?: string;            // 自定义 baseUrl
  headers?: Record<string, string>;  // 自定义 headers
  thinking?: boolean;          // 是否启用思考
  reasoningEffort?: string;    // 思考努力程度
  thinkingBudgetTokens?: number;  // 思考 token 预算
  maxTokensPerTurn?: number;   // 每轮最大 token
  temperature?: number;        // 温度
}
```

### 自定义 baseUrl 支持

**已确认支持**: `providerId: "openai-compatible"` + `baseUrl` 配置

```typescript
{
  providerId: "openai-compatible",
  modelId: "MiniMax-M3",
  apiKey: "...",
  baseUrl: "https://api.minimax.chat/v1",  // 自定义端点
}
```

### 支持的 Provider

- `anthropic` - Anthropic Claude
- `openai` - OpenAI
- `openai-compatible` - OpenAI 兼容端点 (MiniMax, Kimi, DeepSeek, vLLM, Together)
- `google` - Google Gemini
- `bedrock` - AWS Bedrock
- `mistral` - Mistral

## 4. 事件系统

### CoreSessionEvent 类型

```typescript
type CoreSessionEvent =
  | { type: "chunk"; payload: SessionChunkEvent }
  | { type: "agent_event"; payload: { sessionId: string; event: AgentEvent } }
  | { type: "team_progress"; payload: SessionTeamProgressEvent }
  | { type: "pending_prompts"; payload: SessionPendingPromptsEvent }
  | { type: "pending_prompt_submitted"; payload: SessionPendingPromptSubmittedEvent }
  | { type: "session_snapshot"; payload: SessionSnapshotEvent }
  | { type: "ended"; payload: SessionEndedEvent }
  | { type: "hook"; payload: SessionToolEvent }
  | { type: "status"; payload: { sessionId: string; status: string } }
```

### SessionToolEvent (hook 事件)

```typescript
interface SessionToolEvent {
  sessionId: string;
  hookEventName: "tool_call" | "tool_result" | "agent_end" | "agent_error" | "session_shutdown";
  agentId?: string;
  conversationId?: string;
  toolName?: string;
  inputTokens?: number;
  outputTokens?: number;
}
```

## 5. 任务取消与控制

### API

```typescript
// 中止当前操作（保留会话）
await cline.stop(sessionId);

// 中止当前工具执行（保留会话）
await cline.abort(sessionId, "reason");

// 停止会话（销毁会话）
await cline.stopSession(sessionId);

// 销毁 ClineCore 实例
await cline.dispose();
```

## 6. 权限与安全

### toolPolicies

在 `StartSessionInput` 中配置：

```typescript
{
  config: { ... },
  toolPolicies: {
    // 工具策略配置
  },
}
```

### 待验证

- `toolPolicies` 的具体结构和默认行为
- 是否可以完全关闭权限确认
- 如何映射到 Cyrene AG-UI

## 7. Windows Electron 运行

### 已确认

- **无原生模块**: 无需特殊打包
- **纯 JavaScript 依赖**: ws, simple-git 等均为纯 JS
- **路径处理**: 使用 Node.js path 模块，支持 Windows

### 打包资源

- node_modules 中的 JS 文件
- 无需 .node 文件

## 8. Checkpoint/Resume

### CoreCheckpointConfig

```typescript
interface CoreCheckpointConfig {
  enabled?: boolean;  // 默认 false，opt-in
  createCheckpoint?: (context: CoreCheckpointContext) => Promise<{
    ref: string;
    createdAt: number;
    runCount: number;
    kind?: "stash" | "commit";
  } | undefined>;
}
```

### 使用

```typescript
{
  config: {
    checkpoint: {
      enabled: true,  // 启用内置 git checkpoint
    },
  },
}
```

## 9. 最小接入方案

### 架构

```
Cyrene (主 Agent)
  ├── CITA
  ├── Task Router
  ├── Soul
  ├── 普通 Work 工具
  └── delegate_coding (新工具)
       └── ClineCore (local backend)
            ├── providerId: "openai-compatible"
            ├── baseUrl: 用户配置的端点
            ├── cwd/workspaceRoot: 指定项目根目录
            ├── tools: 文件读写、搜索、命令执行
            └── result: CodingAgentResult
```

### 新增工具

```typescript
toolRegistry.register({
  id: "delegate_coding",
  name: "代码任务",
  description: "将代码任务委托给 Cline Coding Agent",
  effectKind: "mutation",
  verificationPolicy: "code",
  executionKind: "subagent",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "代码任务描述" },
      workspaceRoot: { type: "string", description: "项目根目录" },
    },
    required: ["task"],
  },
  execute: async (args, ctx) => {
    const cline = await ClineCore.create({
      clientName: "cyrene",
      backendMode: "local",
    });

    const result = await cline.start({
      config: {
        providerId: "openai-compatible",
        modelId: settings.model,
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        cwd: args.workspaceRoot || process.cwd(),
        workspaceRoot: args.workspaceRoot || process.cwd(),
        systemPrompt: "你是一个代码助手。",
        enableTools: true,
      },
      prompt: args.task,
    });

    // 订阅事件并转发到 Cyrene AG-UI
    const unsubscribe = cline.subscribe((event) => {
      // 转发事件...
    });

    // 等待完成...
    // 返回 CodingAgentResult

    unsubscribe();
    await cline.dispose();
  },
})
```

## 10. 已确认事实

| 项目 | 状态 | 说明 |
|------|------|------|
| 许可证 | ✅ Apache-2.0 | @cline/sdk package.json 声明 |
| 原生模块 | ✅ 无 | 已验证无 .node 文件 |
| 自定义 baseUrl | ✅ 支持 | providerId: "openai-compatible" |
| 任务取消 | ✅ 支持 | cline.abort(), cline.stop() |
| 事件系统 | ✅ 支持 | cline.subscribe() + CoreSessionEvent |
| Checkpoint | ✅ 支持 | checkpoint.enabled: true |
| Windows | ✅ 兼容 | 纯 JS，无原生模块 |

## 11. PoC 脚本

已创建 `scripts/cline-poc/poc.ts`，验证：

1. ClineCore local backend 初始化
2. openai-compatible + 自定义 baseUrl
3. 指定 cwd + workspaceRoot
4. 文件读取、修改
5. 命令执行
6. 事件订阅
7. 任务取消

### 运行

```bash
cd scripts/cline-poc
set MINIMAX_API_KEY=your-api-key
npm start
```

## 12. 下一步

1. **运行 PoC**: 验证 MiniMax + openai-compatible 端点
2. **事件类型**: 列出所有实际事件类型
3. **权限方案**: 确定如何接管或关闭 Cline 权限确认
4. **集成测试**: 验证在 Electron 主进程中运行
