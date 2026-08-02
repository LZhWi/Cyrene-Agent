import { describe, expect, it } from "vitest";
import {
  describeRunStage,
  normalizeChoiceInteraction,
  normalizeTaskPlanPresentation,
  resolveComposerSlot,
  type ComposerInteraction,
} from "./run-presentation";

describe("work run presentation", () => {
  it("replaces the composer only while an ask or permission interaction is pending", () => {
    const ask: ComposerInteraction = {
      kind: "ask",
      id: "ask-1",
      question: "你想先处理哪一项？",
      options: [{ id: "one", label: "第一项" }],
    };
    const permission: ComposerInteraction = {
      kind: "permission",
      id: "approve-1",
      toolName: "write_word",
      summary: "在工作区创建报告",
    };

    expect(resolveComposerSlot(undefined)).toBe("composer");
    expect(resolveComposerSlot(ask)).toBe("ask");
    expect(resolveComposerSlot(permission)).toBe("permission");
  });

  it("keeps internal routing out of the user-facing stage copy", () => {
    expect(describeRunStage({ kind: "understanding" })).toBe("昔涟正在理解需求…");
    expect(describeRunStage({ kind: "planning" })).toBe("昔涟正在规划任务…");
    expect(describeRunStage({ kind: "executing", detail: "查询淄博天气" }))
      .toBe("昔涟正在执行：查询淄博天气…");
    expect(describeRunStage({ kind: "waiting_permission" })).toBe("昔涟正在获取审批…");
    expect(describeRunStage({ kind: "waiting_user" })).toBe("昔涟正在询问…");
    expect(describeRunStage({ kind: "responding" })).toBe("昔涟正在组织回复…");
  });

  it("normalizes both legacy choices and structured clarification into the same composer slot", () => {
    expect(normalizeChoiceInteraction({
      id: "choice-1",
      question: "要生成哪一种报告？",
      options: [{ value: "daily", label: "日报", description: "汇总今天的信息" }],
    })).toMatchObject({
      kind: "ask",
      id: "choice-1",
      responseKind: "choice",
      options: [{ id: "daily", label: "日报" }],
    });

    expect(normalizeChoiceInteraction({
      id: "choice-2",
      intro: "还需要确认两个细节。",
      questions: [{
        field: "format",
        question: "想要什么格式？",
        type: "single_select",
        allowCustom: false,
        freeTextPlaceholder: "",
        options: [{ value: "docx", label: "Word" }],
      }],
    })).toMatchObject({
      kind: "ask",
      id: "choice-2",
      responseKind: "clarification",
      questions: [{ field: "format", options: [{ id: "docx", label: "Word" }] }],
    });
  });

  it("keeps one plan card updated from task-plan snapshots", () => {
    expect(normalizeTaskPlanPresentation({
      goal: "整理今日信息",
      steps: [
        { stepId: "s1", objective: "搜索新闻", status: "completed" },
        { stepId: "s2", objective: "生成报告", status: "running" },
        { stepId: "s3", objective: "清理旧文件", status: "superseded" },
      ],
    })).toEqual({
      title: "整理今日信息",
      steps: [
        { id: "s1", title: "搜索新闻", status: "completed" },
        { id: "s2", title: "生成报告", status: "running" },
        { id: "s3", title: "清理旧文件", status: "pending" },
      ],
    });
  });
});
