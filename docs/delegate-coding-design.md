# Cyrene -> ClineCore `delegate_coding` 适配层设计 v2

## 0. 修订摘要

v1 -> v2 变更：

1. 生命周期改为 `subscribe -> start`，预生成 sessionId，finally 清理
2. beforeTool fail-closed：hook 异常时拒绝副作用工具
3. 文件工具 workspaceRoot 边界检查（realpath、`..`、junction/symlink）
4. 命令白名单改为 executable + args 结构化匹配，拒绝 shell 元素
5. Ask 流程不假设 beforeTool 内等待，改为 pending_prompts 事件驱动
6. AG-UI 事件改为有状态流处理，只选 agent_event，跨 chunk `<think>` 过滤
7. 降级仅限零副作用阶段，有修改/命令后不降级
8. Finalization Guard 信任边界明确：Cline 修改，run_verification 验证
9. 增加 workspaceRoot 会话锁、maxIterations 计数、partialChanges、Feature Flag、Smoke Test
10. `delegateCoding()` 返回 `CodingAgentResult`，不是 `Promise<string>`

---

## 1. 输入契约

```ts
interface DelegateCodingInput {
  /** 代码任务描述（必须） */
  task: string;
  /** 项目根目录绝对路径（必须，会做 realpath 解析） */
  workspaceRoot: string;
  /** 附加上下文 */
  context?: {
    originalQuery?: string;
    relatedFiles?: string[];
    constraints?: string[];
  };
  /** 预算 */
  budget?: {
    maxIterations?: number;   // 默认 20
    timeoutMs?: number;       // 默认 300_000 (5 分钟)
  };
  /** 验证命令白名单（executable + args 精确匹配） */
  allowedCommands?: CommandAllowList;
}

interface CommandAllowList {
  /** 允许的可执行文件名或绝对路径 */
  executables: Array<{
    name: string;       // 如 "npx" 或 "npm"
    allowedArgs: string[][];  // 如 [["tsc", "--noEmit"], ["tsc", "-p", "tsconfig.json", "--noEmit"]]
  }>;
}

interface CodingAgentResult {
  status: "completed" | "failed" | "cancelled";
  summary: string;
  workspaceRoot: string;
  changedFiles: string[];
  commands: Array<{
    command: string;
    exitCode: number | null;
    stdout?: string;
    stderr?: string;
  }>;
  verification: {
    attempted: boolean;
    passed: boolean;
    details?: string;
  };
  error?: {
    code: string;
    message: string;
  };
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalCost: number;
  };
  /** 部分变更标记：status=failed/cancelled 但已有文件修改时为 true */
  partialChanges: boolean;
}
```

## 2. ClineCore 生命周期与会话管理

### 初始化顺序

```
1. 生成 sessionId = `cline-${randomUUID()}`
2. cline = await ClineCore.create({ clientName: "cyrene", backendMode: "local" })
3. unsubscribe = cline.subscribe(handleEvent)  // 先订阅
4. 启动 timeout 定时器
5. result = await cline.start({ config: { sessionId, ... }, prompt, toolPolicies })
6. 收集结果
```

### finally 清理流程

```ts
async function delegateCoding(input: DelegateCodingInput): Promise<CodingAgentResult> {
  let cline: ClineCore | null = null;
  let unsubscribe: (() => void) | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const sessionId = `cline-${randomUUID()}`;

  try {
    cline = await ClineCore.create({ clientName: "cyrene", backendMode: "local" });
    unsubscribe = cline.subscribe(handleEvent);
    timeoutTimer = setTimeout(
      () => cline?.abort(sessionId, "timeout").catch(() => {}),
      input.budget?.timeoutMs ?? 300_000,
    );

    const result = await cline.start({
      config: { sessionId, ...buildConfig(input), ...buildHooks(input) },
      prompt: input.task,
      toolPolicies: buildToolPolicies(),
    });

    return collectResult(result, sessionId);
  } catch (err) {
    return handleError(err, sessionId);
  } finally {
    // 严格按顺序清理
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (unsubscribe) unsubscribe();
    if (cline) {
      try { await cline.stop(sessionId); } catch { /* 已停止 */ }
      try { await cline.dispose(); } catch { /* 已销毁 */ }
    }
  }
}
```

