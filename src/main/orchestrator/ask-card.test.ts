import { describe, expect, it } from "vitest";
import {
  buildAskCard,
  publishAskCard,
  resolveAskCardSubmission,
  validateAskUserAnswer,
} from "./ask-card";

describe("buildAskCard", () => {
  it("keeps at most three model options and leaves custom input outside the option list", () => {
    const card = buildAskCard({
      intro: "伙伴，还需要你选一下呀。",
      questions: [{
        field: "format",
        question: "希望生成哪种格式？",
        type: "single_select",
        options: [
          { value: "word", label: "Word 文档" },
          { value: "markdown", label: "Markdown 文档" },
          { value: "pdf", label: "PDF 文档" },
          { value: "excel", label: "Excel 表格" },
        ],
        allowCustom: true,
        freeTextPlaceholder: "填写其他格式",
      }],
      deferredFields: [],
    });

    expect(card.questions[0].options).toEqual([
      { value: "word", label: "Word 文档" },
      { value: "markdown", label: "Markdown 文档" },
      { value: "pdf", label: "PDF 文档" },
    ]);
    expect(card.questions[0].allowCustom).toBe(true);
  });

  it("rejects a question with fewer than two usable suggestions", () => {
    expect(() => buildAskCard({
      intro: "还需要确认一下。",
      questions: [{
        field: "topic",
        question: "这份文档主要写什么？",
        type: "text",
        options: [{ value: "项目说明", label: "项目说明" }],
        allowCustom: false,
        freeTextPlaceholder: "填写其他主题",
      }],
      deferredFields: [],
    })).toThrow("E_ASK_OPTIONS_INSUFFICIENT");
  });

  it("rejects answer values that were not presented by Runtime", () => {
    const card = buildAskCard({
      intro: "伙伴，还需要你选一下呀。",
      questions: [{
        field: "format",
        question: "希望生成哪种格式？",
        type: "single_select",
        options: [
          { value: "word", label: "Word 文档" },
          { value: "pdf", label: "PDF 文档" },
        ],
        allowCustom: true,
        freeTextPlaceholder: "填写其他格式",
      }],
      deferredFields: [],
    });

    expect(() => validateAskUserAnswer(card, "choice-1", {
      requestId: "forged",
      answers: [{ field: "format", selectedValues: ["shell"] }],
    })).toThrow("E_ASK_ANSWER_INVALID");
  });

  it("publishes opaque option ids without exposing canonical values", () => {
    const card = buildAskCard({
      intro: "还需要确认两个细节。",
      questions: [{
        field: "format",
        question: "希望生成哪种格式？",
        type: "single_select",
        options: [
          { value: "docx", label: "Word" },
          { value: "pdf", label: "PDF" },
        ],
        allowCustom: false,
        freeTextPlaceholder: "填写其他格式",
      }],
      deferredFields: [],
    });

    const publication = publishAskCard(card, {
      interactionId: "choice-1",
      runId: "run-1",
      revision: 1,
    });

    expect(publication.payload).toEqual({
      interactionId: "choice-1",
      runId: "run-1",
      revision: 1,
      mode: "semantic_clarification",
      intro: "还需要确认两个细节。",
      questions: [{
        id: "question-1",
        prompt: "希望生成哪种格式？",
        multiple: false,
        required: true,
        options: [
          { id: "question-1-option-1", label: "Word" },
          { id: "question-1-option-2", label: "PDF" },
        ],
        customInput: { enabled: true, placeholder: "填写其他格式" },
      }],
    });
    expect(JSON.stringify(publication.payload)).not.toContain("docx");
  });

  it("publishes an action-parameter card without exposing its pending action", () => {
    const card = buildAskCard({
      intro: "还需要确认一下。",
      questions: [{
        field: "format",
        question: "希望生成哪种格式？",
        type: "single_select",
        options: [
          { value: "docx", label: "Word" },
          { value: "pdf", label: "PDF" },
        ],
        allowCustom: true,
        freeTextPlaceholder: "填写其他格式",
      }],
      deferredFields: [],
    }, "action_parameters");
    const publication = publishAskCard(card, {
      interactionId: "choice-2",
      runId: "run-2",
      revision: 1,
    });

    expect(publication.payload.mode).toBe("action_parameters");
    expect(JSON.stringify(publication.payload)).not.toContain("write_document");
    expect(JSON.stringify(publication.payload)).not.toContain("argumentPath");
    expect(JSON.stringify(publication.payload)).not.toContain("docx");
  });

  it("maps an optionId back to its private canonical value", () => {
    const publication = publishAskCard(buildAskCard({
      intro: "还需要确认一下。",
      questions: [{
        field: "format",
        question: "希望生成哪种格式？",
        type: "single_select",
        options: [
          { value: "docx", label: "Word" },
          { value: "pdf", label: "PDF" },
        ],
        allowCustom: true,
        freeTextPlaceholder: "填写其他格式",
      }],
      deferredFields: [],
    }), { interactionId: "choice-1", runId: "run-1", revision: 1 });

    expect(resolveAskCardSubmission(publication, {
      interactionId: "choice-1",
      runId: "run-1",
      revision: 1,
      answers: [{ questionId: "question-1", source: "option", optionId: "question-1-option-2" }],
    })).toEqual({
      requestId: "choice-1",
      answers: [{ field: "format", selectedValues: ["pdf"] }],
    });
  });

  it("rejects forged option ids and accepts custom text as the exclusive answer", () => {
    const publication = publishAskCard(buildAskCard({
      intro: "还需要确认一下。",
      questions: [{
        field: "format",
        question: "希望生成哪种格式？",
        type: "single_select",
        options: [
          { value: "docx", label: "Word" },
          { value: "pdf", label: "PDF" },
        ],
        allowCustom: false,
        freeTextPlaceholder: "填写其他格式",
      }],
      deferredFields: [],
    }), { interactionId: "choice-1", runId: "run-1", revision: 1 });

    expect(() => resolveAskCardSubmission(publication, {
      interactionId: "choice-1",
      runId: "run-1",
      revision: 1,
      answers: [{ questionId: "question-1", source: "option", optionId: "forged" }],
    })).toThrow("E_ASK_ANSWER_INVALID");

    expect(resolveAskCardSubmission(publication, {
      interactionId: "choice-1",
      runId: "run-1",
      revision: 1,
      answers: [{ questionId: "question-1", source: "custom", text: "  HTML  " }],
    })).toEqual({
      requestId: "choice-1",
      answers: [{ field: "format", customText: "HTML" }],
    });
  });
});
