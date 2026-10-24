import Ajv from "ajv";
import {
  type LearnExamGradingResult,
  type LearnExamQuestionType,
  type LearnExamChangedEvent,
  type LearnExamCreatedEvent,
} from "../../shared/learn-exam";
import { toolRegistry, type ToolDefinition } from "./tools/registry/tool-registry";
import type { ToolContext } from "./tools/registry/tool-context";
import type { ExamPaperStore } from "../learn/exam-paper-store";
import { getLearnExamQuestionJsonSchema, type LearnExamDraftStore } from "../learn/exam-draft";
import { publishLearnExamChanged, publishLearnExamCreated } from "../learn/exam-paper-ipc";

const LOG_PREFIX = "[LearnExam]";
const ajv = new Ajv({ allErrors: true, strict: false });
const validateExamId = ajv.compile<{ examId: string }>({
  type: "object", additionalProperties: false,
  properties: { examId: { type: "string", minLength: 1 } }, required: ["examId"],
});
const validateGrading = ajv.compile<LearnExamGradingResult>({
  type: "object", additionalProperties: false,
  properties: {
    totalScore: { type: "number", minimum: 0 },
    summary: { type: "string", minLength: 1 },
    questionResults: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, properties: { questionId: { type: "string" }, awardedPoints: { type: "number", minimum: 0 }, feedback: { type: "string" }, ability: { type: "string" } }, required: ["questionId", "awardedPoints", "feedback"] } },
    abilityAnalysis: { type: "array", items: { type: "object", additionalProperties: false, properties: { ability: { type: "string" }, score: { type: "number", minimum: 0 }, total: { type: "number", minimum: 0 }, feedback: { type: "string" } }, required: ["ability", "score", "total", "feedback"] } },
    nextSteps: { type: "array", items: { type: "string" } },
  },
  required: ["totalScore", "summary", "questionResults", "abilityAnalysis", "nextSteps"],
});

function toolError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function getConversationId(ctx?: ToolContext): string {
  const conversationId = ctx?.conversationId?.trim();
  if (!conversationId) throw toolError("正式试卷工具缺少对话上下文", "E_LEARN_EXAM_NO_CONVERSATION");
  return conversationId;
}

function getDraftOwner(ctx?: ToolContext): { conversationId: string; runId: string } {
  const conversationId = getConversationId(ctx);
  const runId = ctx?.runId?.trim();
  if (!runId) throw toolError("分阶段出卷工具缺少运行上下文", "E_LEARN_EXAM_NO_RUN");
  return { conversationId, runId };
}

function objectSchema(properties: Record<string, unknown>, required: string[]): ToolDefinition["inputSchema"] {
  return { type: "object", properties, required } as unknown as ToolDefinition["inputSchema"];
}

const planSchema = objectSchema({
  schemaVersion: { type: "integer", enum: [1] },
  title: { type: "string", description: "试卷标题" },
  subject: { type: "string", description: "学科或主题" },
  durationMinutes: { type: "integer", description: "建议答题分钟数" },
  totalPoints: { type: "number", description: "整卷满分，必须等于各题型 points 之和" },
  quotas: {
    type: "array",
    items: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["single_choice", "multiple_choice", "true_false", "fill_blank", "short_answer", "essay"] },
        count: { type: "integer", description: "该题型题量" },
        points: { type: "number", description: "该题型全部题目的分值总和" },
        learningObjectives: { type: "array", items: { type: "string" }, description: "本题型考察目标" },
      },
      required: ["type", "count", "points", "learningObjectives"],
    },
  },
}, ["schemaVersion", "title", "subject", "durationMinutes", "totalPoints", "quotas"]);

const questionBaseProperties = {
  prompt: { type: "string", description: "题干支持 Markdown；行内公式用 $...$，独立公式用 $$...$$，代码使用带语言名的 Markdown 代码围栏。" },
  points: { type: "number", description: "本题分值，合计须匹配计划配额" },
  learningObjective: { type: "string", description: "本题考察目标" },
  explanation: { type: "string", description: "供交卷后批改参考的解析，不在作答前展示" },
};

