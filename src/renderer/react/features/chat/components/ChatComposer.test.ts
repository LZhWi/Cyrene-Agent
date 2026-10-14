import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

let senderProps: Record<string, unknown> | undefined;

vi.mock("@ant-design/x", () => ({
  Sender: (props: Record<string, unknown>) => {
    senderProps = props;
    return null;
  },
}));

vi.mock("antd", () => ({
  Popover: ({ children }: { children?: unknown }) => children ?? null,
  Segmented: () => null,
}));

vi.mock("./ReasoningControl", () => ({ ReasoningControl: () => null }));
vi.mock("./StyleControl", () => ({ StyleControl: () => null }));
vi.mock("./PermissionControl", () => ({ PermissionControl: () => null }));
vi.mock("../../../../../shared/renderer-base", () => ({ resolveAsset: (path: string) => path }));

import { ChatComposer, parseComposerMessage } from "./ChatComposer";

describe("ChatComposer cancellation", () => {
  beforeEach(() => {
    senderProps = undefined;
  });

  it("forwards cancellation to the Sender stop button", () => {
    const onCancel = vi.fn();
    vi.stubGlobal("React", React);

    renderToStaticMarkup(createElement(ChatComposer, {
      value: "",
      mode: "chat",
      docked: true,
      attachments: [],
      modelBusy: true,
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      onCancel,
      onChooseWorkspace: vi.fn(),
      onChooseFiles: vi.fn(),
      onRemoveAttachment: vi.fn(),
      onScreenshot: vi.fn(),
      onChooseSticker: vi.fn(),
    }));

    expect(senderProps?.onCancel).toBe(onCancel);
  });

  it("does not disable an active Work run when its workspace label is not loaded", () => {
    vi.stubGlobal("React", React);

    renderToStaticMarkup(createElement(ChatComposer, {
      value: "",
      mode: "work",
      docked: true,
      attachments: [],
      modelBusy: true,
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      onCancel: vi.fn(),
      onChooseWorkspace: vi.fn(),
      onChooseFiles: vi.fn(),
      onRemoveAttachment: vi.fn(),
      onScreenshot: vi.fn(),
      onChooseSticker: vi.fn(),
    }));

    expect(senderProps?.disabled).toBe(false);
  });

  it("shows model failure details without hiding the composer", () => {
    const html = renderToStaticMarkup(createElement(ChatComposer, {
      value: "", mode: "chat", docked: true, attachments: [],
      onChange: vi.fn(), onSubmit: vi.fn(), onChooseWorkspace: vi.fn(),
      onChooseFiles: vi.fn(), onRemoveAttachment: vi.fn(), onScreenshot: vi.fn(),
      onChooseSticker: vi.fn(),
      mainModelFailure: { provider: "glm", model: "glm-4.1v", category: "RATE_LIMIT", status: 429, vendorCode: "1302" },
    }));

    expect(html).toContain("cy-model-error-item");
    expect(html).toContain("HTTP 429");
    expect(html).toContain("1302");
    expect(html).toContain("cy-composer-shell");
  });

});

describe("ChatComposer Code sticker policy", () => {
  const baseProps = {
    value: "",
    docked: true,
    workspaceName: "project",
    attachments: [],
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    onChooseWorkspace: vi.fn(),
    onChooseFiles: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onScreenshot: vi.fn(),
    onChooseSticker: vi.fn(),
  };

  it("hides the sticker picker in Code mode but keeps it in Work mode", () => {
    renderToStaticMarkup(createElement(ChatComposer, { ...baseProps, mode: "code" }));
    const codeHtml = renderToStaticMarkup(senderProps?.prefix as React.ReactElement);
    renderToStaticMarkup(createElement(ChatComposer, { ...baseProps, mode: "work" }));
    const workHtml = renderToStaticMarkup(senderProps?.prefix as React.ReactElement);

    expect(codeHtml).not.toContain('aria-label="表情包"');
    expect(workHtml).toContain('aria-label="表情包"');
  });

  it.each(["chat", "work", "code", "learn"])("gates document paste and attachment icons in %s", (mode) => {
    const choose = vi.fn();
    renderToStaticMarkup(createElement(ChatComposer, { ...baseProps, mode, onChooseFiles: choose,
      attachments: [{ name: "report.txt", kind: "document" }] }));
    const file = { name: "report.txt", type: "text/plain" };
    const event = { clipboardData: { types: ["Files"], files: [file], items: [] }, preventDefault: vi.fn() };
    (senderProps!.onPaste as (event: unknown) => void)(event);
    expect(choose).toHaveBeenCalledTimes(mode === "chat" ? 0 : 1);
    const header = renderToStaticMarkup(senderProps!.header as React.ReactElement);
    expect(header.includes("cy-composer__attachment-icon")).toBe(mode !== "chat");
  });

  it("strips sticker markers without turning them into a Code message sticker", () => {
    expect(parseComposerMessage("code", "检查一下 [sticker:playful]")).toEqual({
      rawContent: "检查一下",
      visibleContent: "检查一下",
      userSticker: undefined,
    });
    expect(parseComposerMessage("work", "检查一下 [sticker:playful]")).toEqual({
      rawContent: "检查一下 [sticker:playful]",
      visibleContent: "检查一下",
      userSticker: "playful",
    });
  });

  it("keeps the plan mode toggle in the Code composer footer", () => {
    const html = renderToStaticMarkup(createElement(ChatComposer, {
      ...baseProps,
      mode: "code",
      conversationId: "session-1",
    }));

    expect(html).toContain("计划模式 · off");
    expect(html).toContain("cy-plan-control");
  });
});
