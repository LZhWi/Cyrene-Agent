/**
 * Harness 内置工具：update_todo / ask_user（v3 §8 / §9）
 *
 * 这两个工具不进 toolRegistry，由 Harness Loop 内部 dispatch。
 * 它们能直接访问 AgentState 和事件发送器。
 */

import type { ToolCall } from "../vendors/types";
import type { ToolSpec } from "../vendors/types";
import type {
  AgentState,
  HarnessEvent,
  TodoItem,
  TodoStatus,
  ToolObservation,
} from "./types";
import { parseToolCallArgs } from "./types";
import { isAbortError } from "../../abort-utils";
import { authorizeUncertainEffectRepeat } from "./uncertain-effect-guard";

// ── update_todo ──────────────────────────────────────────

export const UPDATE_TODO_TOOL_ID = "update_todo";

export const updateTodoToolSpec: ToolSpec = {
  name: UPDATE_TODO_TOOL_ID,
  description:
    "更新可变工作笔记（Todo）。传入完整的新 TodoItem 数组（整表替换）。\n" +
    "何时使用：预计任务需要至少 2 个 execution step（执行步骤）或 tool round（工具推进轮次）时，优先建立并持续更新清单；不按 LLM 调用次数计算。\n" +
    "不要用于简单问答、纯闲聊或单次工具即可完成的任务。Todo 是可随事实和改变方向而重写的工作笔记，不是后续行动的强约束，也不是外部操作已经成功的证明。\n" +
    "规则：\n" +
    "- id 必须唯一\n" +
    "- 同一时刻最多一个 in_progress\n" +
    "- 状态转移：pending → in_progress → completed/cancelled\n" +
    "- 不要把已 completed/cancelled 的任务改回 pending\n" +
    "Runtime 会校验并修正违规，修正后的实际列表会回告给你。",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "完整的新待办列表（替换旧列表）",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "唯一标识" },
            content: { type: "string", description: "任务描述" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "cancelled"],
              description: "任务状态",
            },
            activeForm: { type: "string", description: "正在进行时的现在时描述（可选）" },
          },
          required: ["id", "content", "status"],
        },
      },
    },
    required: ["todos"],
  },
};

// ── Todo Invariants（v3 §8.9 / §8.10）────────────────────

const VALID_TRANSITIONS: Record<TodoStatus, TodoStatus[]> = {
  pending: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

interface TodoValidationResult {
  items: TodoItem[];
  corrections: string[];
}

function validateAndCorrectTodos(
  newItems: TodoItem[],
  oldItems: TodoItem[],
): TodoValidationResult {
  const corrections: string[] = [];
  const result: TodoItem[] = [];
  const seenIds = new Set<string>();

  // 找出旧的状态映射
  const oldStatusMap = new Map<string, TodoStatus>();
  for (const item of oldItems) {
    oldStatusMap.set(item.id, item.status);
  }

  // 最多一个 in_progress
  let inProgressCount = 0;
  let firstInProgress = true;

  for (const item of newItems) {
    // id 唯一性
    if (seenIds.has(item.id)) {
      corrections.push(`ID "${item.id}" 重复，跳过后续重复项`);
      continue;
    }
    seenIds.add(item.id);

    // 状态合法性
    const validStatuses: TodoStatus[] = ["pending", "in_progress", "completed", "cancelled"];
    if (!validStatuses.includes(item.status)) {
      corrections.push(`ID "${item.id}" 状态 "${item.status}" 无效，降级为 pending`);
      result.push({ ...item, status: "pending" });
      continue;
    }

    // 状态转移合法性
    const oldStatus = oldStatusMap.get(item.id);
    if (oldStatus && oldStatus !== item.status) {
      const allowed = VALID_TRANSITIONS[oldStatus];
      if (!allowed.includes(item.status)) {
        corrections.push(
          `ID "${item.id}" 非法状态转移 ${oldStatus} → ${item.status}，保持原状态 ${oldStatus}`,
        );
        result.push({ ...item, status: oldStatus });
        continue;
      }
    }

    // 最多一个 in_progress
    if (item.status === "in_progress") {
      inProgressCount++;
      if (inProgressCount > 1) {
        corrections.push(
          `ID "${item.id}" 被降级为 pending（已有 in_progress 任务，最多一个）`,
        );
        result.push({ ...item, status: "pending" });
        firstInProgress = false;
        continue;
      }
    }

    result.push(item);
  }

  return { items: result, corrections };
}

/**
 * 执行 update_todo（v3 §8.3）。
 * 返回 ToolObservation，包含修正后的实际列表 + 修正说明。
 */
export async function executeUpdateTodo(
  call: ToolCall,
  state: AgentState,
  onEvent?: (event: HarnessEvent) => void,
): Promise<ToolObservation> {
  const args = parseToolCallArgs(call);
  const rawTodos = (args.todos as unknown) ?? [];

  if (!Array.isArray(rawTodos)) {
    return {
      outcome: "failure",
      category: "invalid_arguments",
      tool: UPDATE_TODO_TOOL_ID,
      message: "todos 参数必须是数组",
    };
  }

  const typedTodos: TodoItem[] = rawTodos.map((t: unknown) => {
    const item = t as Record<string, unknown>;
    return {
      id: String(item.id ?? ""),
      content: String(item.content ?? ""),
      status: (String(item.status ?? "pending") as TodoStatus),
      ...(item.activeForm ? { activeForm: String(item.activeForm) } : {}),
    };
  });

  const { items, corrections } = validateAndCorrectTodos(typedTodos, state.todoItems);

  // 更新 state
  state.todoItems = items;

  // 发事件给 UI
  onEvent?.({ type: "todo_update", items });

  // 构造返回（包含修正后的实际列表 + 修正说明）
  const correctionNote =
    corrections.length > 0
      ? `\n\n⚠️ Runtime 修正了以下违规：\n${corrections.map((c) => `- ${c}`).join("\n")}`
      : "\n\n✅ 所有 invariant 检查通过，列表已原样接受。";

  const todoSummary = items
    .map((t) => `  [${t.status}] ${t.id}: ${t.content}`)
    .join("\n");

  return {
    outcome: "success",
    tool: UPDATE_TODO_TOOL_ID,
    message: `待办列表已更新（${items.length} 项）：\n${todoSummary}${correctionNote}`,
    output: JSON.stringify({ items, corrections }),
  };
}

// ── ask_user ─────────────────────────────────────────────

export const ASK_USER_TOOL_ID = "ask_user";

export const askUserToolSpec: ToolSpec = {
  name: ASK_USER_TOOL_ID,
  description:
    "向用户提问以补充信息。这是排他工具：一轮里出现 ask_user 时，其他工具调用不执行。\n" +
    "用法：传入多个问题，每个问题有选项列表，用户可选或自定义输入。\n" +
    "用户回答后，模型根据回答重新决策下一步。",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description: "要问用户的问题列表",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "问题唯一标识" },
            question: { type: "string", description: "问题文本" },
            options: {
              type: "array",
              description: "可选项列表",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "选项显示文本" },
                  value: { type: "string", description: "选项值" },
                },
                required: ["label", "value"],
              },
            },
            allowCustom: { type: "boolean", description: "是否允许自定义输入（默认 true）" },
          },
          required: ["id", "question", "options"],
        },
      },
    },
    required: ["questions"],
  },
};

