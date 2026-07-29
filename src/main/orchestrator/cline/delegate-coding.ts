/**
 * Cline 适配层 - 主函数
 *
 * delegateCoding() 返回 CodingAgentResult。
 * 生命周期：subscribe -> start，预生成 sessionId，finally 清理。
 *
 * 注意：@cline/sdk 是 ESM-only 包，Electron 主进程使用 CommonJS，
 * 必须用动态 import() 加载，不能用静态 import。
 */

import type { CoreSessionEvent } from "@cline/core";
import { randomUUID } from "crypto";
import type {
  DelegateCodingInput,
  CodingAgentResult,
  StreamState,
  ClineErrorCode,
} from "./types";
import { createStreamState, handleClineEvent, buildVerification, type StreamEventEmitter } from "./event-handler";
import { ThinkFilter } from "./think-filter";
import { acquireWorkspaceLock, releaseWorkspaceLock } from "./workspace-lock";
import { isWithinWorkspace } from "./workspace-guard";
import { checkCommands, DEFAULT_COMMAND_ALLOW_LIST } from "./command-guard";
import { resolveModelRequestTimeoutMs } from "../config/model-timeout";
import * as path from "path";
import { pathToFileURL } from "url";

// ── Think 块过滤（用于最终 summary） ─────────────────────

function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

// ── 配置 ──────────────────────────────────────────────────

interface ClineModelConfig {
  providerId: string;
  modelId: string;
  apiKey: string;
  baseUrl: string;
}

let modelConfigGetter: (() => ClineModelConfig | null) | null = null;

/**
 * 设置模型配置获取器（由 cyrene-agent.ts 在启动时注入）。
 */
export function setClineModelConfigGetter(getter: () => ClineModelConfig | null): void {
  modelConfigGetter = getter;
}

// ── 副作用工具判定 ────────────────────────────────────────

function isSideEffectTool(toolName: string): boolean {
  return toolName === "editor" || toolName === "apply_patch" || toolName === "run_commands";
}

// ── beforeTool 审批 ──────────────────────────────────────

function buildBeforeToolHook(
  workspaceRoot: string,
  allowedCommands: import("./types").CommandAllowList | undefined,
  state: StreamState,
) {
  return (ctx: any): any => {
    const toolName = ctx?.tool?.name || "unknown";
    const input = ctx?.input;

    try {
      // read_files / search_codebase: 自动允许，但仍做 workspaceRoot 检查
      if (toolName === "read_files" || toolName === "search_codebase") {
        return undefined;
      }

      // editor / apply_patch: workspaceRoot 边界检查
      if (toolName === "editor" || toolName === "apply_patch") {
        const filePath = extractFilePath(input);
        if (filePath && !isWithinWorkspace(filePath, workspaceRoot)) {
          return { skip: true, reason: `file outside workspaceRoot: ${filePath}` };
        }
        // 保守标记 hasPotentialSideEffects
        state.hasPotentialSideEffects = true;
        return undefined;
      }

      // run_commands: 逐条检查命令白名单
      if (toolName === "run_commands") {
        const commands = Array.isArray(input?.commands) ? input.commands : [];
        const result = checkCommands(input?.commands, allowedCommands);
        // 诊断日志：逐条记录命令审批
        console.log("[delegate_coding] beforeTool run_commands",
          "count=" + commands.length,
          "approved=" + !result?.skip,
          "commands=" + JSON.stringify(commands.map((c: any) => typeof c === "string" ? c : c?.command || String(c))),
        );
        if (result?.skip) return result;
        // 保守标记 hasPotentialSideEffects
        state.hasPotentialSideEffects = true;
        return undefined;
      }

      // ask_question: 放行（通过 pending_prompts 事件驱动）
      if (toolName === "ask_question") {
        return undefined;
      }

      // 其他工具：拒绝
      return { skip: true, reason: "tool not in allowlist" };
    } catch (err) {
      // fail-closed：hook 异常时拒绝副作用工具
      if (isSideEffectTool(toolName)) {
        console.error("[delegate_coding] beforeTool error, fail-closed:", err);
        return { skip: true, reason: "approval error: tool denied (fail-closed)" };
      }
      return undefined;
    }
  };
}

