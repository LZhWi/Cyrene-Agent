import type { LearnExamAnswerValue, LearnExamQuestionView } from "../shared/learn-exam";

export function isExamQuestionAnswered(question: LearnExamQuestionView, answer?: LearnExamAnswerValue): boolean {
  if (!answer) return false;
  if (question.type === "true_false") return typeof answer.value === "boolean";
  if (question.type === "fill_blank") return Array.isArray(answer.value)
    && answer.value.length === question.blankCount && answer.value.every((value) => value.trim().length > 0);
  if (question.type === "multiple_choice") return Array.isArray(answer.value) && answer.value.length > 0;
  return typeof answer.value === "string" && answer.value.trim().length > 0;
}