function writerSchema(type: LearnExamQuestionType | "written"): ToolDefinition["inputSchema"] {
  const itemSchema = type === "written"
    ? {
        type: "object", additionalProperties: false,
        properties: {
          ...questionBaseProperties,
          type: { type: "string", enum: ["short_answer", "essay"] },
          referenceAnswer: { type: "string" },
          rubric: { type: "array", items: { type: "string" } },
        },
        required: ["type", "prompt", "points", "learningObjective", "explanation", "referenceAnswer", "rubric"],
      }
    : getLearnExamQuestionJsonSchema(type);
  return objectSchema({
    draftId: { type: "string", description: "learn_exam_create_plan 返回的草稿编号" },
    questions: { type: "array", items: itemSchema as never, description: "本批次必须全部属于对应题型；失败时整批不会写入" },
  }, ["draftId", "questions"]);
}

function progressSummary(draft: Awaited<ReturnType<LearnExamDraftStore["createDraft"]>>): Array<{ type: string; planned: number; completed: number; remaining: number; points: number; pointsCompleted: number }> {
  return draft.plan.quotas.map((quota) => {
    const questions = draft.questions.filter((question) => question.type === quota.type);
    return {
      type: quota.type,
      planned: quota.count,
      completed: questions.length,
      remaining: quota.count - questions.length,
      points: quota.points,
      pointsCompleted: questions.reduce((sum, question) => sum + question.points, 0),
    };
  });
}

function batchTool(
  draftStore: LearnExamDraftStore,
  config: { id: string; name: string; description: string; type: LearnExamQuestionType | "written" },
): ToolDefinition {
  return {
    id: config.id,
    name: config.name,
    description: config.description,
    enabled: true,
    modes: ["learn"],
    needsContext: true,
    effectKind: "mutation",
    verificationPolicy: "none",
    inputSchema: writerSchema(config.type),
    execute: async (args, ctx) => {
      const owner = getDraftOwner(ctx);
      if (typeof args.draftId !== "string") throw toolError("draftId 无效", "E_LEARN_EXAM_DRAFT_NOT_FOUND");
      if (!Array.isArray(args.questions) || args.questions.length === 0) throw toolError("questions 必须是非空数组", "E_LEARN_EXAM_DRAFT_INVALID_QUESTION");
      const type = config.type === "written"
        ? (args.questions[0] as { type?: LearnExamQuestionType } | undefined)?.type
        : config.type;
      if (type !== "short_answer" && type !== "essay" && config.type === "written") {
        throw toolError("learn_exam_add_written 只接受 short_answer 或 essay", "E_LEARN_EXAM_DRAFT_TYPE_MISMATCH");
      }
      const result = await draftStore.appendBatch(args.draftId, type as LearnExamQuestionType, args.questions, owner);
      return JSON.stringify({
        draftId: args.draftId,
        type,
        completed: result.progress.completed,
        remaining: result.progress.remaining,
        pointsCompleted: result.progress.pointsCompleted,
        pointsRemaining: result.progress.pointsRemaining,
        totalCompleted: result.progress.totalCompleted,
        totalQuestions: result.progress.totalQuestions,
      });
    },
  };
}

