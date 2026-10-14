import { createHash } from "node:crypto";
import matter from "gray-matter";
import type { LearnReviewAttempt, LearnReviewItem, LearnStudyOverview, LearnStudySource } from "../../../shared/learn-study";
import type { PopQuizAnswerSubmission, QuizQuestionInput, QuizAnswerResult } from "../../../shared/pop-quiz";
import type { LearnExamRecord, LearnExamQuestionRecord } from "../../../shared/learn-exam";
import { createObsidianWorkspace } from "../obsidian/obsidian-workspace-service";
import { loadProgress } from "../progress/learn-progress-service";
import { buildPopQuizPublication, gradeQuizSubmission } from "../../orchestrator/pop-quiz";
import { studyPath, studyWorkspaceId } from "./study-path";

const FILE = "learn/reviews.md";
interface ReviewFile { schema: "cyrene-learn-reviews-v1"; items: LearnReviewItem[] }
function parse(content?: string): ReviewFile {
  if (content === undefined) return { schema: "cyrene-learn-reviews-v1", items: [] };
  // gray-matter caches by content; never mutate its shared parsed object.
  const data = structuredClone(matter(content).data) as ReviewFile;
  if (data.schema !== "cyrene-learn-reviews-v1" || !Array.isArray(data.items)
    || data.items.some((item) => !item.id || !item.question || !Array.isArray(item.attempts))) throw new Error("E_LEARN_REVIEW_FORMAT");
  return data;
}
function render(data: ReviewFile): string {
  const lines = data.items.map((item) => `- ${item.question.learningObjective} — ${item.attempts.at(-1)?.result ?? "未作答"}；下次：${item.nextReviewAt ?? "待讲评"}`);
  return `---\n${JSON.stringify(data, null, 2)}\n---\n\n# 学习复习记录\n\n实际作答记录；不代表知识掌握百分比。\n\n${lines.join("\n")}\n`;
}
export function advanceReview(item: LearnReviewItem, attempt: LearnReviewAttempt): void {
  item.attempts.push(attempt);
  if (attempt.result === "pending_model") { delete item.nextReviewAt; return; }
  item.streak = attempt.result === "correct" ? item.streak + 1 : 0;
  // Answer evidence determines the interval; repeated successful recall expands it.
  item.intervalDays = attempt.result === "incorrect" ? 1 : item.streak === 1 ? 3 : Math.min(60, Math.max(3, item.intervalDays * 2));
  item.nextReviewAt = new Date(Date.parse(attempt.at) + item.intervalDays * 86400000).toISOString();
}
function rebuildSchedule(item: LearnReviewItem): void {
  const attempts = [...item.attempts].sort((a, b) => a.at.localeCompare(b.at));
  item.attempts = []; item.streak = 0; item.intervalDays = 0; delete item.nextReviewAt;
  for (const attempt of attempts) advanceReview(item, attempt);
}
export class LearnReviewService {
  private readonly vault;
  constructor(private readonly root: string, private readonly now: () => number = Date.now) {
    this.vault = createObsidianWorkspace(root);
  }
  async items(): Promise<LearnReviewItem[]> {
    studyPath(this.root, FILE);
    try { return parse((await this.vault.readFile({ path: FILE })).content).items; }
    catch (error) { if ((error as { code?: string }).code === "PATH_NOT_FOUND") return []; throw error; }
  }
  private async update(action: (data: ReviewFile) => void): Promise<void> {
    studyPath(this.root, FILE);
    await this.vault.updateFile({ path: FILE, update: (current) => { const data = parse(current); action(data); return render(data); } });
  }
  async validateSource(source: LearnStudySource): Promise<void> {
    studyPath(this.root, source.file);
    const read = await this.vault.readFile({ path: source.file });
    if (!source.quote?.trim() || source.contentHash !== read.contentHash || !read.content.includes(source.quote)) throw new Error("E_LEARN_SOURCE_CONFLICT");
  }
  async record(input: { question: QuizQuestionInput; kind?: "review" | "transfer"; source?: LearnStudySource; origin: "quiz" | "exam"; attempt: LearnReviewAttempt }): Promise<void> {
    const id = createHash("sha256").update(JSON.stringify([input.question, input.source ?? null, input.kind ?? "review"])).digest("hex");
    await this.update((data) => {
      let item = data.items.find((entry) => entry.id === id);
      if (!item) { item = { id, question: input.question, kind: input.kind ?? "review", source: input.source, origin: input.origin, attempts: [], streak: 0, intervalDays: 0 }; data.items.push(item); }
      const existing = item.attempts.find((attempt) => attempt.id === input.attempt.id);
      if (existing) {
        if (JSON.stringify(existing.answer) !== JSON.stringify(input.attempt.answer)) throw new Error("E_LEARN_REVIEW_ATTEMPT_CONFLICT");
        return;
      }
      advanceReview(item, input.attempt);
      rebuildSchedule(item);
    });
  }
  async recordQuiz(quizId: string, questions: QuizQuestionInput[], results: QuizAnswerResult[], metadata: Array<{ kind?: "review" | "transfer"; source?: LearnStudySource }> = []): Promise<void> {
    for (const [index, question] of questions.entries()) {
      const result = results.find((answer) => answer.questionId === `q${index + 1}`);
      if (!result) continue;
      await this.record({ question, ...metadata[index], origin: "quiz", attempt: {
        id: `${quizId}:${result.questionId}`, at: new Date(this.now()).toISOString(), result: result.grading,
        answer: result.userAnswer, feedback: question.explanation, grader: "local",
      } });
    }
  }
  async recordExam(record: LearnExamRecord): Promise<void> {
    if (!record.gradingResult || !record.submittedAnswers || record.reviewWorkspaceRoot !== this.root) return;
    const recorded = new Set((await this.items()).flatMap((item) => item.attempts.map((attempt) => attempt.id)));
    for (const question of record.questions) {
      if (recorded.has(`${record.examId}:${question.id}`)) continue;
      const result = record.gradingResult.questionResults.find((entry) => entry.questionId === question.id);
      if (!result) continue;
      await this.record({ question: examReviewQuestion(question), kind: question.kind, source: question.sourceRef, origin: "exam", attempt: {
        id: `${record.examId}:${question.id}`, at: new Date(record.updatedAt).toISOString(),
        result: result.awardedPoints === question.points ? "correct" : "incorrect",
        answer: record.submittedAnswers[question.id]?.value ?? "", feedback: result.feedback, grader: "model",
      } });
    }
  }
  async sourceStatus(item: LearnReviewItem): Promise<"current" | "stale" | "unverified"> {
    if (!item.source) return "unverified";
    try { await this.validateSource(item.source); return "current"; } catch { return "stale"; }
  }
  async overview(): Promise<LearnStudyOverview> {
    const items = await this.items();
    const reviews = await Promise.all(items.map(async (item) => ({
      id: item.id, question: item.question.question, type: item.question.type, learningObjective: item.question.learningObjective,
      options: buildPopQuizPublication([item.question], { quizId: "review", runId: "review" }).card.questions[0].options,
      kind: item.kind, source: item.source, sourceStatus: await this.sourceStatus(item), origin: item.origin,
      attemptCount: item.attempts.length, lastResult: item.attempts.at(-1)!.result, nextReviewAt: item.nextReviewAt,
    })));
    reviews.sort((a, b) => (a.nextReviewAt ?? "").localeCompare(b.nextReviewAt ?? ""));
    const topics = new Map<string, { objective: string; incorrect: number; assessed: number }>();
    for (const item of items) {
      const result = item.attempts.at(-1)?.result;
      if (result === "pending_model") continue;
      const topic = topics.get(item.question.learningObjective) ?? { objective: item.question.learningObjective, incorrect: 0, assessed: 0 };
      topic.assessed++; if (result === "incorrect") topic.incorrect++;
      topics.set(topic.objective, topic);
    }
    const progress = await loadProgress(this.vault);
    return { workspaceId: studyWorkspaceId(this.root), reviews, dueCount: reviews.filter((item) => item.sourceStatus !== "stale" && item.nextReviewAt && Date.parse(item.nextReviewAt) <= this.now()).length,
      pendingCount: reviews.filter((item) => item.lastResult === "pending_model").length,
      weakTopics: [...topics.values()].filter((topic) => topic.incorrect > 0).sort((a, b) => b.incorrect - a.incorrect),
      estimatedTopics: Object.entries(progress.topics).map(([topic, value]) => ({ topic, mastery: value.mastery })) };
  }
  async answer(itemId: string, attemptId: string, answer: PopQuizAnswerSubmission): Promise<{ result: LearnReviewAttempt["result"]; explanation: string }> {
    if (!/^[0-9a-f-]{36}$/i.test(attemptId)) throw new Error("E_LEARN_REVIEW_ATTEMPT");
    const item = (await this.items()).find((entry) => entry.id === itemId);
    if (!item) throw new Error("E_LEARN_REVIEW_NOT_FOUND");
    if (await this.sourceStatus(item) === "stale") throw new Error("材料已变化，请在 Learn 中重新核对并出题");
    const publication = buildPopQuizPublication([item.question], { quizId: itemId, runId: "review" });
    const graded = gradeQuizSubmission(publication, { quizId: itemId, answers: [{ ...answer, questionId: "q1" }] });
    if (!graded.results) throw new Error(graded.error);
    const result = graded.results[0];
    const prior = item.attempts.find((attempt) => attempt.id === attemptId);
    if (prior) {
      if (JSON.stringify(prior.answer) !== JSON.stringify(result.userAnswer)) throw new Error("E_LEARN_REVIEW_ATTEMPT_CONFLICT");
      return { result: prior.result, explanation: prior.result === "pending_model" ? "已保存，待 Learn 讲评" : prior.feedback };
    }
    await this.record({ question: item.question, kind: item.kind, source: item.source, origin: item.origin, attempt: {
      id: attemptId, at: new Date(this.now()).toISOString(), answer: result.userAnswer,
      result: result.grading, feedback: item.question.explanation, grader: "local",
    } });
    return { result: result.grading, explanation: result.grading === "pending_model" ? "已保存，待 Learn 讲评" : item.question.explanation };
  }
  async gradePending(itemId: string, attemptId: string, correct: boolean, feedback: string): Promise<void> {
    const item = (await this.items()).find((entry) => entry.id === itemId);
    if (!item || await this.sourceStatus(item) === "stale") throw new Error("E_LEARN_REVIEW_NOT_FOUND_OR_STALE");
    await this.update((data) => {
      const current = data.items.find((entry) => entry.id === itemId)!;
      const last = current.attempts.at(-1);
      if (!last || last.id !== attemptId || last.result !== "pending_model") throw new Error("E_LEARN_REVIEW_PENDING_CONFLICT");
      current.attempts.pop();
      advanceReview(current, { ...last, at: new Date(this.now()).toISOString(), result: correct ? "correct" : "incorrect", feedback, grader: "model" });
    });
  }
}
export function examReviewQuestion(question: LearnExamQuestionRecord): QuizQuestionInput {
  const base = { question: question.prompt, learningObjective: question.learningObjective, explanation: question.explanation };
  switch (question.type) {
    case "single_choice": return { ...base, type: "choice", options: question.options.map((option) => option.label), correctIndex: question.options.findIndex((option) => option.id === question.correctOptionId) };
    case "multiple_choice": return { ...base, type: "multi", options: question.options.map((option) => option.label), correctIndexes: question.correctOptionIds.map((id) => question.options.findIndex((option) => option.id === id)) };
    case "true_false": return { ...base, type: "true_false", correct: question.correct };
    case "fill_blank": return { ...base, type: "short_answer", referenceAnswer: question.blanks.map((blank) => blank.referenceAnswer).join("；"), rubric: question.blanks.flatMap((blank) => blank.rubric) };
    default: return { ...base, type: "short_answer", referenceAnswer: question.referenceAnswer, rubric: question.rubric };
  }
}