### 会话超时与取消

- 超时：`setTimeout` 触发 `cline.abort(sessionId, "timeout")`
- 用户取消：Cyrene `AbortSignal` -> `cline.abort(sessionId, "user_cancelled")`
- 进程退出：Electron `before-quit` -> `cline.dispose()`

### workspaceRoot 会话锁

```ts
// 防止同一 workspaceRoot 同时运行两个 Cline 会话
const activeWorkspaces = new Map<string, string>(); // workspaceRoot -> sessionId

function acquireWorkspaceLock(workspaceRoot: string, sessionId: string): void {
  const realRoot = fs.realpathSync(workspaceRoot);
  if (activeWorkspaces.has(realRoot)) {
    throw new Error(`WORKSPACE_LOCKED: ${realRoot} 已有活跃 Cline 会话`);
  }
  activeWorkspaces.set(realRoot, sessionId);
}

function releaseWorkspaceLock(workspaceRoot: string): void {
  const realRoot = fs.realpathSync(workspaceRoot);
  activeWorkspaces.delete(realRoot);
}
```

## 3. 工具权限策略

### 总体策略

- `toolPolicies` 全部设为 `autoApprove: true`
- 审批逻辑完全由 `hooks.beforeTool` 控制
- **fail-closed**：hook 抛异常时，副作用工具（editor/apply_patch/run_commands）拒绝执行

### beforeTool 实现

```ts
function buildHooks(input: DelegateCodingInput) {
  return {
    hooks: {
      beforeTool: (ctx: any): any => {
        const toolName = ctx?.tool?.name || "unknown";
        const toolInput = ctx?.input;

        try {
          return approveTool(toolName, toolInput, input);
        } catch (err) {
          // fail-closed：hook 异常时拒绝副作用工具
          if (isSideEffectTool(toolName)) {
            console.error("[delegate_coding] beforeTool error, fail-closed:", err);
            return { skip: true, reason: "approval error: tool denied (fail-closed)" };
          }
          // 非副作用工具放行
          return undefined;
        }
      },
    },
  };
}

function isSideEffectTool(toolName: string): boolean {
  return toolName === "editor" || toolName === "apply_patch" || toolName === "run_commands";
}
```

### 权限规则

```ts
function approveTool(toolName: string, input: any, codingInput: DelegateCodingInput): any {
  switch (toolName) {
    case "read_files":
    case "search_codebase":
      // 自动允许（workspaceRoot 边界由 Cline 保证）
      return undefined;

    case "editor":
    case "apply_patch":
      // workspaceRoot 边界检查
      const filePath = extractFilePath(input);
      if (!isWithinWorkspace(filePath, codingInput.workspaceRoot)) {
        return { skip: true, reason: `file outside workspaceRoot: ${filePath}` };
      }
      logToolCall("modify", toolName, filePath);
      return undefined;

    case "run_commands":
      return checkCommands(input.commands, codingInput.allowedCommands);

    case "ask_question":
      // 不在 beforeTool 中处理，通过 pending_prompts 事件驱动
      return undefined;

    default:
      return { skip: true, reason: "tool not in allowlist" };
  }
}
```

## 4. workspaceRoot 边界检查

```ts
function isWithinWorkspace(filePath: string, workspaceRoot: string): boolean {
  if (!filePath || !path.isAbsolute(filePath)) return false;

  // realpath 解析（跟随 symlink/junction）
  let resolvedFile: string;
  let resolvedRoot: string;
  try {
    resolvedFile = fs.realpathSync(filePath);
    resolvedRoot = fs.realpathSync(workspaceRoot);
  } catch {
    return false; // 路径不存在或无法解析
  }

  // 规范化比较
  const normalizedRoot = path.normalize(resolvedRoot);
  const normalizedFile = path.normalize(resolvedFile);

  // 必须在 workspaceRoot 内
  if (normalizedFile === normalizedRoot) return false; // 不能是根目录本身
  return normalizedFile.startsWith(normalizedRoot + path.sep);
}
```