export function createLearnExamTools(store: ExamPaperStore, draftStore: LearnExamDraftStore): {
  createPlan: ToolDefinition;
  addSingleChoice: ToolDefinition;
  addMultipleChoice: ToolDefinition;
  addTrueFalse: ToolDefinition;
  addFillBlank: ToolDefinition;
  addWritten: ToolDefinition;
  publish: ToolDefinition;
  getSubmission: ToolDefinition;
  saveGrading: ToolDefinition;
} {
  const createPlan: ToolDefinition = {
    id: "learn_exam_create_plan",
    name: "创建试卷计划",
    description: "在用户确认命题蓝图后创建隐藏试卷草稿。这里只确定题型、题量、分值与考察目标，不写题干、选项或答案；随后按配额调用对应题型工具。",
    enabled: true,
    modes: ["learn"],
    needsContext: true,
    effectKind: "mutation",
    verificationPolicy: "none",
    inputSchema: planSchema,
    execute: async (args, ctx) => {
      const draft = await draftStore.createDraft(args, getDraftOwner(ctx));
      console.info(LOG_PREFIX, "试卷计划已创建", { draftId: draft.draftId, conversationId: draft.conversationId, runId: draft.runId });
      return JSON.stringify({ draftId: draft.draftId, title: draft.plan.title, subject: draft.plan.subject, quotas: progressSummary(draft), message: "计划已建立；按各题型分别写题，所有配额完成后调用 learn_exam_publish。" });
    },
  };

  const publish: ToolDefinition = {
    id: "learn_exam_publish",
    name: "校验并发布试卷",
    description: "检查每种题型的题量和分值是否达到计划，全部通过后才发布试卷并在右侧打开答题页。失败时按返回的问题继续补题；成功后告知用户页面已打开并结束本轮。",
    enabled: true,
    modes: ["learn"],
    needsContext: true,
    effectKind: "mutation",
    verificationPolicy: "none",
    inputSchema: objectSchema({ draftId: { type: "string", description: "创建试卷计划工具返回的草稿编号" } }, ["draftId"]),
    execute: async (args, ctx) => {
      const owner = getDraftOwner(ctx);
      if (typeof args.draftId !== "string") throw toolError("draftId 无效", "E_LEARN_EXAM_DRAFT_NOT_FOUND");
      const result = await draftStore.publish(args.draftId, owner);
      const record = result.record;
      const event: LearnExamCreatedEvent = { conversationId: owner.conversationId, examId: record.examId };
      if (!result.alreadyPublished) publishLearnExamCreated(event);
      console.info(LOG_PREFIX, "分阶段试卷已发布", { examId: record.examId, conversationId: owner.conversationId, questionCount: record.questions.length });
      return JSON.stringify({ examId: record.examId, title: record.title, status: record.status, message: "试卷已显示在右侧内置浏览器；用户可以独立作答，本轮可以结束。" });
    },
  };

  const getSubmission: ToolDefinition = {
    id: "learn_exam_get_submission",
    name: "读取已交卷试卷",
    description: "只在用户已经明确交卷后的新一轮批改中调用。根据 examId 读取完整题目、评分细则、参考答案和已冻结的用户答案；不要在交卷前调用。",
    enabled: true,
    modes: ["learn"],
    needsContext: true,
    effectKind: "read",
    verificationPolicy: "none",
    inputSchema: { type: "object", properties: { examId: { type: "string", description: "发布试卷工具返回的 examId" } }, required: ["examId"] },
    execute: async (args, ctx) => {
      if (!validateExamId(args)) throw toolError("examId 无效", "E_LEARN_EXAM_INVALID_ID");
      const conversationId = getConversationId(ctx);
      const record = await store.get(args.examId);
      if (!record || record.conversationId !== conversationId) throw toolError("找不到这份试卷", "E_LEARN_EXAM_NOT_FOUND");
      if (!record.submittedAnswers) throw toolError("用户尚未交卷，不能读取答案和评分资料", "E_LEARN_EXAM_NOT_SUBMITTED");
      if (record.status === "graded") throw toolError("这份试卷已经批改完成", "E_LEARN_EXAM_ALREADY_GRADED");
      const grading = await store.setStatus(record.examId, "grading");
      const event: LearnExamChangedEvent = { conversationId, examId: record.examId };
      publishLearnExamChanged(event);
      return JSON.stringify({
        examId: record.examId,
        title: record.title,
        subject: record.subject,
        totalPoints: record.totalPoints,
        questions: record.questions,
        submittedAnswers: grading?.submittedAnswers ?? record.submittedAnswers,
        instruction: "请按每题 points 与评分细则逐题批改，能力分析按 learningObjective 汇总；然后调用 learn_exam_save_grading 保存结构化结果。",
      });
    },
  };

  const saveGrading: ToolDefinition = {
    id: "learn_exam_save_grading",
    name: "保存试卷批改结果",
    description: "保存已交卷试卷的总分、逐题反馈和能力分析，供右侧答题页展示。仅能保存当前对话中已交卷的试卷。",
    enabled: true,
    modes: ["learn"],
    needsContext: true,
    effectKind: "mutation",
    verificationPolicy: "none",
    inputSchema: {
      type: "object",
      properties: {
        examId: { type: "string" },
        result: {
          type: "object",
          properties: {
            totalScore: { type: "number", minimum: 0 },
            summary: { type: "string" },
            questionResults: { type: "array", items: { type: "object", properties: { questionId: { type: "string" }, awardedPoints: { type: "number", minimum: 0 }, feedback: { type: "string" }, ability: { type: "string" } }, required: ["questionId", "awardedPoints", "feedback"] } },
            abilityAnalysis: { type: "array", items: { type: "object", properties: { ability: { type: "string" }, score: { type: "number", minimum: 0 }, total: { type: "number", minimum: 0 }, feedback: { type: "string" } }, required: ["ability", "score", "total", "feedback"] } },
            nextSteps: { type: "array", items: { type: "string" } },
          },
          required: ["totalScore", "summary", "questionResults", "abilityAnalysis", "nextSteps"],
        },
      },
      required: ["examId", "result"],
    } as unknown as ToolDefinition["inputSchema"],
    execute: async (args, ctx) => {
      if (!args || typeof args.examId !== "string" || !validateGrading(args.result)) throw toolError("批改结果结构无效", "E_LEARN_EXAM_INVALID_GRADING");
      const conversationId = getConversationId(ctx);
      const record = await store.get(args.examId);
      if (!record || record.conversationId !== conversationId) throw toolError("找不到这份试卷", "E_LEARN_EXAM_NOT_FOUND");
      if (!record.submittedAnswers) throw toolError("用户尚未交卷，不能保存批改结果", "E_LEARN_EXAM_NOT_SUBMITTED");
      const result = args.result as LearnExamGradingResult;
      const pointsByQuestion = new Map(record.questions.map((question) => [question.id, question.points]));
      const seen = new Set<string>();
      let awardedTotal = 0;
      for (const item of result.questionResults) {
        const points = pointsByQuestion.get(item.questionId);
        if (points === undefined || seen.has(item.questionId) || item.awardedPoints > points) throw toolError(`第 ${item.questionId} 题的批改分数无效`, "E_LEARN_EXAM_INVALID_GRADING");
        seen.add(item.questionId);
        awardedTotal += item.awardedPoints;
      }
      if (seen.size !== record.questions.length || result.totalScore > record.totalPoints || Math.abs(result.totalScore - awardedTotal) > 0.001) {
        throw toolError("批改结果必须覆盖全部题目、总分不能超过满分，且总分必须等于逐题得分之和", "E_LEARN_EXAM_INVALID_GRADING");
      }
      const saved = await store.saveGradingResult(record.examId, result);
      if (!saved) throw toolError("试卷当前状态不允许保存批改结果", "E_LEARN_EXAM_INVALID_STATE");
      publishLearnExamChanged({ conversationId, examId: record.examId });
      return JSON.stringify({ examId: saved.examId, status: saved.status, message: "批改结果已保存到右侧试卷。" });
    },
  };

  const addSingleChoice = batchTool(draftStore, { id: "learn_exam_add_single_choice", name: "写入单选题", description: "向出卷草稿追加单选题；每题必须用 options 和一个 correctIndex。", type: "single_choice" });
  const addMultipleChoice = batchTool(draftStore, { id: "learn_exam_add_multiple_choice", name: "写入多选题", description: "向出卷草稿追加多选题；每题必须用 options 和 correctIndexes 数组。", type: "multiple_choice" });
  const addTrueFalse = batchTool(draftStore, { id: "learn_exam_add_true_false", name: "写入判断题", description: "向出卷草稿追加判断题；每题用布尔型 correct。", type: "true_false" });
  const addFillBlank = batchTool(draftStore, { id: "learn_exam_add_fill_blank", name: "写入填空题", description: "向出卷草稿追加填空题；每个空填写 referenceAnswer 和 rubric。", type: "fill_blank" });
  const addWritten = batchTool(draftStore, { id: "learn_exam_add_written", name: "写入简答或解答题", description: "向出卷草稿追加简答题或解答题；每批只能包含一种 type，使用 referenceAnswer 和 rubric。", type: "written" });

  return { createPlan, addSingleChoice, addMultipleChoice, addTrueFalse, addFillBlank, addWritten, publish, getSubmission, saveGrading };
}

export function registerLearnExamTools(store: ExamPaperStore, draftStore: LearnExamDraftStore): void {
  const tools = createLearnExamTools(store, draftStore);
  for (const tool of Object.values(tools)) toolRegistry.register(tool);
}
