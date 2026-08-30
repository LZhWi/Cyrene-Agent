import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./PlanReviewPanel", () => ({
  PlanContent: () => null,
  planTabDotClass: () => "is-review",
  planTabLabel: () => "计划 · 待审批",
}));
vi.mock("./ReviewInspector", () => ({ ReviewDiffContent: () => null }));

import { ChatPageInspector } from "./ChatPageInspector";

describe("ChatPageInspector", () => {
  it("renders nothing when no inspector tab is available", () => {
    const html = renderToStaticMarkup(createElement(ChatPageInspector, {
      reviewInspector: null,
      activePlan: null,
      planDrawerOpen: false,
      activeTabId: "plan",
      onTabChange: () => undefined,
      onCloseTab: () => undefined,
    }));

    expect(html).toBe("");
  });
});
