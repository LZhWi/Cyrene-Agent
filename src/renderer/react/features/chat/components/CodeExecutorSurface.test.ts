// @vitest-environment jsdom
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeExecutorSurface, useCodeExecutorRoute } from "./CodeExecutorSurface";
import type { CodeExecutorAction, CodeExecutorResult, CodeExecutorSnapshot } from "../../../../../shared/code-executor";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.React = React;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.replaceChildren(); vi.restoreAllMocks(); });
function NativeComposer({ onSend }: { onSend(): void }) { return createElement("div", null, useCodeExecutorRoute(), createElement("button", { id: "native-send", onClick: onSend }, "原生发送")); }
async function mount(enabled: boolean, handler?: (id: string, action: CodeExecutorAction, data?: unknown) => Promise<CodeExecutorResult>) {
  const nativeSend = vi.fn();
  const invoke = vi.fn(handler ?? (async (_id: string, _action: CodeExecutorAction, _data?: unknown): Promise<CodeExecutorResult> => ({ ok: false, error: "插件未启用" })));
  Object.assign(window, { codeExecutor: { invoke } });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); roots.push(root);
  await act(async () => root.render(createElement(CodeExecutorSurface, { enabled, sessionId: "code-a", workspace: "E:\\test", nativeBusy: false, onChooseWorkspace: vi.fn(), children: createElement(NativeComposer, { onSend: nativeSend }) })));
  return { container, invoke, nativeSend };
}
async function chooseRoute(container: HTMLElement, label: string) {
  await act(async () => (container.querySelector('[aria-label="Code 执行器"]') as HTMLButtonElement).click());
  await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>('.cy-permission-panel__option')).find(button => button.textContent === label)!.click());
}
describe("Code execution route selection", () => {
  it("sends exact text and selected configuration only to Codex, then permits native sending", async () => {
    const state: CodeExecutorSnapshot = {
      config: { cwd: "E:\\test", model: "test", effort: "low", skillPath: "", sandbox: "read-only", autoExplain: false },
      connection: "disconnected", connectionError: "", tasks: [], prompts: [], skills: [],
      models: [{ model: "test", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }],
    };
    const t = await mount(true, async (_id, action, data) => {
      if (action === "connect") state.connection = "connected";
      if (action === "submit") {
        state.connection = "idle";
        state.tasks = [{ id: "task-1", message: (data as any).message, status: "completed", finalText: "real-shaped receipt", progress: "", diff: "", config: state.config }];
      }
      return { ok: true, data: structuredClone(state) };
    });
    await chooseRoute(t.container, "Codex");
    await act(async () => Array.from(t.container.querySelectorAll("button")).find(button => button.textContent === "连接 / 刷新目录")!.click());
    const raw = "  原文\n不经过主模型  ";
    const textarea = t.container.querySelector("textarea")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, raw); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => Array.from(t.container.querySelectorAll("button")).find(button => button.textContent === "发送给 Codex")!.click());
    expect(t.invoke).toHaveBeenCalledWith("code-a", "submit", { message: raw, model: "test", effort: "low", skillPath: "", sandbox: "read-only", autoExplain: false, newThread: false });
    expect(t.nativeSend).not.toHaveBeenCalled();
    expect(t.container.textContent).toContain("real-shaped receipt");
    expect(t.container.textContent).toContain("会话已释放");
    await chooseRoute(t.container, "原生");
    await act(async () => (t.container.querySelector("#native-send") as HTMLButtonElement).click());
    expect(t.nativeSend).toHaveBeenCalledTimes(1);
  });
  it("leaves Chat/Work/Learn DOM and sending untouched and makes no executor calls", async () => {
    const t = await mount(false);
    expect(t.container.children).toHaveLength(1); expect(t.container.querySelector("select")).toBeNull();
    await act(async () => (t.container.querySelector("button") as HTMLButtonElement).click());
    expect(t.nativeSend).toHaveBeenCalledTimes(1); expect(t.invoke).not.toHaveBeenCalled();
  });
  it("defaults to native and can return from an unavailable Codex route without sending", async () => {
    const t = await mount(true);
    expect(t.container.querySelector("#native-send")).not.toBeNull();
    await chooseRoute(t.container, "Codex");
    expect(t.container.querySelector("#native-send")).toBeNull();
    expect(t.container.textContent).toContain("插件未启用");
    expect(t.nativeSend).not.toHaveBeenCalled();
    expect(t.invoke.mock.calls.every(call => call[1] === "state")).toBe(true);
    await chooseRoute(t.container, "原生");
    await act(async () => (t.container.querySelector("#native-send") as HTMLButtonElement).click());
    expect(t.nativeSend).toHaveBeenCalledTimes(1);
  });
});
