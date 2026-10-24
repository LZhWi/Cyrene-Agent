/** Learn 正式试卷：模型输入、主进程私有记录、渲染视图与交卷数据。 */

export const LEARN_EXAM_SCHEMA_VERSION = 1 as const;

export type LearnExamQuestionType =
  | "single_choice"
  | "multiple_choice"
  | "true_false"
  | "fill_blank"
  | "short_answer"
  | "essay";

interface LearnExamQuestionBaseInput {
  prompt: string;
  points: number;
  learningObjective: string;
  explanation: string;
}

export interface LearnExamSingleChoiceInput extends LearnExamQuestionBaseInput {
  type: "single_choice";
  options: string[];
  correctIndex: number;
}

export interface LearnExamMultipleChoiceInput extends LearnExamQuestionBaseInput {
  type: "multiple_choice";
  options: string[];
  correctIndexes: number[];
}

export interface LearnExamTrueFalseInput extends LearnExamQuestionBaseInput {
  type: "true_false";
  correct: boolean;
}

export interface LearnExamFillBlankInput extends LearnExamQuestionBaseInput {
  type: "fill_blank";
  blanks: Array<{ referenceAnswer: string; rubric: string[] }>;
}

export interface LearnExamShortAnswerInput extends LearnExamQuestionBaseInput {
  type: "short_answer";
  referenceAnswer: string;
  rubric: string[];
}

export interface LearnExamEssayInput extends LearnExamQuestionBaseInput {
  type: "essay";
  referenceAnswer: string;
  rubric: string[];
}

export type LearnExamQuestionInput =
  | LearnExamSingleChoiceInput
  | LearnExamMultipleChoiceInput
  | LearnExamTrueFalseInput
  | LearnExamFillBlankInput
  | LearnExamShortAnswerInput
  | LearnExamEssayInput;

export interface LearnExamInput {
  schemaVersion: typeof LEARN_EXAM_SCHEMA_VERSION;
  title: string;
  subject: string;
  durationMinutes: number;
  totalPoints: number;
  questions: LearnExamQuestionInput[];
}

/** 出卷计划按题型分配题量、总分和考察目标。 */
export interface LearnExamPlanQuota {
  type: LearnExamQuestionType;
  count: number;
  points: number;
  learningObjectives: string[];
}

export interface LearnExamPlanInput {
  schemaVersion: typeof LEARN_EXAM_SCHEMA_VERSION;
  title: string;
  subject: string;
  durationMinutes: number;
  totalPoints: number;
  quotas: LearnExamPlanQuota[];
}

export interface LearnExamOption {
  id: string;
  label: string;
}

interface LearnExamQuestionRecordBase {
  id: string;
  type: LearnExamQuestionType;
  prompt: string;
  points: number;
  learningObjective: string;
  explanation: string;
}

export type LearnExamQuestionRecord =
  | (LearnExamQuestionRecordBase & { type: "single_choice"; options: LearnExamOption[]; correctOptionId: string })
  | (LearnExamQuestionRecordBase & { type: "multiple_choice"; options: LearnExamOption[]; correctOptionIds: string[] })
  | (LearnExamQuestionRecordBase & { type: "true_false"; correct: boolean })
  | (LearnExamQuestionRecordBase & { type: "fill_blank"; blanks: Array<{ referenceAnswer: string; rubric: string[] }> })
  | (LearnExamQuestionRecordBase & { type: "short_answer" | "essay"; referenceAnswer: string; rubric: string[] });

export interface LearnExamAnswerValue {
  value: string | string[] | boolean;
}

export interface LearnExamQuestionResult {
  questionId: string;
  awardedPoints: number;
  feedback: string;
  ability?: string;
}

export interface LearnExamGradingResult {
  totalScore: number;
  summary: string;
  questionResults: LearnExamQuestionResult[];
  abilityAnalysis: Array<{ ability: string; score: number; total: number; feedback: string }>;
  nextSteps: string[];
}

export type LearnExamStatus = "draft" | "submitted" | "grading" | "grading_failed" | "graded";

/** 完整记录只由主进程存储和考试工具访问。 */
export interface LearnExamRecord {
  schemaVersion: typeof LEARN_EXAM_SCHEMA_VERSION;
  examId: string;
  conversationId: string;
  title: string;
  subject: string;
  durationMinutes: number;
  totalPoints: number;
  questions: LearnExamQuestionRecord[];
  answers: Record<string, LearnExamAnswerValue>;
  activeQuestionId: string;
  flaggedQuestionIds: string[];
  status: LearnExamStatus;
  submittedAnswers?: Record<string, LearnExamAnswerValue>;
  gradingResult?: LearnExamGradingResult;
  createdAt: number;
  updatedAt: number;
  submittedAt?: number;
}

/** 渲染端安全视图，不包含参考答案、评分细则或解析。 */
export interface LearnExamQuestionView {
  id: string;
  type: LearnExamQuestionType;
  prompt: string;
  points: number;
  learningObjective: string;
  options?: LearnExamOption[];
  blankCount?: number;
}

export interface LearnExamView {
  examId: string;
  conversationId: string;
  title: string;
  subject: string;
  durationMinutes: number;
  totalPoints: number;
  questions: LearnExamQuestionView[];
  answers: Record<string, LearnExamAnswerValue>;
  activeQuestionId: string;
  flaggedQuestionIds: string[];
  status: LearnExamStatus;
  gradingResult?: LearnExamGradingResult;
  createdAt: number;
  updatedAt: number;
  submittedAt?: number;
}

export interface LearnExamCreatedEvent {
  conversationId: string;
  examId: string;
}

export interface LearnExamChangedEvent {
  conversationId: string;
  examId: string;
  /** Only set by the isolated answer page on the first successful user submission. */
  gradingRequested?: boolean;
}

export interface LearnExamPageResult {
  ok: boolean;
  exam?: LearnExamView;
  error?: string;
  shouldStartGrading?: boolean;
}

/** 只注入应用自有考试页的窄 API；不接受 renderer 自行指定会话或试卷编号。 */
export interface LearnExamPageApi {
  getExam(): Promise<LearnExamPageResult>;
  saveAnswer(questionId: string, answer: LearnExamAnswerValue | null): Promise<LearnExamPageResult>;
  saveNavigation(activeQuestionId: string, flaggedQuestionIds: string[]): Promise<LearnExamPageResult>;
  submit(): Promise<LearnExamPageResult>;
  retry(): Promise<LearnExamPageResult>;
  onChanged(callback: (event: LearnExamChangedEvent) => void): () => void;
}

export function toLearnExamView(record: LearnExamRecord): LearnExamView {
  return {
    examId: record.examId,
    conversationId: record.conversationId,
    title: record.title,
    subject: record.subject,
    durationMinutes: record.durationMinutes,
    totalPoints: record.totalPoints,
    questions: record.questions.map((question) => ({
      id: question.id,
      type: question.type,
      prompt: question.prompt,
      points: question.points,
      learningObjective: question.learningObjective,
      ...(question.type === "single_choice" || question.type === "multiple_choice"
        ? { options: question.options }
        : question.type === "fill_blank"
          ? { blankCount: question.blanks.length }
          : {}),
    })),
    answers: record.status === "draft" ? record.answers : (record.submittedAnswers ?? record.answers),
    activeQuestionId: record.activeQuestionId,
    flaggedQuestionIds: record.flaggedQuestionIds,
    status: record.status,
    ...(record.gradingResult ? { gradingResult: record.gradingResult } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.submittedAt ? { submittedAt: record.submittedAt } : {}),
  };
}