function extractFilePath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  return String(obj.path || obj.filePath || obj.file_path || "") || null;
}

// ── 错误分类 ──────────────────────────────────────────────

function classifyError(err: Error): ClineErrorCode {
  const msg = err.message || "";
  const name = err.name || "";

  if (name === "AgentRuntimeAbortError" || msg.includes("abort")) {
    return "CLINE_CANCELLED";
  }
  if (msg.includes("CLINE_MODULE_LOAD_FAILED") || msg.includes("ERR_PACKAGE_PATH_NOT_EXPORTED")) {
    return "CLINE_MODULE_LOAD_FAILED";
  }
  if (msg.includes("WORKSPACE_LOCKED")) {
    return "WORKSPACE_LOCKED";
  }
  if (msg.includes("timeout") || msg.includes("TIMEOUT")) {
    return "CLINE_TIMEOUT";
  }
  if (msg.includes("init") || msg.includes("create")) {
    return "CLINE_INIT_FAILED";
  }
  if (msg.includes("HTTP") || msg.includes("status")) {
    return "CLINE_MODEL_ERROR";
  }
  if (msg.includes("max_iterations") || msg.includes("iteration")) {
    return "CLINE_MAX_ITERATIONS";
  }
  if (msg.includes("tool")) {
    return "CLINE_TOOL_ERROR";
  }
  return "CLINE_UNKNOWN";
}

// ── 主函数 ──────────────────────────────────────────────

export interface DelegateCodingOptions {
  /** AG-UI 事件回调 */
  onEvent?: StreamEventEmitter;
  /** 用户取消信号 */
  signal?: AbortSignal;
  /** Ask 用户回调（pending_prompts 事件驱动） */
  onAskUser?: (prompt: { id: string; prompt: string }) => Promise<string>;
}

/**
 * 执行 Cline Coding Agent 会话。
 * 返回 CodingAgentResult。
 */