### 检查覆盖

- `..` 路径逃逸
- 绝对路径越界
- Windows junction/symlink 越界（通过 `realpathSync`）
- macOS/Linux symlink 越界

## 5. 命令白名单（结构化精确匹配）

```ts
function checkCommands(
  commands: unknown,
  allowList?: CommandAllowList,
): { skip?: boolean; reason?: string } | undefined {
  if (!Array.isArray(commands)) {
    return { skip: true, reason: "invalid commands format" };
  }

  const list = allowList ?? DEFAULT_COMMAND_ALLOW_LIST;

  for (const cmd of commands) {
    const parsed = parseCommand(cmd);
    if (!parsed) {
      return { skip: true, reason: `cannot parse command: ${cmd}` };
    }

    // 拒绝 shell 元素
    if (hasShellMetacharacters(parsed)) {
      return { skip: true, reason: `shell metacharacters not allowed: ${parsed.raw}` };
    }

    // 精确匹配 executable + args
    if (!isCommandAllowed(parsed, list)) {
      return { skip: true, reason: `command not allowed: ${parsed.raw}` };
    }
  }

  return undefined; // 全部通过
}

interface ParsedCommand {
  executable: string;     // 如 "npx"
  args: string[];         // 如 ["tsc", "--noEmit"]
  raw: string;            // 原始字符串
}

function parseCommand(cmd: unknown): ParsedCommand | null {
  if (typeof cmd === "string") {
    const parts = cmd.trim().split(/\s+/);
    if (parts.length === 0) return null;
    return { executable: parts[0], args: parts.slice(1), raw: cmd };
  }
  if (cmd && typeof cmd === "object") {
    const c = cmd as any;
    const exe = String(c.command || "");
    const args = Array.isArray(c.args) ? c.args.map(String) : [];
    return { executable: exe, args, raw: `${exe} ${args.join(" ")}` };
  }
  return null;
}

function hasShellMetacharacters(cmd: ParsedCommand): boolean {
  const SHELL_ELEMENTS = ["&&", "||", ";", "|", ">", "<", "&", "`", "$("];
  const SHELL_WRAPPERS = ["cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "bash", "sh", "zsh", "fish"];

  // 检查可执行文件是否是 shell 包装器
  if (SHELL_WRAPPERS.includes(cmd.executable.toLowerCase())) return true;

  // 检查 args 中是否有 shell 元字符
  const allText = cmd.raw;
  for (const elem of SHELL_ELEMENTS) {
    if (allText.includes(elem)) return true;
  }

  // 检查 cwd 切换
  if (cmd.args.includes("cd") || cmd.args.includes("pushd")) return true;

  return false;
}

function isCommandAllowed(cmd: ParsedCommand, list: CommandAllowList): boolean {
  const entry = list.executables.find(e => e.name === cmd.executable);
  if (!entry) return false;

  // args 精确匹配（完全匹配某个 allowedArgs 数组）
  return entry.allowedArgs.some(allowed => {
    if (allowed.length !== cmd.args.length) return false;
    return allowed.every((arg, i) => arg === cmd.args[i]);
  });
}

const DEFAULT_COMMAND_ALLOW_LIST: CommandAllowList = {
  executables: [
    {
      name: "npx",
      allowedArgs: [
        ["tsc", "--noEmit"],
        ["tsc", "-p", "tsconfig.json", "--noEmit"],
      ],
    },
    {
      name: "npm",
      allowedArgs: [
        ["test"],
        ["run", "test"],
      ],
    },
    {
      name: "npx",
      allowedArgs: [
        ["vitest", "run"],
      ],
    },
    {
      name: "npx",
      allowedArgs: [
        ["eslint", "src", "--max-warnings=0"],
      ],
    },
  ],
};
```

## 6. Ask 用户交互（事件驱动）

### 设计原则

不在 `beforeTool` 中等待用户回答。`ask_question` 工具自动放行，通过 `pending_prompts` 事件驱动 Cyrene AG-UI。

### 流程

```
Cline 调用 ask_question
  -> beforeTool 放行（return undefined）
  -> Cline 内部暂停，等待用户输入
  -> Cline 发出 pending_prompts 事件
  -> Cyrene 适配层收到 pending_prompts
  -> 转发到 AG-UI UserChoice
  -> 用户回答
  -> cline.send(sessionId, { type: "user_message", text: answer })
  -> Cline 恢复执行
```

### 实现

```ts
// 事件处理中
function handleEvent(event: CoreSessionEvent): void {
  if (event.type === "pending_prompts") {
    for (const prompt of event.payload.prompts) {
      handlePendingPrompt(prompt);
    }
  }
}

async function handlePendingPrompt(prompt: SessionPendingPrompt): Promise<void> {
  // 转发到 Cyrene AG-UI
  const answer = await requestUserClarification({
    question: prompt.prompt,
  });

  // 将答案发送回 Cline
  await cline.send(sessionId, {
    type: "user_message",
    text: answer,
    delivery: "steer",
  });
}
```

### 注意

- SDK 0.0.66 的 `pending_prompts` 事件包含 `prompt` 字段
- 使用 `cline.send()` 的 `delivery: "steer"` 注入用户回答
- 如果 SDK 不支持此方式，降级为 `delivery: "queue"`

## 7. AG-UI 事件映射（有状态流处理）

### 设计原则

- 只选 `agent_event` 作为正文来源，忽略 `chunk` 事件（避免重复）
- 连续 `content_start` 不重复创建消息
- `<think>` 使用跨 chunk 状态过滤

### 状态机

```ts
interface StreamState {
  /** 当前消息 ID（用于 AG-UI text_message） */
  currentMessageId: string | null;
  /** 当前 content 类型 */
  currentContentType: "text" | "reasoning" | "tool" | null;
  /** <think> 跨 chunk 过滤状态 */
  thinkFilter: {
    insideThink: boolean;
    buffer: string;
  };
  /** 工具调用记录 */
  toolCalls: Map<string, ToolCallRecord>;
  /** 变更文件 */
  changedFiles: Set<string>;
  /** 命令记录 */
  commands: CommandRecord[];
  /** 迭代计数 */
  iterationCount: number;
  /** 是否已有副作用（用于降级判断） */
  hasSideEffects: boolean;
}

function handleAgentEvent(ae: any, state: StreamState, onEvent: (e: any) => void): void {
  const innerType = ae?.type;
  const ct = ae?.contentType;

  if (innerType === "content_start") {
    if (ct === "text") {
      // 新文本消息开始
      state.currentMessageId = `cline-msg-${Date.now()}`;
      state.currentContentType = "text";
      onEvent({ type: "text_message_start", messageId: state.currentMessageId });
      // 处理初始文本（可能包含 <think>）
      processTextChunk(ae.text || "", state, onEvent);
    } else if (ct === "reasoning") {
      // reasoning 不发送到用户
      state.currentContentType = "reasoning";
    } else if (ct === "tool") {
      // 工具调用开始
      state.currentContentType = "tool";
      const toolCallId = ae.toolCallId || `tool-${Date.now()}`;
      state.toolCalls.set(toolCallId, {
        toolName: ae.toolName,
        toolCallId,
        input: ae.input,
        startedAt: Date.now(),
      });
      onEvent({ type: "tool_call_start", toolCallId, toolCallName: ae.toolName });
    }
  } else if (innerType === "content_end") {
    if (ct === "text" && state.currentMessageId) {
      // 处理剩余 buffer
      flushThinkBuffer(state, onEvent);
      onEvent({ type: "text_message_end", messageId: state.currentMessageId });
      state.currentMessageId = null;
    } else if (ct === "tool") {
      const toolCallId = ae.toolCallId;
      const record = state.toolCalls.get(toolCallId);
      if (record) {
        record.output = ae.output;
        record.error = ae.error;
        record.durationMs = ae.durationMs;
        // 收集副作用
        collectSideEffects(record, state);
      }
      onEvent({ type: "tool_call_end", toolCallId });
    }
  } else if (innerType === "iteration_end") {
    state.iterationCount = ae.iteration;
    // 检查 maxIterations
    if (state.iterationCount >= maxIterations) {
      cline.abort(sessionId, "max_iterations");
    }
  }
}
```

### `<think>` 跨 chunk 过滤

```ts
function processTextChunk(text: string, state: StreamState, onEvent: (e: any) => void): void {
  const tf = state.thinkFilter;
  tf.buffer += text;

  while (tf.buffer.length > 0) {
    if (tf.insideThink) {
      // 在 <think> 块内，寻找 </think>
      const endIdx = tf.buffer.indexOf("</think>");
      if (endIdx === -1) {
        // 还没找到结束标签，保留 buffer
        break;
      }
      // 找到结束标签，跳过 <think>...</think>
      tf.buffer = tf.buffer.slice(endIdx + "</think>".length);
      tf.insideThink = false;
    } else {
      // 在 <think> 块外，寻找 <think>
      const startIdx = tf.buffer.indexOf("<think>");
      if (startIdx === -1) {
        // 没有开始标签，输出全部 buffer
        if (tf.buffer.length > 0) {
          onEvent({ type: "text_message_content", messageId: state.currentMessageId, delta: tf.buffer });
          tf.buffer = "";
        }
        break;
      }
      // 输出 <think> 之前的内容
      if (startIdx > 0) {
        onEvent({ type: "text_message_content", messageId: state.currentMessageId, delta: tf.buffer.slice(0, startIdx) });
      }
      tf.buffer = tf.buffer.slice(startIdx + "<think>".length);
      tf.insideThink = true;
    }
  }
}

function flushThinkBuffer(state: StreamState, onEvent: (e: any) => void): void {
  const tf = state.thinkFilter;
  if (!tf.insideThink && tf.buffer.length > 0) {
    onEvent({ type: "text_message_content", messageId: state.currentMessageId, delta: tf.buffer });
  }
  tf.buffer = "";
  tf.insideThink = false;
}
```

## 8. 降级策略（零副作用限制）

```ts
function delegateCoding(input: DelegateCodingInput): Promise<CodingAgentResult> {
  // ...
  try {
    const result = await runClineSession(input);
    return result;
  } catch (err) {
    // 只有在零副作用阶段才允许降级
    if (!state.hasSideEffects && isClineUnavailable(err)) {
      console.warn("[delegate_coding] Cline 不可用（零副作用阶段），降级到 WorkLoop");
      return runLegacyWorkLoop(input);
    }
    // 有副作用后不降级，返回失败结果
    return handleError(err, sessionId, state);
  }
}
```

### hasSideEffects 判定

```ts
function collectSideEffects(record: ToolCallRecord, state: StreamState): void {
  if (record.toolName === "editor" || record.toolName === "apply_patch") {
    state.hasSideEffects = true;
    const filePath = extractFilePath(record.input);
    if (filePath) state.changedFiles.add(filePath);
  }
  if (record.toolName === "run_commands" && !record.error) {
    state.hasSideEffects = true;
    state.commands.push({
      command: String(record.input?.commands?.[0] || ""),
      exitCode: extractExitCode(record.output),
      stdout: extractStdout(record.output),
      stderr: extractStderr(record.output),
    });
  }
}
```

## 9. Finalization Guard 信任边界

### 职责划分

```
Cline (delegate_coding)
  -> 负责文件修改（editor/apply_patch）
  -> 负责内部验证（run_commands: tsc）
  -> 返回 CodingAgentResult

Cyrene (主 WorkLoop)
  -> 收到 CodingAgentResult
  -> 如果 changedFiles 非空 -> mutationRevision++
  -> 调用 run_verification（现有工具，不修改）
  -> run_verification 通过 -> verifiedRevision = mutationRevision
  -> Finalization Guard 检查 mutationRevision vs verifiedRevision
```

### 信任边界

| 组件 | 信任级别 | 职责 |
|------|---------|------|
| Cline | 受限信任 | 执行修改，返回结果 |
| CodingAgentResult | 不可信 | 仅作为参考，需要 run_verification 确认 |
| run_verification | 完全信任 | 唯一可信验证证据来源 |
| CodeVerificationState | 不变 | mutationRevision/verifiedRevision 语义不变 |
| Finalization Guard | 不变 | 四状态路由语义不变 |

### 状态更新

```ts
// delegate_coding 完成后
if (result.status === "completed" && result.changedFiles.length > 0) {
  // 标记 code mutation
  state.codeVerification.mutationRevision++;
  state.codeVerification.changedFiles.push(...result.changedFiles);
  state.codeVerification.status = "pending";

  // Finalization Guard 会 block，要求 run_verification
  // Action Gate 应选择 run_verification 作为 requiredNextAction
}
```

## 10. 错误分类与降级

### 错误分类

| 错误类型 | errorCode | 处理方式 | 可降级 |
|---------|-----------|---------|--------|
| ClineCore 初始化失败 | `CLINE_INIT_FAILED` | 返回 failed | ✅ 零副作用时 |
| 模型请求超时 | `CLINE_TIMEOUT` | 返回 failed/cancelled | ✅ 零副作用时 |
| 模型 API 错误 | `CLINE_MODEL_ERROR` | 返回 failed | ✅ 零副作用时 |
| AbortError | `CLINE_CANCELLED` | 返回 cancelled | ❌ |
| 工具执行错误 | `CLINE_TOOL_ERROR` | 返回 failed | ❌ |
| workspaceRoot 锁冲突 | `WORKSPACE_LOCKED` | 返回 failed | ✅ |
| maxIterations 超限 | `CLINE_MAX_ITERATIONS` | 返回 failed | ❌ |
| 未知错误 | `CLINE_UNKNOWN` | 返回 failed | ❌ |

### partialChanges 标记

```ts
function handleError(err: Error, sessionId: string, state: StreamState): CodingAgentResult {
  const isAbort = err.name === "AgentRuntimeAbortError" || err.message.includes("abort");
  const status = isAbort ? "cancelled" : "failed";

  return {
    status,
    summary: isAbort ? "任务已取消" : `错误: ${err.message}`,
    workspaceRoot: state.workspaceRoot,
    changedFiles: Array.from(state.changedFiles),
    commands: state.commands,
    verification: { attempted: false, passed: false },
    error: {
      code: classifyError(err),
      message: err.message.slice(0, 200),
    },
    partialChanges: state.hasSideEffects,
  };
}
```

## 11. Feature Flag

```ts
// 在 settings 中增加
interface CyreneSettings {
  // ...
  /** 是否启用 Cline Coding 子代理 */
  enableClineCodingAgent?: boolean;  // 默认 false
}

// 工具注册时检查
function registerDelegateCodingTool(): void {
  const enabled = getSettings().enableClineCodingAgent ?? false;
  toolRegistry.register({
    id: "delegate_coding",
    enabled,
    // ...
  });
}
```

### Feature Flag 控制

- `enableClineCodingAgent = false`（默认）：`delegate_coding` 工具不注册，Action Gate 不可见
- `enableClineCodingAgent = true`：工具注册，Action Gate 可选择
- 运行时切换需要重启会话

## 12. Electron 打包 Smoke Test

### 打包检查项

```ts
// 在 Electron 打包后执行的 smoke test
async function clineSmokeTest(): Promise<void> {
  // 1. 检查 @cline/sdk 是否打包
  const clinePkg = require("@cline/sdk/package.json");
  assert(clinePkg.version === "0.0.66");

  // 2. 检查 ClineCore 是否可导入
  const { ClineCore } = await import("@cline/sdk");
  assert(typeof ClineCore.create === "function");

  // 3. 检查无原生模块
  const nodeModules = path.join(app.getAppPath(), "node_modules", "@cline");
  const nativeFiles = await findFiles(nodeModules, "*.node");
  assert(nativeFiles.length === 0, "发现原生模块: " + nativeFiles.join(", "));

  // 4. 最小会话测试（不需要 API Key）
  const cline = await ClineCore.create({ clientName: "smoke-test", backendMode: "local" });
  assert(typeof cline.subscribe === "function");
  assert(typeof cline.start === "function");
  assert(typeof cline.abort === "function");
  await cline.dispose();
}
```

### electron-builder 配置

```json
{
  "files": [
    "node_modules/@cline/**/*",
    "node_modules/ws/**/*",
    "node_modules/simple-git/**/*",
    "node_modules/zod/**/*"
  ]
}
```

## 13. 工具注册

```ts
toolRegistry.register({
  id: "delegate_coding",
  name: "代码任务",
  description: "将代码任务委托给 Cline Coding Agent 完成...",
  enabled: getSettings().enableClineCodingAgent ?? false,
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
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const input: DelegateCodingInput = {
      task: String(args.task),
      workspaceRoot: String(args.workspaceRoot),
    };
    const result = await delegateCoding(input, ctx);
    return JSON.stringify(result);
  },
});
```

注意：`execute` 返回 `Promise<string>`（JSON 序列化的 CodingAgentResult），`delegateCoding` 内部返回 `CodingAgentResult`。

## 14. 状态机

```
                    ┌─────────────┐
                    │   IDLE      │
                    └──────┬──────┘
                           │ delegateCoding()
                           ▼
                    ┌─────────────┐
                    │  INITIALIZING│
                    │  (create +   │
                    │   subscribe) │
                    └──────┬──────┘
                           │ 成功
                           ▼
                    ┌─────────────┐
                    │   RUNNING    │
     ┌─────────────│ (start +     │─────────────┐
     │             │  events)     │             │
     │             └──────┬──────┘             │
     │                    │                     │
     │     ┌──────────────┼──────────────┐     │
     │     │              │              │     │
     │     ▼              ▼              ▼     │
  ┌──────────┐  ┌───────────┐  ┌───────────┐  │
  │ASK_USER  │  │  TOOL     │  │  ABORT    │  │
  │(pending_ │  │  EXECUTING│  │  REQUESTED│  │
  │ prompts) │  └─────┬─────┘  └─────┬─────┘  │
  └────┬─────┘        │              │        │
       │              │              │        │
       │ user answer  │ tool result  │ abort  │
       │              │              │        │
       └──────────────┴──────────────┘        │
                      │                       │
                      ▼                       ▼
               ┌─────────────┐         ┌───────────┐
               │  COMPLETED  │         │ CANCELLED │
               │  (done)     │         │ (aborted) │
               └──────┬──────┘         └─────┬─────┘
                      │                      │
                      ▼                      ▼
               ┌──────────────────────────────────┐
               │         COLLECTING               │
               │  (result + changedFiles +        │
               │   commands + verification)       │
               └──────────┬───────────────────────┘
                          │
                          ▼
               ┌─────────────────────┐
               │  CLEANUP (finally)  │
               │  (unsubscribe +     │
               │   stop + dispose +  │
               │   unlock)           │
               └──────────┬──────────┘
                          │
                          ▼
               ┌─────────────────────┐
               │  RETURN             │
               │  CodingAgentResult  │
               └─────────────────────┘
```

## 15. 不修改的内容

- Phase 1 Finalization Guard 语义（四状态路由不变）
- CodeVerificationState（mutationRevision/verifiedRevision 不变）
- run_verification 工具（唯一可信验证来源不变）
- 现有 search_code / apply_patch / read_file 工具（保留，不删除）
- Task Router 路由逻辑（Phase 2 再改）
- Soul 回复逻辑

## 16. 渐进迁移

### Phase 1: 并行共存（当前设计）

- `delegate_coding` 注册为新工具，Feature Flag 默认关闭
- 现有 Coding 工具保留
- 降级策略：零副作用时可回退到 WorkLoop

### Phase 2: Cline 优先

- Task Router 判断代码任务时优先选择 `delegate_coding`
- 现有工具仅作为降级

### Phase 3: 清理（可选）

- 删除 `search_code`、`apply_patch` 的自研实现
- 保留 `read_file`、`write_file` 供非代码场景
- `run_verification` 保留
