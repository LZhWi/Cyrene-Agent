import { describe, expect, it } from "vitest";
import {
  buildFallbackAskClarification,
  detectRecentAddressedUser,
  normalizeAskClarificationOutput,
  resolveAskClarification,
} from "./ask-soul";
import type { AskClarificationInput } from "../../shared/ask-clarification";
import type { ChatRequest, ChatResponse } from "./vendors/types";

const input: AskClarificationInput = {
  userRequest: "生成一份文档",
  trustedUserProfile: {
    callPreference: "伙伴",
    gender: "male",
  },
  missingFields: [
    {
      field: "topic",
      reason: "文档主题未知",
      required: true,
      questionHint: "这份文档主要写什么？",
      typeHint: "text",
      allowCustom: false,
    },
    {
      field: "format",
      reason: "输出格式未知",
      required: true,
      questionHint: "希望生成哪种格式？",
      typeHint: "single_select",
      allowedOptions: [
        { value: "word", label: "Word 文档" },
        { value: "markdown", label: "Markdown 文档" },
        { value: "pdf", label: "PDF 文档" },
        { value: "excel", label: "Excel 表格" },
      ],
      allowCustom: true,
    },
  ],
};

describe("Ask Soul clarification contract", () => {
  it("keeps authoritative fields, caps model choices at three, and leaves custom insertion to Runtime", () => {
    const result = normalizeAskClarificationOutput({
      intro: "伙伴，想把这份文档做得更合你心意，我还需要确认两件小事呀。",
      questions: [
        {
          field: "topic",
          question: "这份文档主要写什么？",
          type: "text",
          options: [
            { value: "项目说明", label: "项目说明" },
            { value: "学习总结", label: "学习总结" },
          ],
          allowCustom: false,
          freeTextPlaceholder: "例如：项目说明",
        },
        {
          field: "format",
          question: "希望生成哪种格式？",
          type: "single_select",
          options: [
            { value: "word", label: "Word 文档" },
            { value: "markdown", label: "Markdown 文档" },
            { value: "pdf", label: "PDF 文档" },
            { value: "__custom__", label: "其他，我自己填写" },
          ],
          allowCustom: true,
          freeTextPlaceholder: "填写其他格式",
        },
      ],
      deferredFields: [],
    }, input);

    expect(result.questions).toHaveLength(2);
    expect(result.questions[0]).toMatchObject({
      options: [
        { value: "项目说明", label: "项目说明" },
        { value: "学习总结", label: "学习总结" },
      ],
      allowCustom: true,
    });
    expect(result.questions[1].options).toEqual([
      { value: "word", label: "Word 文档" },
      { value: "markdown", label: "Markdown 文档" },
      { value: "pdf", label: "PDF 文档" },
    ]);
  });

  it("rejects an Ask Soul result that has fewer than two suggestions", () => {
    expect(() => normalizeAskClarificationOutput({
      intro: "还需要确认一下。",
      questions: [{
        field: "topic",
        question: "这份文档主要写什么？",
        type: "text",
        options: [{ value: "项目说明", label: "项目说明" }],
        allowCustom: true,
        freeTextPlaceholder: "填写其他主题",
      }],
      deferredFields: ["format"],
    }, input)).toThrow("question.options requires at least two choices");
  });

  it("repairs one insufficient option result before accepting the card", async () => {
    let calls = 0;
    const result = await resolveAskClarification({
      model: "m",
      askSystemContent: "ASK_SYSTEM",
      input,
    }, async (): Promise<ChatResponse> => {
      calls += 1;
      const options = calls === 1
        ? [{ value: "项目说明", label: "项目说明" }]
        : [
            { value: "项目说明", label: "项目说明" },
            { value: "学习总结", label: "学习总结" },
          ];
      return {
        assistantMessage: { role: "assistant", content: "{}" },
        text: JSON.stringify({
          intro: "还需要确认一下。",
          questions: [{
            field: "topic",
            question: "这份文档主要写什么？",
            type: "text",
            options,
            allowCustom: true,
            freeTextPlaceholder: "填写其他主题",
          }],
          deferredFields: ["format"],
        }),
        toolCalls: [],
        finishReason: "stop",
        raw: {},
      };
    });

    expect(calls).toBe(2);
    expect(result.questions[0].options).toHaveLength(2);
  });

  it("does not treat a transport failure as a structured-output repair", async () => {
    let calls = 0;
    const result = await resolveAskClarification({
      model: "m",
      askSystemContent: "ASK_SYSTEM",
      input,
    }, async () => {
      calls += 1;
      throw new Error("network unavailable");
    });

    expect(calls).toBe(1);
    expect(result.questions.map((question) => question.field)).toEqual(["topic", "format"]);
  });

  it("builds a usable local fallback without inventing choices", () => {
    const result = buildFallbackAskClarification(input);

    expect(result.intro).toContain("伙伴");
    expect(result.questions).toEqual([
      expect.objectContaining({ field: "topic", type: "text", options: [] }),
      expect.objectContaining({
        field: "format",
        type: "single_select",
        options: [
          { value: "word", label: "Word 文档" },
          { value: "markdown", label: "Markdown 文档" },
          { value: "pdf", label: "PDF 文档" },
        ],
      }),
    ]);
  });

  it("uses the dedicated Ask prompt and returns validated structured card copy", async () => {
    const invoke = async (request: ChatRequest): Promise<ChatResponse> => {
      expect(request.messages[0]?.content).toBe("ASK_SYSTEM\n\nASK_PERSONA\n\nASK_QUOTES");
      expect(request.messages[1]?.content).toContain('"trustedUserProfile"');
      return {
        assistantMessage: { role: "assistant", content: "{}" },
        text: JSON.stringify({
          intro: "伙伴，想把这份文档做得更合你心意，我还需要确认两件小事呀。",
          questions: [
            {
              field: "topic",
              question: "这份文档主要写什么？",
              type: "text",
              options: [],
              allowCustom: false,
              freeTextPlaceholder: "例如：项目说明",
            },
            {
              field: "format",
              question: "希望生成哪种格式？",
              type: "single_select",
              options: [
                { value: "word", label: "Word 文档" },
                { value: "markdown", label: "Markdown 文档" },
              ],
              allowCustom: true,
              freeTextPlaceholder: "填写其他格式",
            },
          ],
          deferredFields: [],
        }),
        toolCalls: [],
        finishReason: "stop",
        raw: {},
      };
    };

    const result = await resolveAskClarification({
      model: "m",
      askSystemContent: "ASK_SYSTEM\n\nASK_PERSONA\n\nASK_QUOTES",
      input,
    }, invoke);

    expect(result.questions.map((question) => question.field)).toEqual(["topic", "format"]);
  });

  it("detects a recently used preferred address so Ask Soul does not repeat it", () => {
    expect(detectRecentAddressedUser([
      { role: "user", content: "生成一份文档" },
      { role: "assistant", content: "伙伴，我在听呢。" },
    ], { callPreference: "伙伴", nickname: "小王", gender: "male" })).toBe(true);
  });
});