export async function delegateCoding(
  input: DelegateCodingInput,
  options?: DelegateCodingOptions,
): Promise<CodingAgentResult> {
  const modelConfig = modelConfigGetter?.();
  if (!modelConfig) {
    return {
      status: "failed",
      summary: "Cline 模型配置未设置",
      workspaceRoot: input.workspaceRoot,
      changedFiles: [],
      commands: [],
      verification: { attempted: false, passed: false },
      error: { code: "CLINE_INIT_FAILED", message: "model config not set" },
      partialChanges: false,
    };
  }

  const sessionId = `cline-${randomUUID()}`;
  const maxIterations = input.budget?.maxIterations ?? 20;
  const timeoutMs = input.budget?.timeoutMs ?? 300_000;
  const allowedCommands = input.allowedCommands ?? DEFAULT_COMMAND_ALLOW_LIST;

  let cline: any = null;
  let unsubscribe: (() => void) | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let lockKey: string | null = null;

  const state = createStreamState(input.workspaceRoot);
  const thinkFilter = new ThinkFilter();

  // pending prompts 处理
  const pendingPromptHandlers = new Map<string, (answer: string) => void>();

  try {
    // 1. 获取 workspace 锁
    lockKey = acquireWorkspaceLock(input.workspaceRoot, sessionId);

    // 2. 通过 ESM Bridge 加载 ClineCore（绕过 TypeScript 的 import→require 转换）
    const bridgePath = path.join(__dirname, "cline-esm-bridge.mjs");
    const bridgeUrl = pathToFileURL(bridgePath).href;
    const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
    let bridge: any;
    try {
      bridge = await nativeImport(bridgeUrl);
      console.log("[delegate_coding] Cline ESM bridge loaded");
    } catch (bridgeErr) {
      const msg = bridgeErr instanceof Error ? bridgeErr.message : String(bridgeErr);
      console.error("[delegate_coding] ESM bridge load failed:", msg);
      throw new Error(`CLINE_MODULE_LOAD_FAILED: ${msg}`);
    }
    cline = await bridge.createClineCore({
      clientName: "cyrene",
      backendMode: "local",
    });
    console.log("[delegate_coding] ClineCore created");

    // 3. 先订阅事件
    unsubscribe = cline.subscribe((event: CoreSessionEvent) => {
      handleClineEvent(event, state, thinkFilter, options?.onEvent ?? (() => {}), input.workspaceRoot, allowedCommands);

      // 处理 pending_prompts（Ask 用户交互）
      if (event.type === "pending_prompts") {
        for (const prompt of event.payload.prompts) {
          handlePendingPrompt(cline!, sessionId, prompt, options?.onAskUser, pendingPromptHandlers);
        }
      }

      // 检查 maxIterations
      if (event.type === "agent_event") {
        const ae = event.payload.event as any;
        if (ae?.type === "iteration_end" && ae.iteration >= maxIterations) {
          cline!.abort(sessionId, "max_iterations").catch(() => {});
        }
      }
    });

    // 4. 启动 timeout 定时器
    timeoutTimer = setTimeout(() => {
      cline?.abort(sessionId, "timeout").catch(() => {});
    }, timeoutMs);

    // 5. 用户取消信号
    if (options?.signal) {
      options.signal.addEventListener("abort", () => {
        cline?.abort(sessionId, "user_cancelled").catch(() => {});
      }, { once: true });
    }

    // 6. 启动会话
    const result = await cline.start({
      config: {
        sessionId,
        providerId: "openai-compatible",
        modelId: modelConfig.modelId,
        apiKey: modelConfig.apiKey,
        baseUrl: modelConfig.baseUrl,
        cwd: input.workspaceRoot,
        workspaceRoot: input.workspaceRoot,
        systemPrompt: [
          "你是一个代码助手。请帮助用户完成代码任务。",
          "",
          "重要约束：",
          "- 当前 cwd 已经是目标工作区，不要执行 pwd/cd/dir/ls/Get-ChildItem/Test-Path",
          "- 文件查看使用 read_files 和 search_codebase 工具",
          "- 验证命令只允许 npx tsc --noEmit（或指定 -p 参数）",
          "- 不要尝试安装依赖或运行任意命令",
        ].join("\n"),
        enableTools: true,
        enableSpawnAgent: false,
        enableAgentTeams: false,
        hooks: {
          beforeTool: buildBeforeToolHook(input.workspaceRoot, allowedCommands, state),
        },
      },
      toolPolicies: {
        read_files: { enabled: true, autoApprove: true },
        search_codebase: { enabled: true, autoApprove: true },
        run_commands: { enabled: true, autoApprove: true },
        apply_patch: { enabled: true, autoApprove: true },
        editor: { enabled: true, autoApprove: true },
      },
      prompt: input.task,
    });

    // 7. 收集结果
    return collectResult(state, input.workspaceRoot, result.result as any);

  } catch (err) {
    return handleError(err, state, input.workspaceRoot, sessionId);
  } finally {
    // 严格按顺序清理
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (unsubscribe) unsubscribe();
    if (cline) {
      try { await cline.stop(sessionId); } catch { /* 已停止 */ }
      try { await cline.dispose(); } catch { /* 已销毁 */ }
    }
    if (lockKey) releaseWorkspaceLock(lockKey);
  }
}

// ── pending_prompts 处理 ─────────────────────────────────

