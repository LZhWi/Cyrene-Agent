/**
 * Cline 适配层 - 工具注册
 *
 * delegate_coding 工具注册到 ToolRegistry。
 * Feature Flag 控制是否启用。
 */

import { toolRegistry } from "../tool-registry";
import { delegateCoding, setClineModelConfigGetter } from "./delegate-coding";
import type { DelegateCodingInput, CodingAgentResult } from "./types";

let registered = false;

/**
 * 注册 delegate_coding 工具。
 * 需要传入模型配置获取器。
 */
export function registerDelegateCodingTool(
  modelConfigGetter: () => { providerId: string; modelId: string; apiKey: string; baseUrl: string } | null,
  enabled: boolean = false,
): void {
  setClineModelConfigGetter(modelConfigGetter);

  if (registered) return;
  registered = true;

  toolRegistry.register({
    id: "delegate_coding",
    name: "代码任务",
    description:
      "将代码任务委托给 Cline Coding Agent 完成。Cline 负责文件搜索、读取、修改和验证。\n\n" +
      "何时用：\n" +
      "- 用户要求修改代码文件\n" +
      "- 需要搜索代码库中的特定内容\n" +
      "- 需要运行类型检查或测试\n\n" +
      "不要用于：\n" +
      "- 非代码文件操作（用 write_file/write_word）\n" +
      "- 简单文件读取（用 read_file）\n\n" +
      "参数：task（代码任务描述），workspaceRoot（项目根目录绝对路径）。\n" +
      "context、budget 和 allowedCommands 只能由系统注入，模型不需要填写。",
    enabled,
    risk: "fs-write",
    effectKind: "mutation",
    verificationPolicy: "code",
    // 不使用 executionKind: "subagent"——那会进入现有 Profile 型子代理 runner。
    // delegate_coding 有独立的 ClineCore 运行时，通过 execute() 直接调用。
    ledgerPolicy: "bypass",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "代码任务描述" },
        workspaceRoot: { type: "string", description: "项目根目录绝对路径" },
        // context/budget/allowedCommands 由可信 ToolContext 注入，不暴露给模型
      },
      required: ["task", "workspaceRoot"],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
      // workspaceRoot 来自 Conversation Workspace Binding（通过 langgraph-agent-loop 注入 args）
      // 不再从环境变量读取——环境变量不能覆盖用户绑定的工作区
      const input: DelegateCodingInput = {
        task: String(args.task || ""),
        workspaceRoot: String(args.workspaceRoot || ""),
      };

      if (!input.task) {
        return buildToolResult({
          status: "failed",
          summary: "task 不能为空",
          workspaceRoot: input.workspaceRoot || "",
          changedFiles: [],
          commands: [],
          verification: { attempted: false, passed: false },
          error: { code: "INVALID_TASK", message: "task 不能为空" },
          partialChanges: false,
        });
      }

      // 无工作区绑定：不能让模型猜目录，也不能默认使用应用源码目录
      if (!input.workspaceRoot) {
        console.log("[delegate_coding] WORKSPACE_NOT_BOUND: no workspace binding for current conversation");
        return buildToolResult({
          status: "failed",
          summary: "当前对话未绑定工作区目录。请先点击输入栏左侧的 📁 按钮选择工作区，然后再执行代码任务。",
          workspaceRoot: "",
          changedFiles: [],
          commands: [],
          verification: { attempted: false, passed: false },
          error: {
            code: "WORKSPACE_NOT_BOUND",
            message: "当前对话未绑定工作区目录。请先选择工作区目录，然后再执行代码任务。",
          },
          partialChanges: false,
        });
      }

      const result = await delegateCoding(input);

      // 诊断日志：内部真实结果
      console.log("[delegate_coding] result",
        "status=" + result.status,
        "errorCode=" + (result.error?.code ?? "none"),
        "changedFiles=" + JSON.stringify(result.changedFiles),
        "partialChanges=" + result.partialChanges,
        "summary=" + (result.summary ?? "").slice(0, 80),
      );

      return buildToolResult(result);
    },
  });

  console.log("[ClineAdapter] delegate_coding 工具已注册, enabled:", enabled);
}

// ── 统一 Tool Result 转换 ─────────────────────────────────

/**
 * 将 CodingAgentResult 转换为统一 Tool Result JSON 字符串。
 *
 * executeToolCall 会解析返回 JSON 的 success 字段：
 * - success === false → Runtime 标记 status: "failed"
 * - success === true 或无 success 字段 → Runtime 标记 status: "succeeded"
 *
 * 规则：
 * - completed → success: true
 * - failed → success: false + errorCode
 * - cancelled → success: false + CLINE_CANCELLED
 */
function buildToolResult(result: CodingAgentResult): string {
  const envelope: Record<string, unknown> = {
    status: result.status,
    summary: result.summary,
    workspaceRoot: result.workspaceRoot,
    changedFiles: result.changedFiles,
    commands: result.commands,
    verification: result.verification,
    partialChanges: result.partialChanges,
    ...(result.usage ? { usage: result.usage } : {}),
  };

  if (result.status === "completed") {
    return JSON.stringify({ success: true, ...envelope });
  }

  if (result.status === "cancelled") {
    return JSON.stringify({
      success: false,
      errorCode: "CLINE_CANCELLED",
      error: "任务已取消",
      ...envelope,
    });
  }

  // status === "failed"
  return JSON.stringify({
    success: false,
    errorCode: result.error?.code || "CLINE_UNKNOWN",
    error: result.error?.message || "Cline 任务失败",
    ...envelope,
  });
}

/**
 * 重置注册状态（测试用）。
 */
export function _resetDelegateCodingRegistration(): void {
  registered = false;
}
