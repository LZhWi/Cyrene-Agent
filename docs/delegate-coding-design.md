# Cyrene -> ClineCore 最小 `delegate_coding` 适配层设计

## 1. 输入契约

```ts
interface DelegateCodingInput {
  /** 代码任务描述（必须） */
  task: string;
  /** 项目根目录绝对路径（必须） */
  workspaceRoot: string;
  /** 附加上下文：用户意图、相关文件、约束等 */
  context?: {
    originalQuery?: string;
    relatedFiles?: string[];
    constraints?: string[];
  };
  /** 预算：最大迭代次数和超时 */
  budget?: {
    maxIterations?: number;   // 默认 20
    timeoutMs?: number;       // 默认 300_000 (5 分钟)
  };
  /** 验证命令白名单（默认仅 tsc） */
  allowedCommands?: string[];
}
```

## 2. ClineCore 生命周期与会话管理

```
Cyrene executeTool(delegate_coding)
  -> 创建 ClineCore 实例（单例或按需）
  -> cline.start({ config, prompt, toolPolicies })
  -> cline.subscribe(handleEvent)
  -> 等待会话完成 / 超时 / 用户取消
  -> cline.stop(sessionId)
  -> cline.dispose() 或保留实例供复用
  -> 返回 CodingAgentResult
```

### 实例管理策略

- **Phase 1（最小接入）**: 每次调用创建新实例，完成后 dispose
- **Phase 2（优化）**: 单例 ClineCore，多会话复用，按 sessionId 管理

### 会话超时

```ts
const timeoutMs = input.budget?.timeoutMs ?? 300_000;
const timer = setTimeout(() => cline.abort(sessionId, "timeout"), timeoutMs);
```

## 3. 工具权限策略

### 策略来源

完全由 `hooks.beforeTool` 控制，`toolPolicies` 全部设为 `autoApprove: true`。

### 权限规则

```ts
function beforeTool(ctx): BeforeToolResult | undefined {
  const { toolName, input } = ctx;

  switch (toolName) {
    case "read_files":
    case "search_codebase":
      // 自动允许（workspaceRoot 内由 Cline 保证）
      return undefined;

    case "editor":
    case "apply_patch":
      // 记录后允许
      logToolCall("modify", toolName, input);
      return undefined;

    case "run_commands":
      // 逐条检查命令白名单
      return checkCommands(input.commands, allowedCommands);

    case "ask_question":
      // 转发到 Cyrene AG-UI
      return handleAskUser(input);

    default:
      return { skip: true, reason: "tool not in allowlist" };
  }
}
```

### 命令白名单

```ts
const DEFAULT_ALLOWED_COMMANDS = [
  "npx tsc --noEmit",
  "npx tsc -p tsconfig.json --noEmit",
  "npm test",
  "npx vitest run",
  "npx eslint",
];
```

用户可通过 `DelegateCodingInput.allowedCommands` 覆盖。

## 4. 事件到 Cyrene/AG-UI 的映射

### 事件映射表

| Cline 事件 | Cyrene AG-UI 事件 | 说明 |
|-----------|------------------|------|
| `agent_event` `content_start` `contentType=text` | `text_message_start` + `text_message_content` | 正文文本（过滤 `<think>`） |
| `agent_event` `content_start` `contentType=reasoning` | 不发送到用户 | 思考内容仅记录日志 |
| `agent_event` `content_start` `contentType=tool` | `tool_call_start` | 工具调用开始 |
| `agent_event` `content_end` `contentType=tool` | `tool_call_end` | 工具调用结束 |
| `agent_event` `iteration_end` | `step_progress` | 迭代进度 |
| `agent_event` `done` | 不单独发送 | 等待会话结束 |
| `chunk` `stream=stdout` | 不发送到用户 | 命令输出仅记录 |
| `chunk` `stream=stderr` | 不发送到用户 | 命令错误仅记录 |
| `status` `running` | 内部记录 | 用于 abort 时机判断 |
| `status` `completed` | 不单独发送 | 等待 ended |
| `ended` | 内部完成处理 | 触发结果收集 |
| `pending_prompts` | 转发到 AG-UI | Ask 用户交互 |

