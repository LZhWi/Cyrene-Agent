import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  LearnExamAnswerValue,
  LearnExamGradingResult,
  LearnExamRecord,
  LearnExamStatus,
} from "../../shared/learn-exam";

export interface ExamPaperStore {
  create(record: LearnExamRecord): Promise<LearnExamRecord>;
  get(examId: string): Promise<LearnExamRecord | null>;
  listByConversation(conversationId: string): Promise<LearnExamRecord[]>;
  saveAnswer(examId: string, questionId: string, answer: LearnExamAnswerValue | null): Promise<LearnExamRecord | null>;
  saveNavigation(examId: string, activeQuestionId: string, flaggedQuestionIds: string[]): Promise<LearnExamRecord | null>;
  submit(examId: string): Promise<{ record: LearnExamRecord | null; alreadySubmitted: boolean }>;
  resetForRetry(examId: string): Promise<LearnExamRecord | null>;
  setStatus(examId: string, status: Extract<LearnExamStatus, "grading" | "grading_failed">): Promise<LearnExamRecord | null>;
  saveGradingResult(examId: string, result: LearnExamGradingResult): Promise<LearnExamRecord | null>;
  recoverInterruptedGrading(): Promise<void>;
}

export interface ExamPaperStoreOptions {
  now?: () => number;
}

const EXAM_ID_PATTERN = /^exam-[0-9a-f-]{36}$/i;

function isRecord(value: unknown): value is LearnExamRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<LearnExamRecord>;
  return record.schemaVersion === 1
    && typeof record.examId === "string"
    && EXAM_ID_PATTERN.test(record.examId)
    && typeof record.conversationId === "string"
    && Array.isArray(record.questions)
    && !!record.answers
    && typeof record.answers === "object"
    && typeof record.status === "string";
}

function validAnswer(record: LearnExamRecord, questionId: string, answer: LearnExamAnswerValue): boolean {
  const question = record.questions.find((item) => item.id === questionId);
  if (!question || !answer || typeof answer !== "object" || !("value" in answer)) return false;
  const value = answer.value;
  switch (question.type) {
    case "single_choice":
      return typeof value === "string" && question.options.some((option) => option.id === value);
    case "multiple_choice":
      return Array.isArray(value) && value.every((id) => typeof id === "string" && question.options.some((option) => option.id === id))
        && new Set(value).size === value.length;
    case "true_false":
      return typeof value === "boolean";
    case "fill_blank":
      return Array.isArray(value) && value.length === question.blanks.length && value.every((item) => typeof item === "string");
    case "short_answer":
    case "essay":
      return typeof value === "string";
  }
}

export function createExamPaperStore(userDataDir: string, options: ExamPaperStoreOptions = {}): ExamPaperStore {
  const root = path.join(userDataDir, "learn-exams");
  const now = options.now ?? Date.now;
  const writeTails = new Map<string, Promise<void>>();

  function filePath(examId: string): string {
    if (!EXAM_ID_PATTERN.test(examId)) throw new Error("E_LEARN_EXAM_INVALID_ID");
    return path.join(root, `${examId}.json`);
  }

  async function read(examId: string): Promise<LearnExamRecord | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(filePath(examId), "utf8"));
      return isRecord(parsed) ? parsed : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async function write(record: LearnExamRecord): Promise<void> {
    await mkdir(root, { recursive: true });
    const destination = filePath(record.examId);
    const temporary = `${destination}.${process.pid}.${now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(record), "utf8");
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async function serialized<T>(examId: string, action: () => Promise<T>): Promise<T> {
    const previous = writeTails.get(examId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    writeTails.set(examId, current);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (writeTails.get(examId) === current) writeTails.delete(examId);
    }
  }

  async function update(
    examId: string,
    transform: (record: LearnExamRecord) => LearnExamRecord | null,
  ): Promise<LearnExamRecord | null> {
    return serialized(examId, async () => {
      const current = await read(examId);
      if (!current) return null;
      const next = transform(current);
      if (!next) return null;
      next.updatedAt = now();
      await write(next);
      return next;
    });
  }

  return {
    async create(record) {
      return serialized(record.examId, async () => {
        if (await read(record.examId)) throw new Error("E_LEARN_EXAM_ALREADY_EXISTS");
        await write(record);
        return record;
      });
    },
    get: read,
    async listByConversation(conversationId) {
      await mkdir(root, { recursive: true });
      const names = await readdir(root);
      const records = await Promise.all(names
        .filter((name) => name.endsWith(".json") && EXAM_ID_PATTERN.test(name.slice(0, -5)))
        .map((name) => read(name.slice(0, -5))));
      return records
        .filter((record): record is LearnExamRecord => record?.conversationId === conversationId)
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    async saveAnswer(examId, questionId, answer) {
      return update(examId, (record) => {
        if (record.status !== "draft" || !record.questions.some((question) => question.id === questionId)) return null;
        if (answer === null) {
          delete record.answers[questionId];
          return record;
        }
        if (!validAnswer(record, questionId, answer)) return null;
        record.answers[questionId] = answer;
        return record;
      });
    },
    async saveNavigation(examId, activeQuestionId, flaggedQuestionIds) {
      return update(examId, (record) => {
        if (!record.questions.some((question) => question.id === activeQuestionId)) return null;
        const validQuestionIds = new Set(record.questions.map((question) => question.id));
        record.activeQuestionId = activeQuestionId;
        record.flaggedQuestionIds = [...new Set(flaggedQuestionIds.filter((id) => validQuestionIds.has(id)))];
        return record;
      });
    },
    async submit(examId) {
      let alreadySubmitted = false;
      const record = await update(examId, (current) => {
        if (current.status !== "draft") {
          alreadySubmitted = true;
          return null;
        }
        current.submittedAnswers = structuredClone(current.answers);
        current.status = "submitted";
        current.submittedAt = now();
        return current;
      });
      return { record: record ?? (alreadySubmitted ? await read(examId) : null), alreadySubmitted };
    },
    async resetForRetry(examId) {
      return update(examId, (record) => {
        if (record.status === "grading_failed" && record.submittedAnswers) {
          record.status = "submitted";
          return record;
        }
        return null;
      });
    },
    async setStatus(examId, status) {
      return update(examId, (record) => {
        if (record.status === "graded") return null;
        if (status === "grading" && record.status !== "submitted" && record.status !== "grading_failed") return null;
        if (status === "grading_failed" && record.status !== "grading") return null;
        record.status = status;
        return record;
      });
    },
    async saveGradingResult(examId, result) {
      return update(examId, (record) => {
        if (!record.submittedAnswers || (record.status !== "grading" && record.status !== "submitted" && record.status !== "grading_failed")) return null;
        record.gradingResult = result;
        record.status = "graded";
        return record;
      });
    },
    async recoverInterruptedGrading() {
      await mkdir(root, { recursive: true });
      const names = await readdir(root);
      for (const name of names.filter((item) => item.endsWith(".json") && EXAM_ID_PATTERN.test(item.slice(0, -5)))) {
        await update(name.slice(0, -5), (record) => {
          if (record.status !== "grading") return null;
          record.status = "grading_failed";
          return record;
        });
      }
    },
  };
}
