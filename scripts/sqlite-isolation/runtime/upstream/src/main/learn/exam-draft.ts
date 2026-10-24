import Ajv, { type ValidateFunction } from "ajv";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  LEARN_EXAM_SCHEMA_VERSION,
  type LearnExamInput,
  type LearnExamPlanInput,
  type LearnExamQuestionInput,
  type LearnExamQuestionRecord,
  type LearnExamQuestionType,
  type LearnExamRecord,
} from "../../shared/learn-exam";
import type { ExamPaperStore } from "./exam-paper-store";

const DRAFT_ID_PATTERN = /^draft-[0-9a-f-]{36}$/i;
const MAX_QUESTIONS = 200;
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const POINTS_EPSILON = 0.001;

export interface DraftOwner {
  conversationId: string;
  runId: string;
}

export interface LearnExamDraftProgress {
  completed: number;
  remaining: number;
  pointsCompleted: number;
  pointsRemaining: number;
  totalCompleted: number;
  totalQuestions: number;
}

export interface LearnExamDraftRecord {
  draftId: string;
  examId: string;
  conversationId: string;
  runId: string;
  status: "draft" | "published";
  plan: LearnExamPlanInput;
  questions: LearnExamQuestionInput[];
  createdAt: number;
  expiresAt: number;
}

export interface LearnExamDraftStore {
  createDraft(plan: unknown, owner: DraftOwner): Promise<LearnExamDraftRecord>;
  appendBatch(draftId: string, type: LearnExamQuestionType, questions: unknown, owner: DraftOwner): Promise<{ progress: LearnExamDraftProgress }>;
  getDraft(draftId: string, owner: DraftOwner): Promise<LearnExamDraftRecord | null>;
  publish(draftId: string, owner: DraftOwner): Promise<{ record: LearnExamRecord; alreadyPublished: boolean }>;
  deleteExpired(): Promise<number>;
}

export type LearnExamValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

const ajv = new Ajv({ allErrors: true, strict: false });
const planValidator = ajv.compile<LearnExamPlanInput>({
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "integer", const: LEARN_EXAM_SCHEMA_VERSION },
    title: { type: "string", minLength: 1 },
    subject: { type: "string", minLength: 1 },
    durationMinutes: { type: "integer", minimum: 1, maximum: 1440 },
    totalPoints: { type: "number", exclusiveMinimum: 0 },
    quotas: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: ["single_choice", "multiple_choice", "true_false", "fill_blank", "short_answer", "essay"] },
          count: { type: "integer", minimum: 1 },
          points: { type: "number", exclusiveMinimum: 0 },
          learningObjectives: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        },
        required: ["type", "count", "points", "learningObjectives"],
      },
    },
  },
  required: ["schemaVersion", "title", "subject", "durationMinutes", "totalPoints", "quotas"],
});

const questionBase = {
  prompt: { type: "string", minLength: 1, description: "支持 Markdown；行内公式用 $...$，独立公式用 $$...$$，代码使用带语言名的 Markdown 代码围栏。" },
  points: { type: "number", exclusiveMinimum: 0 },
  learningObjective: { type: "string", minLength: 1 },
  explanation: { type: "string" },
};
const questionSchemas: Record<LearnExamQuestionType, object> = {
  single_choice: {
    type: "object", additionalProperties: false,
    properties: { ...questionBase, type: { const: "single_choice" }, options: { type: "array", minItems: 2, maxItems: 8, items: { type: "string", minLength: 1, description: "选项文本支持 Markdown、$...$ / $$...$$ 数学公式和代码围栏。" } }, correctIndex: { type: "integer", minimum: 0 } },
    required: ["type", "prompt", "points", "learningObjective", "explanation", "options", "correctIndex"],
  },
  multiple_choice: {
    type: "object", additionalProperties: false,
    properties: { ...questionBase, type: { const: "multiple_choice" }, options: { type: "array", minItems: 2, maxItems: 8, items: { type: "string", minLength: 1, description: "选项文本支持 Markdown、$...$ / $$...$$ 数学公式和代码围栏。" } }, correctIndexes: { type: "array", minItems: 1, uniqueItems: true, items: { type: "integer", minimum: 0 } } },
    required: ["type", "prompt", "points", "learningObjective", "explanation", "options", "correctIndexes"],
  },
  true_false: {
    type: "object", additionalProperties: false,
    properties: { ...questionBase, type: { const: "true_false" }, correct: { type: "boolean" } },
    required: ["type", "prompt", "points", "learningObjective", "explanation", "correct"],
  },
  fill_blank: {
    type: "object", additionalProperties: false,
    properties: { ...questionBase, type: { const: "fill_blank" }, blanks: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", additionalProperties: false, properties: { referenceAnswer: { type: "string", minLength: 1 }, rubric: { type: "array", items: { type: "string" } } }, required: ["referenceAnswer", "rubric"] } } },
    required: ["type", "prompt", "points", "learningObjective", "explanation", "blanks"],
  },
  short_answer: {
    type: "object", additionalProperties: false,
    properties: { ...questionBase, type: { const: "short_answer" }, referenceAnswer: { type: "string", minLength: 1 }, rubric: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } } },
    required: ["type", "prompt", "points", "learningObjective", "explanation", "referenceAnswer", "rubric"],
  },
  essay: {
    type: "object", additionalProperties: false,
    properties: { ...questionBase, type: { const: "essay" }, referenceAnswer: { type: "string", minLength: 1 }, rubric: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } } },
    required: ["type", "prompt", "points", "learningObjective", "explanation", "referenceAnswer", "rubric"],
  },
};
const questionValidators = new Map<LearnExamQuestionType, ValidateFunction>(
  Object.entries(questionSchemas).map(([type, schema]) => [type as LearnExamQuestionType, ajv.compile(schema)]),
);

