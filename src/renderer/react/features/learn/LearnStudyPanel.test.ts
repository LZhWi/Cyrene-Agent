// @vitest-environment jsdom
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearnStudyPanel } from "./LearnStudyPanel";
import type { LearnStudyOverview } from "../../../../shared/learn-study";
globalThis.IS_REACT_ACT_ENVIRONMENT = true; globalThis.React = React;
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.replaceChildren(); delete (window as any).learnStudy; });
const overview: LearnStudyOverview = { workspaceId: "vault-a", dueCount: 1, pendingCount: 0, weakTopics: [{ objective: "加法", incorrect: 1, assessed: 1 }], estimatedTopics: [{ topic: "加法", mastery: 80 }],
  reviews: [{ id: "item", question: "1+1？", type: "choice", learningObjective: "加法", options: [{ id: "q1-opt-1", label: "2" }, { id: "q1-opt-2", label: "3" }], kind: "review", origin: "quiz", sourceStatus: "unverified", lastResult: "incorrect", attemptCount: 1, nextReviewAt: "2026-01-01T00:00:00Z" }] };
async function mount(id = "A") {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container); roots.push(root);
  await act(async () => root.render(createElement(LearnStudyPanel, { key: id, conversationId: id, busy: false })));
  return { root, container };
}
function button(container: HTMLElement, label: string) { return [...container.querySelectorAll("button")].find((value) => value.textContent === label)!; }
describe("Learn panel", () => {
  it("explains missing workspace binding without showing IPC implementation details", async () => {
    (window as any).learnStudy = { overview: vi.fn(async () => { throw new Error("E_LEARN_STUDY_FORBIDDEN"); }), videos: vi.fn(async () => []) };
    const { container } = await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("请先为当前 Learn 会话绑定学习目录。");
    expect(container.textContent).not.toContain("FORBIDDEN");
  });
  it("shows estimates separately and submits an actual answer without exposing answer keys", async () => {
    const answer = vi.fn(async () => ({ result: "correct", explanation: "两个一组成二" }));
    (window as any).learnStudy = { overview: vi.fn(async () => overview), videos: vi.fn(async () => []), answer };
    const { container } = await mount();
    expect(container.textContent).toContain("对话估计（粗略参考）"); expect(container.textContent).not.toContain("两个一组成二");
    await act(async () => button(container, "复习这道题").click());
    await act(async () => (container.querySelector('input[type="radio"]') as HTMLInputElement).click());
    await act(async () => button(container, "提交复习作答").click());
    expect(answer).toHaveBeenCalledWith("A", "vault-a", "item", expect.any(String), { questionId: "q1", optionId: "q1-opt-1" });
    expect(container.textContent).toContain("答对：两个一组成二");
  });
  it("does not show a delayed A response after mounting B", async () => {
    let finish!: (value: LearnStudyOverview) => void;
    (window as any).learnStudy = { overview: vi.fn((id) => id === "A" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ ...overview, reviews: [], estimatedTopics: [], weakTopics: [] })), videos: vi.fn(async () => []) };
    const { root, container } = await mount();
    await act(async () => root.render(createElement(LearnStudyPanel, { key: "B", conversationId: "B", busy: false })));
    await act(async () => finish(overview)); expect(container.textContent).not.toContain("加法");
  });
  it("renders subtitles as text and seeks the player to the chosen note", async () => {
    (window as any).learnStudy = { overview: vi.fn(async () => ({ ...overview, reviews: [] })), videos: vi.fn(async () => [{ id: "v", file: "course.mp4", url: "cyrene-learn://video/test", entries: [{ id: "e", seconds: 62, text: "<script>alert(1)</script>", kind: "subtitle" }] }]) };
    const { container } = await mount(); expect(container.querySelector("script")).toBeNull(); expect(container.textContent).toContain("<script>alert(1)</script>");
    await act(async () => button(container, "00:01:02 · 字幕").click()); expect(container.querySelector("video")?.currentTime).toBe(62);
  });
  it("clears the old review form when the same conversation binds another Vault", async () => {
    let changed!: (id: string) => void;
    let data = overview;
    (window as any).learnStudy = { overview: vi.fn(async () => data), videos: vi.fn(async () => []), onWorkspaceChanged: (callback: (id: string) => void) => { changed = callback; return () => {}; } };
    const { container } = await mount();
    await act(async () => button(container, "复习这道题").click()); expect(container.querySelector("fieldset")).not.toBeNull();
    data = { ...overview, workspaceId: "vault-b", reviews: [], estimatedTopics: [], weakTopics: [] };
    await act(async () => changed("A")); expect(container.querySelector("fieldset")).toBeNull(); expect(container.textContent).not.toContain("加法");
  });
});