### reasoning 与 `<think>` 过滤

```ts
function handleTextEvent(text: string): string {
  // MiniMax 通过 contentType=reasoning 和 text 中 <think> 双路输出思考内容
  // 1. reasoning 事件：不发送到用户
  // 2. text 事件：执行 stripThinkBlocks 过滤 <think>...</think>
  return stripThinkBlocks(text);
}
```

## 5. Ask 用户交互

### Cline `ask_question` 工具

当 Cline 调用 `ask_question` 工具时：

```ts
case "ask_question":
  // 通过 hooks.beforeTool 拦截
  const question = input.question;
  const options = input.options;

  // 转发到 Cyrene 的 requestUserClarification
  const answer = await cyreneAskUser({
    question,
    options,
  });

  // 将答案注入 Cline 会话
  await cline.send(sessionId, {
    type: "user_message",
    text: answer,
  });

  // 跳过工具执行（答案已通过 send 注入）
  return { skip: true, reason: "answered via Cyrene AG-UI" };
```

### 映射规则

| Cline ask_question | Cyrene UserChoice |
|--------------------|--------------------|
| `question` | `clarification.question` |
| `options` | `clarification.options` |
| 用户回答 | `cline.send(sessionId, answer)` |

## 6. Abort/取消

### 取消来源

1. **用户取消**: Cyrene 收到用户取消信号 -> `cline.abort(sessionId, "user_cancelled")`
2. **超时取消**: 定时器触发 -> `cline.abort(sessionId, "timeout")`
3. **系统取消**: Cyrene 进程退出 -> `cline.dispose()`

### 取消处理

```ts
// AgentRuntimeAbortError 在已确认 cancelled/aborted 时按正常取消处理
function handleError(err: Error): CodingAgentResult {
  if (err.name === "AgentRuntimeAbortError" || err.message.includes("abort")) {
    return { status: "cancelled", summary: "任务已取消", ... };
  }
  return { status: "failed", error: { code: "CLINE_ERROR", message: err.message }, ... };
}
```

## 7. 最终结构化结果

```ts
interface CodingAgentResult {
  status: "completed" | "failed" | "cancelled";

  /** 任务摘要（来自 Cline 最终回复） */
  summary: string;

  /** 工作区根目录 */
  workspaceRoot: string;

  /** 变更文件列表（从工具事件中收集） */
  changedFiles: string[];

  /** 命令执行记录 */
  commands: Array<{
    command: string;
    exitCode: number | null;
    stdout?: string;
    stderr?: string;
  }>;

  /** 验证结果 */
  verification: {
    attempted: boolean;
    passed: boolean;
    details?: string;
  };

  /** 错误信息（status=failed 时） */
  error?: {
    code: string;
    message: string;
  };

  /** Token 用量 */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalCost: number;
  };
}
```

### 结果收集

```ts
// 从事件流中收集
const changedFiles = new Set<string>();
const commands: CommandRecord[] = [];
let verification = { attempted: false, passed: false };

// content_end (tool) 事件中提取
if (toolName === "editor" || toolName === "apply_patch") {
  changedFiles.add(filePath);
}
if (toolName === "run_commands") {
  commands.push({ command, exitCode, stdout, stderr });
  if (command.includes("tsc")) {
    verification.attempted = true;
    verification.passed = exitCode === 0;
  }
}

// 最终回复从 done 事件或 session result 中提取
```

## 8. 错误分类与降级

### 错误分类