function error(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function validationDetails(validator: ValidateFunction): string {
  return (validator.errors ?? []).slice(0, 5).map((issue) => {
    const pointer = issue.instancePath || "根对象";
    const property = (issue.params as { missingProperty?: string; additionalProperty?: string }).missingProperty
      ?? (issue.params as { additionalProperty?: string }).additionalProperty;
    return `${pointer}${property ? `/${property}` : ""} ${issue.message ?? "无效"}`;
  }).join("；");
}

export function validateLearnExamPlan(input: unknown): LearnExamValidationResult<LearnExamPlanInput> {
  if (!planValidator(input)) return { ok: false, error: validationDetails(planValidator) };
  const plan = input as LearnExamPlanInput;
  const types = new Set<LearnExamQuestionType>();
  let questionCount = 0;
  let quotaPoints = 0;
  for (const [index, quota] of plan.quotas.entries()) {
    if (types.has(quota.type)) return { ok: false, error: `/quotas/${index}/type 重复题型 ${quota.type}` };
    types.add(quota.type);
    questionCount += quota.count;
    quotaPoints += quota.points;
    for (const [objectiveIndex, objective] of quota.learningObjectives.entries()) {
      if (!objective.trim()) return { ok: false, error: `/quotas/${index}/learningObjectives/${objectiveIndex} 不能为空` };
    }
  }
  if (questionCount > MAX_QUESTIONS) return { ok: false, error: `/quotas 总题量不能超过 ${MAX_QUESTIONS}` };
  if (Math.abs(quotaPoints - plan.totalPoints) > POINTS_EPSILON) {
    return { ok: false, error: `/totalPoints ${plan.totalPoints} 必须等于题型配额分值之和 ${quotaPoints}` };
  }
  return { ok: true, value: structuredClone(plan) };
}

export function validateLearnExamQuestionBatch(type: LearnExamQuestionType, input: unknown): LearnExamValidationResult<LearnExamQuestionInput[]> {
  if (!Array.isArray(input) || input.length === 0) return { ok: false, error: "questions 必须是非空数组" };
  const validator = questionValidators.get(type);
  if (!validator) return { ok: false, error: `不支持的题型 ${type}` };
  const questions: LearnExamQuestionInput[] = [];
  for (const [index, question] of input.entries()) {
    if (!validator(question)) {
      const actualType = question && typeof question === "object" ? (question as { type?: unknown }).type : undefined;
      if (actualType !== type) return { ok: false, error: `/questions/${index}/type 必须是 ${type}，收到 ${String(actualType)}` };
      return { ok: false, error: `/questions/${index} ${validationDetails(validator)}` };
    }
    if (type === "single_choice" && (question as { correctIndex: number }).correctIndex >= (question as { options: unknown[] }).options.length) {
      return { ok: false, error: `/questions/${index}/correctIndex 超出选项范围` };
    }
    if (type === "multiple_choice" && (question as { correctIndexes: number[] }).correctIndexes.some((value) => value >= (question as { options: unknown[] }).options.length)) {
      return { ok: false, error: `/questions/${index}/correctIndexes 超出选项范围` };
    }
    questions.push(question as LearnExamQuestionInput);
  }
  return { ok: true, value: questions };
}

export function getLearnExamQuestionJsonSchema(type: LearnExamQuestionType): object {
  return structuredClone(questionSchemas[type]);
}

function materializeQuestion(question: LearnExamQuestionInput, id: string): LearnExamQuestionRecord {
  const base = { id, type: question.type, prompt: question.prompt.trim(), points: question.points, learningObjective: question.learningObjective.trim(), explanation: question.explanation.trim() };
  switch (question.type) {
    case "single_choice": {
      const options = question.options.map((label, index) => ({ id: `${id}-o${index + 1}`, label: label.trim() }));
      return { ...base, type: question.type, options, correctOptionId: options[question.correctIndex]!.id };
    }
    case "multiple_choice": {
      const options = question.options.map((label, index) => ({ id: `${id}-o${index + 1}`, label: label.trim() }));
      return { ...base, type: question.type, options, correctOptionIds: question.correctIndexes.map((index) => options[index]!.id) };
    }
    case "true_false": return { ...base, type: question.type, correct: question.correct };
    case "fill_blank": return { ...base, type: question.type, blanks: question.blanks.map((blank) => ({ referenceAnswer: blank.referenceAnswer, rubric: [...blank.rubric] })) };
    case "short_answer":
    case "essay": return { ...base, type: question.type, referenceAnswer: question.referenceAnswer, rubric: [...question.rubric] };
  }
}

export function createExamDraftStore(userDataDir: string, paperStore: ExamPaperStore, options: { now?: () => number } = {}): LearnExamDraftStore {
  const root = path.join(userDataDir, "learn-exam-drafts");
  const now = options.now ?? Date.now;
  const writeTails = new Map<string, Promise<void>>();

  function filePath(draftId: string): string {
    if (!DRAFT_ID_PATTERN.test(draftId)) throw error("draftId 无效", "E_LEARN_EXAM_DRAFT_NOT_FOUND");
    return path.join(root, `${draftId}.json`);
  }

  async function read(draftId: string): Promise<LearnExamDraftRecord | null> {
    try {
      const value: unknown = JSON.parse(await readFile(filePath(draftId), "utf8"));
      if (!value || typeof value !== "object" || (value as LearnExamDraftRecord).draftId !== draftId) return null;
      return value as LearnExamDraftRecord;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw cause;
    }
  }

  async function write(record: LearnExamDraftRecord): Promise<void> {
    await mkdir(root, { recursive: true });
    const destination = filePath(record.draftId);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(record), "utf8");
      await rename(temporary, destination);
    } catch (cause) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw cause;
    }
  }

  async function serialized<T>(draftId: string, action: () => Promise<T>): Promise<T> {
    const previous = writeTails.get(draftId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    writeTails.set(draftId, current);
    await previous.catch(() => undefined);
    try { return await action(); }
    finally {
      release();
      if (writeTails.get(draftId) === current) writeTails.delete(draftId);
    }
  }

  function assertOwner(record: LearnExamDraftRecord, owner: DraftOwner): void {
    if (record.conversationId !== owner.conversationId || record.runId !== owner.runId || record.expiresAt <= now()) {
      throw error("找不到有效的出卷草稿", "E_LEARN_EXAM_DRAFT_NOT_FOUND");
    }
  }

  function progress(record: LearnExamDraftRecord, type: LearnExamQuestionType): LearnExamDraftProgress {
    const quota = record.plan.quotas.find((item) => item.type === type)!;
    const completedQuestions = record.questions.filter((question) => question.type === type);
    const pointsCompleted = completedQuestions.reduce((sum, question) => sum + question.points, 0);
    return {
      completed: completedQuestions.length,
      remaining: Math.max(0, quota.count - completedQuestions.length),
      pointsCompleted,
      pointsRemaining: Math.max(0, quota.points - pointsCompleted),
      totalCompleted: record.questions.length,
      totalQuestions: record.plan.quotas.reduce((sum, item) => sum + item.count, 0),
    };
  }

  async function getOwned(draftId: string, owner: DraftOwner): Promise<LearnExamDraftRecord> {
    const record = await read(draftId);
    if (!record) throw error("找不到有效的出卷草稿", "E_LEARN_EXAM_DRAFT_NOT_FOUND");
    assertOwner(record, owner);
    return record;
  }

  return {
    async createDraft(input, owner) {
      if (!owner.conversationId?.trim() || !owner.runId?.trim()) throw error("出卷计划缺少会话或运行上下文", "E_LEARN_EXAM_NO_CONTEXT");
      const validation = validateLearnExamPlan(input);
      if (!validation.ok) throw error(`试卷计划无效：${validation.error}`, "E_LEARN_EXAM_INVALID_PLAN");
      const timestamp = now();
      const record: LearnExamDraftRecord = {
        draftId: `draft-${randomUUID()}`,
        examId: `exam-${randomUUID()}`,
        conversationId: owner.conversationId,
        runId: owner.runId,
        status: "draft",
        plan: validation.value,
        questions: [],
        createdAt: timestamp,
        expiresAt: timestamp + DRAFT_TTL_MS,
      };
      await write(record);
      return structuredClone(record);
    },
    async appendBatch(draftId, type, input, owner) {
      return serialized(draftId, async () => {
        const record = await getOwned(draftId, owner);
        if (record.status !== "draft") throw error("草稿已发布，不能继续写题", "E_LEARN_EXAM_DRAFT_PUBLISHED");
        const quota = record.plan.quotas.find((item) => item.type === type);
        if (!quota) throw error(`计划中没有 ${type} 题型配额`, "E_LEARN_EXAM_DRAFT_TYPE_MISMATCH");
        const batchValidation = validateLearnExamQuestionBatch(type, input);
        if (!batchValidation.ok) throw error(batchValidation.error, batchValidation.error.includes("/type") ? "E_LEARN_EXAM_DRAFT_TYPE_MISMATCH" : "E_LEARN_EXAM_DRAFT_INVALID_QUESTION");
        const current = record.questions.filter((question) => question.type === type);
        const next = [...current, ...batchValidation.value];
        if (next.length > quota.count) throw error(`${type} 已超过题量配额 ${quota.count}`, "E_LEARN_EXAM_DRAFT_COUNT_EXCEEDED");
        const pointsCompleted = next.reduce((sum, question) => sum + question.points, 0);
        if (pointsCompleted - quota.points > POINTS_EPSILON) throw error(`${type} 已超过分值配额 ${quota.points}`, "E_LEARN_EXAM_DRAFT_POINTS_EXCEEDED");
        if (next.length === quota.count && Math.abs(pointsCompleted - quota.points) > POINTS_EPSILON) {
          throw error(`${type} 完成 ${quota.count} 题时分值必须合计 ${quota.points}，当前为 ${pointsCompleted}`, "E_LEARN_EXAM_DRAFT_POINTS_MISMATCH");
        }
        record.questions = [...record.questions, ...structuredClone(batchValidation.value)];
        await write(record);
        return { progress: progress(record, type) };
      });
    },
    async getDraft(draftId, owner) {
      const record = await read(draftId);
      if (!record) return null;
      assertOwner(record, owner);
      return structuredClone(record);
    },
    async publish(draftId, owner) {
      return serialized(draftId, async () => {
        const record = await getOwned(draftId, owner);
        if (record.status === "published") {
          const existing = await paperStore.get(record.examId);
          if (existing?.conversationId === owner.conversationId) return { record: existing, alreadyPublished: true };
          throw error("已发布试卷记录缺失", "E_LEARN_EXAM_PUBLISH_RECOVERY_FAILED");
        }
        const incomplete = record.plan.quotas.flatMap((quota) => {
          const questions = record.questions.filter((question) => question.type === quota.type);
          const points = questions.reduce((sum, question) => sum + question.points, 0);
          return questions.length !== quota.count || Math.abs(points - quota.points) > POINTS_EPSILON
            ? [`${quota.type} 需要 ${quota.count} 题/${quota.points} 分，当前 ${questions.length} 题/${points} 分`]
            : [];
        });
        const totalPoints = record.questions.reduce((sum, question) => sum + question.points, 0);
        if (incomplete.length || Math.abs(totalPoints - record.plan.totalPoints) > POINTS_EPSILON) {
          throw error(`试卷尚未完成：${[...incomplete, ...(Math.abs(totalPoints - record.plan.totalPoints) > POINTS_EPSILON ? [`总分需要 ${record.plan.totalPoints}，当前 ${totalPoints}`] : [])].join("；")}`, "E_LEARN_EXAM_DRAFT_INCOMPLETE");
        }
        const questions = record.questions.map((question) => materializeQuestion(question, `q-${randomUUID()}`));
        const formal: LearnExamRecord = {
          schemaVersion: LEARN_EXAM_SCHEMA_VERSION,
          examId: record.examId,
          conversationId: record.conversationId,
          title: record.plan.title.trim(),
          subject: record.plan.subject.trim(),
          durationMinutes: record.plan.durationMinutes,
          totalPoints: record.plan.totalPoints,
          questions,
          answers: {},
          activeQuestionId: questions[0].id,
          flaggedQuestionIds: [],
          status: "draft",
          createdAt: record.createdAt,
          updatedAt: now(),
        };
        const existing = await paperStore.get(formal.examId);
        if (existing) {
          if (existing.conversationId !== owner.conversationId) throw error("试卷编号已被其他会话使用", "E_LEARN_EXAM_PUBLISH_RECOVERY_FAILED");
        } else {
          await paperStore.create(formal);
        }
        record.status = "published";
        await write(record);
        return { record: existing ?? formal, alreadyPublished: false };
      });
    },
    async deleteExpired() {
      await mkdir(root, { recursive: true });
      const names = await readdir(root);
      let removed = 0;
      for (const name of names.filter((item) => item.endsWith(".json") && DRAFT_ID_PATTERN.test(item.slice(0, -5)))) {
        const record = await read(name.slice(0, -5));
        if (record && record.expiresAt <= now()) {
          await rm(filePath(record.draftId), { force: true });
          removed += 1;
        }
      }
      return removed;
    },
  };
}
