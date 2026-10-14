import { describe, expect, it } from "vitest";
import { isExamQuestionAnswered } from "./learn-exam-progress";
import type { LearnExamQuestionView } from "../shared/learn-exam";

describe("exam progress", () => {
  it("counts false as an answered judgement and requires every blank", () => {
    const question = { id: "q", type: "true_false" } as LearnExamQuestionView;
    expect(isExamQuestionAnswered(question, { value: false })).toBe(true);
    expect(isExamQuestionAnswered(question)).toBe(false);
    const blanks = { id: "b", type: "fill_blank", blankCount: 2 } as LearnExamQuestionView;
    expect(isExamQuestionAnswered(blanks, { value: ["first", " "] })).toBe(false);
    expect(isExamQuestionAnswered(blanks, { value: ["first", "second"] })).toBe(true);
    expect(isExamQuestionAnswered({ ...question, type: "short_answer" }, { value: "   " })).toBe(false);
  });
});
