// @vitest-environment jsdom
import React, { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./InteractionPanel", () => ({
  AskUserPanel: () => { const [value, setValue] = useState(""); return createElement("input", { value, onChange: (event: { target: { value: string } }) => setValue(event.target.value) }); },
  PermissionPanel: () => createElement("span", null, "permission"), PopQuizPanel: () => null,
}));
import { ComposerSlot } from "./ComposerSlot";
import { PendingQueueDock } from "./PendingQueueDock";

const roots: ReturnType<typeof createRoot>[] = [];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.React = React;
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.replaceChildren(); });
async function mount(component: ReturnType<typeof createElement>) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); roots.push(root); await act(async () => root.render(component));
  return { container, root };
}

describe("workspace controls", () => {
  it("preserves an unanswered card when collapsed and expands a newly arriving card", async () => {
    const answer = vi.fn();
    const props = { collapsible: true, composer: createElement("textarea"), onAnswer: answer,
      interaction: { id: "first", kind: "permission" as const, toolName: "fixture", summary: "fixture" } };
    const { container, root } = await mount(createElement(ComposerSlot, props));
    await act(async () => (container.querySelector("button") as HTMLButtonElement).click());
    expect(container.querySelector(".cy-composer-slot__card")?.hasAttribute("hidden")).toBe(true);
    expect(container.querySelector(".cy-composer-slot__composer")?.hasAttribute("inert")).toBe(false);
    expect(answer).not.toHaveBeenCalled();
    await act(async () => root.render(createElement(ComposerSlot, { ...props, interaction: { ...props.interaction, id: "second" } })));
    expect(container.querySelector(".cy-composer-slot__card")?.hasAttribute("hidden")).toBe(false);
  });
  it("leaves a queue editor open when the message was already consumed", async () => {
    const edit = vi.fn(() => false);
    const { container } = await mount(createElement(PendingQueueDock, { items: [{ id: "q", content: "draft", attachmentNames: ["image.png"] }], onEdit: edit }));
    const editButton = container.querySelector('button[aria-label="workspaceUi.editQueuedMessage"]') as HTMLButtonElement;
    await act(async () => editButton.click());
    const confirm = [...container.querySelectorAll("button")].find((button) => button.textContent === "common.confirm")!;
    await act(async () => confirm.click());
    expect(edit).toHaveBeenCalledWith("q", "draft");
    expect(container.querySelector("textarea")).not.toBeNull();
    await act(async () => (container.querySelector(".cy-pending-queue__heading") as HTMLButtonElement).click());
    expect(container.querySelector(".cy-pending-queue__item")).toBeNull();
  });
});