| 错误类型 | errorCode | 处理方式 |
|---------|-----------|---------|
| ClineCore 初始化失败 | `CLINE_INIT_FAILED` | 返回 failed，Cyrene Soul 回复错误 |
| 模型请求超时 | `CLINE_TIMEOUT` | 返回 failed，建议重试 |
| 模型 API 错误 | `CLINE_MODEL_ERROR` | 返回 failed，包含 HTTP status |
| AbortError | `CLINE_CANCELLED` | 返回 cancelled，正常取消 |
| 工具执行错误 | `CLINE_TOOL_ERROR` | 返回 failed，包含工具名和错误 |
| 未知错误 | `CLINE_UNKNOWN` | 返回 failed，记录原始错误 |

### 降级策略

```ts
// 如果 Cline 不可用，降级到现有 WorkLoop
async function delegateCoding(input: DelegateCodingInput): Promise<string> {
  try {
    return await runClineSession(input);
  } catch (err) {
    if (isClineUnavailable(err)) {
      console.warn("[delegate_coding] Cline 不可用，降级到 WorkLoop");
      return await runLegacyWorkLoop(input);
    }
    throw err;
  }
}
```

## 9. Electron 主进程集成边界

### 运行位置

ClineCore 在 **Electron 主进程** 中运行（不在 renderer 中）。

### 打包注意

- `@cline/sdk` 及其依赖需要在 `electron-builder` 的 `files` 配置中包含
- 无原生模块（已验证无 `.node` 文件）
- 需要确保 `simple-git` 等依赖在打包后可用

### IPC 边界

```
Renderer (AG-UI)
  <-> IPC <-> Main Process
                -> ClineCore (local backend)
                -> 文件系统
                -> 命令执行
```

### 配置传递

```ts
// 从 Cyrene 用户设置中提取模型配置
const clineConfig = {
  providerId: "openai-compatible",
  modelId: settings.model,
  apiKey: settings.apiKey,
  baseUrl: settings.baseUrl,
  cwd: input.workspaceRoot,
  workspaceRoot: input.workspaceRoot,
};
```

## 10. 渐进迁移与回滚方案

### Phase 1: 并行共存（当前）

```
Cyrene Action Gate
  -> delegate_coding (新工具，调用 Cline)
  -> apply_patch / read_file / search_code (现有工具，保留)
```

- `delegate_coding` 作为新工具注册
- 现有 Coding 工具保留，不删除
- Action Gate 可以选择 `delegate_coding` 或现有工具
- 如果 Cline 不可用，降级到现有工具

### Phase 2: Cline 优先

```
Cyrene Action Gate
  -> 代码任务 -> delegate_coding (Cline)
  -> 非代码任务 -> 现有工具
```

- Task Router 判断代码任务时优先选择 `delegate_coding`
- 现有工具仅作为降级

### Phase 3: 清理（可选）

- 删除 `search_code`、`apply_patch` 的自研实现
- 保留 `read_file`、`write_file` 供非代码场景使用
- `run_verification` 保留（Cline 验证结果需要 Cyrene 确认）

### 回滚方案

- `delegate_coding` 工具设置 `enabled: false` 即可完全回滚
- 现有 WorkLoop 不受影响
- 不修改 Finalization Guard 或 CodeVerificationState 语义

## 11. 工具注册

```ts
toolRegistry.register({
  id: "delegate_coding",
  name: "代码任务",
  description: "将代码任务委托给 Cline Coding Agent 完成...",
  enabled: true,
  risk: "fs-write",
  effectKind: "mutation",
  verificationPolicy: "code",
  executionKind: "subagent",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "代码任务描述" },
      workspaceRoot: { type: "string", description: "项目根目录绝对路径" },
    },
    required: ["task", "workspaceRoot"],
  },
  execute: async (args, ctx) => {
    return runClineSession(args, ctx);
  },
});
```

## 12. 不修改的内容

- Phase 1 Finalization Guard 语义
- CodeVerificationState
- run_verification 工具
- 现有 search_code / apply_patch / read_file 工具
- Task Router 路由逻辑（Phase 2 再改）
- Soul 回复逻辑
