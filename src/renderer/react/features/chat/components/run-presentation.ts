export type AgentRunStageKind =
  | "understanding"
  | "planning"
  | "executing"
  | "waiting_permission"
  | "waiting_user"
  | "responding"
  | "completed"
  | "failed";

export interface AgentRunStage {
  kind: AgentRunStageKind;
  detail?: string;
}

export interface TaskPlanStep {
  id: string;
  title: string;
  status?: "pending" | "running" | "completed" | "failed";
}

export interface TaskPlanPresentation {
  title?: string;
  steps: TaskPlanStep[];
}

export interface AskUserInteraction {
  kind: "ask";
  id: string;
  question: string;
  options: Array<{
    id: string;
    label: string;
    description?: string;
  }>;
  allowCustomInput?: boolean;
  /** Structured clarification cards advance through these questions in the same bottom slot. */
  questions?: AskUserQuestion[];
  responseKind?: "choice" | "clarification";
  currentQuestion?: number;
  totalQuestions?: number;
}

export interface AskUserQuestion {
  field: string;
  question: string;
  options: Array<{
    id: string;
    label: string;
    description?: string;
  }>;
  allowCustomInput?: boolean;
  freeTextPlaceholder?: string;
  multiple?: boolean;
}

export interface PermissionInteraction {
  kind: "permission";
  id: string;
  toolName: string;
  summary: string;
  workspaceName?: string;
  targetPath?: string;
}

export type ComposerInteraction = AskUserInteraction | PermissionInteraction;

export type ComposerSlotKind = "composer" | ComposerInteraction["kind"];

export function resolveComposerSlot(interaction?: ComposerInteraction): ComposerSlotKind {
  return interaction?.kind ?? "composer";
}

export function describeRunStage(stage: AgentRunStage): string {
  switch (stage.kind) {
    case "understanding":
      return "昔涟正在理解需求…";
    case "planning":
      return "昔涟正在规划任务…";
    case "executing":
      return stage.detail ? `昔涟正在执行：${stage.detail}…` : "昔涟正在执行任务…";
    case "waiting_permission":
      return "昔涟正在获取审批…";
    case "waiting_user":
      return "昔涟正在询问…";
    case "responding":
      return "昔涟正在组织回复…";
    case "completed":
      return "昔涟已完成本轮处理";
    case "failed":
      return "昔涟这一步没有顺利完成";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeOptions(value: unknown): AskUserQuestion["options"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const option = asRecord(item);
    const id = asNonEmptyString(option?.value);
    const label = asNonEmptyString(option?.label);
    if (!id || !label) return [];
    return [{ id, label, description: asNonEmptyString(option?.description) }];
  });
}

/**
 * Accepts the two card payloads already emitted by main. Keeping this at the
 * renderer boundary makes malformed CUSTOM events inert instead of interactive.
 */
export function normalizeChoiceInteraction(value: unknown): AskUserInteraction | undefined {
  const card = asRecord(value);
  const id = asNonEmptyString(card?.id);
  if (!id) return undefined;

  const structuredQuestions = Array.isArray(card.questions) ? card.questions.flatMap((item) => {
    const question = asRecord(item);
    const field = asNonEmptyString(question?.field);
    const text = asNonEmptyString(question?.question);
    if (!field || !text) return [];
    return [{
      field,
      question: text,
      options: normalizeOptions(question.options),
      allowCustomInput: question.allowCustom !== false,
      freeTextPlaceholder: asNonEmptyString(question.freeTextPlaceholder),
      multiple: question.type === "multi_select",
    } satisfies AskUserQuestion];
  }) : [];
  if (structuredQuestions.length > 0) {
    const first = structuredQuestions[0];
    return {
      kind: "ask",
      id,
      question: first.question,
      options: first.options,
      questions: structuredQuestions,
      responseKind: "clarification",
    };
  }

  const question = asNonEmptyString(card.question);
  const options = normalizeOptions(card.options);
  if (!question || options.length === 0) return undefined;
  return {
    kind: "ask",
    id,
    question,
    options,
    allowCustomInput: true,
    responseKind: "choice",
  };
}

/** Converts the existing LangGraph CUSTOM payload into the small UI-only plan shape. */
export function normalizeTaskPlanPresentation(value: unknown): TaskPlanPresentation | undefined {
  const snapshot = asRecord(value);
  const steps = Array.isArray(snapshot?.steps) ? snapshot.steps.flatMap((item) => {
    const step = asRecord(item);
    const id = asNonEmptyString(step?.stepId);
    const title = asNonEmptyString(step?.objective);
    if (!id || !title) return [];
    const sourceStatus = asNonEmptyString(step.status);
    const status: TaskPlanStep["status"] = sourceStatus === "running"
      ? "running"
      : sourceStatus === "completed"
        ? "completed"
        : sourceStatus === "failed"
          ? "failed"
          : "pending";
    return [{ id, title, status }];
  }) : [];
  if (steps.length === 0) return undefined;
  return { title: asNonEmptyString(snapshot?.goal), steps };
}