async function handlePendingPrompt(
  cline: any,
  sessionId: string,
  prompt: { id: string; prompt: string },
  onAskUser: DelegateCodingOptions["onAskUser"],
  handlers: Map<string, (answer: string) => void>,
): Promise<void> {
  if (!onAskUser) {
    // 没有 Ask 回调，跳过
    return;
  }

  try {
    const answer = await onAskUser({ id: prompt.id, prompt: prompt.prompt });
    // 将答案发送回 Cline
    await cline.send({
      sessionId,
      prompt: answer,
      delivery: "steer",
    } as any);
  } catch (err) {
    console.error("[delegate_coding] Ask user failed:", err);
  }
}

// ── 结果收集 ──────────────────────────────────────────────

function collectResult(state: StreamState, workspaceRoot: string, agentResult: any): CodingAgentResult {
  const verification = buildVerification(state);
  const changedFiles = Array.from(state.changedFiles);

  // 从 agentResult 提取摘要
  if (agentResult?.text) state.summary = agentResult.text;
  if (agentResult?.usage) {
    state.usage.inputTokens = agentResult.usage.inputTokens || state.usage.inputTokens;
    state.usage.outputTokens = agentResult.usage.outputTokens || state.usage.outputTokens;
    state.usage.totalCost = agentResult.usage.totalCost || state.usage.totalCost;
  }

  // 过滤 <think> 块，生成确定性摘要
  let summary = stripThinkBlocks(state.summary);
  if (!summary) {
    if (changedFiles.length > 0) {
      summary = `已修改 ${changedFiles.length} 个文件：${changedFiles.join(", ")}`;
    } else {
      summary = "任务完成";
    }
  }

  // 归一化业务完成状态：
  // Cline 会话自然结束 ≠ 业务任务完成。
  // 有文件修改但未运行验证 → 业务 status=failed，但 envelope success=true（工具正常返回）。
  // routeAfterTool 从 output JSON 提取 changedFiles，不依赖 result.status。
  const hasChanges = changedFiles.length > 0 || state.hasPotentialSideEffects;
  const verificationNotRun = !verification.attempted && hasChanges;

  if (verificationNotRun) {
    console.log("[delegate_coding] 验证未运行，业务 status=failed",
      "changedFiles=" + JSON.stringify(changedFiles),
    );
    return {
      status: "failed",
      summary: summary + "（验证未运行，需要 run_verification）",
      workspaceRoot,
      changedFiles,
      commands: state.commands,
      verification: { attempted: false, passed: false },
      error: { code: "CLINE_VERIFICATION_NOT_RUN", message: "代码修改已完成但验证未运行" },
      usage: state.usage,
      partialChanges: true,
    };
  }

  return {
    status: "completed",
    summary,
    workspaceRoot,
    changedFiles,
    commands: state.commands,
    verification,
    usage: state.usage,
    partialChanges: false,
  };
}

function handleError(err: unknown, state: StreamState, workspaceRoot: string, sessionId: string): CodingAgentResult {
  const error = err instanceof Error ? err : new Error(String(err));
  const errorCode = classifyError(error);
  const isAbort = errorCode === "CLINE_CANCELLED";
  const status = isAbort ? "cancelled" : "failed";
  const changedFiles = Array.from(state.changedFiles);

  // 过滤 think 块
  const rawSummary = isAbort ? "任务已取消" : `错误: ${error.message}`;
  let summary = stripThinkBlocks(rawSummary);
  if (!summary) summary = rawSummary;

  // 有文件修改但会话失败 → partialChanges + 需要验证
  if (changedFiles.length > 0 && !isAbort) {
    summary += `（已修改 ${changedFiles.length} 个文件，但任务未完成）`;
  }

  return {
    status,
    summary,
    workspaceRoot,
    changedFiles,
    commands: state.commands,
    verification: { attempted: false, passed: false },
    error: {
      code: errorCode,
      message: error.message.slice(0, 200),
    },
    partialChanges: state.hasPotentialSideEffects || changedFiles.length > 0,
  };
}
