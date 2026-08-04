// 子代理（Sub-agent）—— 把重任务委托给独立 FC 循环执行，隔离上下文。
//
// 核心思路：
//   主 agent 调 delegate_task 工具 → execute 内部跑一个受限的 runFunctionCallingLoop
//   → 子代理有自己的 conversation（用完即弃）
//   → 执行完只返回结构化摘要给主 agent
//   → 主 agent 的 conversation 只多一条摘要，不被重工具的过程数据污染
//
// 触发条件（调用链深度判断）：
//   单次工具调用能完成 → 不需要子代理
//   需要 ≥2 步工具调用且中间结果不需要用户确认 → 子代理化
//
// 子代理限制：
//   - 工具调用轮次由 runFunctionCallingLoop 统一控制（参见 function-calling.ts MAX_TOOL_ROUNDS）
//   - 超时 60s（主 agent 由 timeout-manager 控制）
//   - 通过 allowedToolIds 白名单屏蔽 delegate_task（防递归）和 ask_user_choice（禁交互）
//   - 不修改全局 toolRegistry 状态，避免并发 Run 互相影响

import { runFunctionCallingLoop } from "./function-calling";
import { toolRegistry } from "./tool-registry";
import { truncateToolResult } from "./context-manager";

const LOG_PREFIX = "[SubAgent]";

/** 子代理限制。比主 agent 更紧——子代理是执行层，不该跑太久。 */
const SUB_AGENT_TIMEOUT_MS = 60_000;

/** 子代理不能调用的工具（防递归 + 防重复权限审批）。 */
const BLOCKED_TOOLS = new Set([
  "delegate_task",     // 防递归
  "ask_user_choice",   // 子代理不该跟用户交互（只有主 agent 能弹卡片）
]);

/** 子代理返回的结构化结果。 */
export interface SubAgentResult {
  status: "success" | "error";
  summary: string;
  artifacts?: string[];
  key_facts?: Record<string, unknown>;
  error_type?: "timeout" | "tool_error" | "parsing_error" | "max_rounds";
  recoverable?: boolean;
}

/** LLM 配置注入器（由 index.ts 启动时调 setDelegateSettings 设置）。 */
let delegateSettingsGetter: (() => { provider: string; baseUrl: string; model: string; apiKey: string; contextWindowTokens: number }) | null = null;

/** index.ts 启动时调用，注入 LLM 配置获取器给子代理。 */
export function setDelegateSettings(getter: () => { provider: string; baseUrl: string; model: string; apiKey: string; contextWindowTokens: number }): void {
  delegateSettingsGetter = getter;
}

/**
 * 启动子代理执行一个子任务。
 * 子代理有自己独立的 conversation，执行完返回结构化摘要。
 */
export async function runSubAgent(task: string): Promise<SubAgentResult> {
  if (!delegateSettingsGetter) {
    return {
      status: "error",
      error_type: "tool_error",
      recoverable: false,
      summary: "子代理未配置 LLM 设置",
    };
  }

  const settings = delegateSettingsGetter();

  // 计算子代理可用工具白名单（全部启用工具减去 BLOCKED_TOOLS）
  // 不修改全局 toolRegistry 状态，避免并发 Run 互相影响
  const allowedToolIds = toolRegistry
    .getEnabledTools()
    .map(t => t.id)
    .filter(id => !BLOCKED_TOOLS.has(id));

  try {
    console.log(LOG_PREFIX, "启动子代理任务:", task.slice(0, 100));

    const subMessages = [
      {
        role: "system" as const,
        content:
          "你是一个子代理，负责执行主代理分配的具体任务。\n" +
          "高效执行，不要列任务清单，不要询问用户。\n" +
          "完成后用一句话总结结果。如果失败，说明原因。",
      },
      { role: "user" as const, content: task },
    ];

    const result = await runFunctionCallingLoop(
      settings,
      subMessages,
      SUB_AGENT_TIMEOUT_MS,
      allowedToolIds,
    );

    const reply = result.reply || "(无回复)";
    const toolCount = result.toolResults.length;

    // 收集产出文件（从工具结果里提取路径）
    const artifacts: string[] = [];
    const keyFacts: Record<string, unknown> = {};
    for (const tr of result.toolResults) {
      // 提取 write_* 工具的输出路径
      const pathMatch = tr.output.match(/已生成[：:]\s*(.+)/);
      if (pathMatch) artifacts.push(pathMatch[1].trim());
      // 提取汇率数据
      const rateMatch = tr.output.match(/(\d+(?:\.\d+)?)\s*(USD|EUR|CNY)\s*=\s*(\d+(?:\.\d+)?)\s*(USD|EUR|CNY)/);
      if (rateMatch) {
        keyFacts[rateMatch[2] + "_to_" + rateMatch[4]] = Number(rateMatch[3]);
      }
    }

    // 判断是否达到最大轮数（可能没完成）
    const hitMaxRounds = toolCount > 0 && reply.length < 50;

    console.log(LOG_PREFIX, "子代理完成:", reply.slice(0, 100), "工具调用:", toolCount);

    return {
      status: hitMaxRounds ? "error" : "success",
      summary: truncateToolResult(reply, 500),
      artifacts: artifacts.length > 0 ? artifacts : undefined,
      key_facts: Object.keys(keyFacts).length > 0 ? keyFacts : undefined,
      error_type: hitMaxRounds ? "max_rounds" : undefined,
      recoverable: hitMaxRounds ? true : undefined,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const isTimeout = errMsg.includes("AbortError") || errMsg.includes("超时");
    console.error(LOG_PREFIX, "子代理失败:", errMsg);

    return {
      status: "error",
      error_type: isTimeout ? "timeout" : "tool_error",
      recoverable: isTimeout,
      summary: "子代理执行失败：" + errMsg.slice(0, 200),
    };
  }
}
