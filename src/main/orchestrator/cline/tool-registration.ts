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
    executionKind: "subagent",
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
      const input: DelegateCodingInput = {
        task: String(args.task || ""),
        workspaceRoot: String(args.workspaceRoot || ""),
      };

      if (!input.task) {
        return JSON.stringify({
          status: "failed" as const,
          summary: "task 不能为空",
          workspaceRoot: input.workspaceRoot || "",
          changedFiles: [],
          commands: [],
          verification: { attempted: false, passed: false },
          error: { code: "INVALID_TASK", message: "task 不能为空" },
          partialChanges: false,
        });
      }

      if (!input.workspaceRoot) {
        return JSON.stringify({
          status: "failed" as const,
          summary: "workspaceRoot 不能为空",
          workspaceRoot: "",
          changedFiles: [],
          commands: [],
          verification: { attempted: false, passed: false },
          error: { code: "INVALID_WORKSPACE", message: "workspaceRoot 不能为空" },
          partialChanges: false,
        });
      }

      const result = await delegateCoding(input);
      return JSON.stringify(result);
    },
  });

  console.log("[ClineAdapter] delegate_coding 工具已注册, enabled:", enabled);
}

/**
 * 重置注册状态（测试用）。
 */
export function _resetDelegateCodingRegistration(): void {
  registered = false;
}