interface AskQuestion {
  id: string;
  question: string;
  options: Array<{ label: string; value: string }>;
  allowCustom?: boolean;
}

interface AskAnswer {
  questionId: string;
  selectedValue?: string;
  selectedLabel?: string;
  customInput?: string;
}

/**
 * 执行 ask_user（v3 §9.4）。
 * 完全复用现有 requestUserClarification 链路。
 */
export async function executeAskUser(
  call: ToolCall,
  requestUserClarification: ((card: unknown) => Promise<unknown>) | undefined,
  onEvent?: (event: HarnessEvent) => void,
): Promise<ToolObservation> {
  const args = parseToolCallArgs(call);
  const rawQuestions = (args.questions as unknown) ?? [];

  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return {
      outcome: "failure",
      category: "invalid_arguments",
      tool: ASK_USER_TOOL_ID,
      message: "questions 参数必须是非空数组",
    };
  }

  if (!requestUserClarification) {
    return {
      outcome: "failure",
      category: "runtime_safety",
      tool: ASK_USER_TOOL_ID,
      message: "requestUserClarification 函数未注入，无法向用户提问",
    };
  }

  const questions: AskQuestion[] = rawQuestions.map((q: unknown) => {
    const item = q as Record<string, unknown>;
    return {
      id: String(item.id ?? ""),
      question: String(item.question ?? ""),
      options: Array.isArray(item.options)
        ? (item.options as Array<Record<string, unknown>>).map((o) => ({
            label: String(o.label ?? ""),
            value: String(o.value ?? ""),
          }))
        : [],
      ...(item.allowCustom !== undefined ? { allowCustom: Boolean(item.allowCustom) } : {}),
    };
  });

  // 构造 AskClarificationCard（复用现有 UI 卡片格式）
  // 关键: AskClarificationCard.questions[].field 是 AskCard 内部 key;
  // AskUserAnswer.answers[].field 返回时就是这个 field.
  // 我们把 question.id 映射到 field, 收答案时再翻译回 questionId, 让模型无歧义看到.
  const card = {
    mode: "semantic_clarification" as const,
    intro: "任务需要补全信息",
    questions: questions.map((q) => ({
      field: q.id,                    // ← 用 field 承载 question.id
      question: q.question,
      type: "single_select" as const, // P0: 单选; options 提供时走 single_select
      options: q.options.map((o) => ({ value: o.value, label: o.label })),
      allowCustom: q.allowCustom ?? true,
      freeTextPlaceholder: "或自定义输入",
    })),
    deferredFields: [],
  };

  onEvent?.({ type: "ask_user", card });

  try {
    const rawAnswer = await requestUserClarification(card);
    // AskUserAnswer.answers[] 的 field 就是上面我们塞进去的 question.id
    const rawAnswers = (rawAnswer as { answers?: Array<{ field?: string; selectedValues?: string[]; customText?: string }> })?.answers ?? [];

    // 翻译回模型能看懂的形状: 每个 question 都给一份, 缺的回答标 null
    const answers: AskAnswer[] = questions.map((q) => {
      const matched = rawAnswers.find((a) => a.field === q.id);
      const selectedValue = matched?.selectedValues?.[0];
      const selectedLabel = selectedValue
        ? q.options.find((o) => o.value === selectedValue)?.label
        : undefined;
      return {
        questionId: q.id,
        selectedValue,
        selectedLabel,
        customInput: matched?.customText ?? undefined,
      };
    });

    return {
      outcome: "success",
      tool: ASK_USER_TOOL_ID,
      message: `用户已回答 ${answers.filter((a) => a.selectedValue || a.customInput).length} 个问题`,
      output: JSON.stringify({ answers }),
    };
  } catch (err) {
    if (isAbortError(err)) throw err;
    return {
      outcome: "failure",
      category: "timeout",
      tool: ASK_USER_TOOL_ID,
      message: `用户回答超时或失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── confirm_uncertain_effect ─────────────────────────────

export const CONFIRM_UNCERTAIN_EFFECT_TOOL_ID = "confirm_uncertain_effect";

export const confirmUncertainEffectToolSpec: ToolSpec = {
  name: CONFIRM_UNCERTAIN_EFFECT_TOOL_ID,
  description:
    "当 Runtime 报告 unresolved uncertain effect 时，使用 effectId 请求用户明确确认是否允许再执行一次。" +
    "确认文案和选项由 Runtime 固定生成，不能由模型提供。该工具与 ask_user 一样是排他工具。",
  parameters: {
    type: "object",
    properties: {
      effectId: { type: "string", description: "Runtime observation 给出的 effectId" },
    },
    required: ["effectId"],
  },
};

export async function executeConfirmUncertainEffect(
  call: ToolCall,
  state: AgentState,
  requestUserClarification: ((card: unknown) => Promise<unknown>) | undefined,
): Promise<ToolObservation> {
  const effectId = String(parseToolCallArgs(call).effectId ?? "").trim();
  const effect = state.uncertainEffects.find((candidate) => candidate.id === effectId);
  if (!effect) {
    return {
      outcome: "failure",
      category: "invalid_arguments",
      tool: CONFIRM_UNCERTAIN_EFFECT_TOOL_ID,
      message: `未找到 unresolved uncertain effect: ${effectId || "(empty)"}`,
    };
  }
  if (!requestUserClarification) {
    return {
      outcome: "failure",
      category: "runtime_safety",
      tool: CONFIRM_UNCERTAIN_EFFECT_TOOL_ID,
      message: "requestUserClarification 函数未注入，无法取得用户确认",
    };
  }

  const card = {
    mode: "semantic_clarification" as const,
    intro: `前一次 ${effect.toolName} 的结果无法确认。再次执行可能产生重复副作用。`,
    questions: [{
      field: "decision",
      question: "是否仍要允许下一次相同操作？",
      type: "single_select" as const,
      options: [
        { value: "allow_repeat", label: "仍然允许一次" },
        { value: "do_not_repeat", label: "不要重复执行" },
      ],
      allowCustom: false,
      freeTextPlaceholder: "",
    }],
    deferredFields: [],
  };

  try {
    const raw = await requestUserClarification(card) as {
      answers?: Array<{ field?: string; selectedValues?: string[] }>;
    };
    const decision = raw.answers?.find((answer) => answer.field === "decision")?.selectedValues?.[0];
    const authorized = decision === "allow_repeat"
      && authorizeUncertainEffectRepeat(state, effectId);
    return {
      outcome: "success",
      tool: CONFIRM_UNCERTAIN_EFFECT_TOOL_ID,
      message: authorized
        ? "用户已明确授权下一次匹配操作；授权只消费一次。"
        : "用户未授权重复操作；uncertain effect 保持 unresolved。",
      output: JSON.stringify({ effectId, authorized }),
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      outcome: "failure",
      category: "timeout",
      tool: CONFIRM_UNCERTAIN_EFFECT_TOOL_ID,
      message: `用户确认超时或失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ── 内置工具注册 ─────────────────────────────────────────

export const HARNESS_BUILTIN_TOOL_IDS = new Set([
  UPDATE_TODO_TOOL_ID,
  ASK_USER_TOOL_ID,
  CONFIRM_UNCERTAIN_EFFECT_TOOL_ID,
]);

export function isHarnessBuiltin(toolName: string): boolean {
  return HARNESS_BUILTIN_TOOL_IDS.has(toolName);
}

export function getHarnessBuiltinToolSpecs(): ToolSpec[] {
  return [updateTodoToolSpec, askUserToolSpec, confirmUncertainEffectToolSpec];
}
