import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import type { LearnExamRecord } from "../../shared/learn-exam";
import type { IpcScope } from "../application/ipc-scope";

const mocks = vi.hoisted(() => ({
  controller: {
    ready: vi.fn(async () => undefined),
    getState: vi.fn(() => ({})),
    setBounds: vi.fn(), navigate: vi.fn(), goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), stop: vi.fn(),
    newTab: vi.fn(), openInNewTab: vi.fn(), openExam: vi.fn(async () => true), activateTab: vi.fn(), closeTab: vi.fn(),
    startElementPicker: vi.fn(), cancelElementPicker: vi.fn(), clearCookies: vi.fn(async () => undefined),
    setOpenPanelForControl: vi.fn(),
  },
  setController: vi.fn(),
  registerTools: vi.fn(),
}));

vi.mock("./browser-panel-controller", () => ({ BrowserPanelController: class { constructor() { return mocks.controller as any; } } }));
vi.mock("./browser-panel-runtime", () => ({ setBrowserPanelController: mocks.setController }));
vi.mock("./browser-page-tools", () => ({ registerBrowserPageTools: mocks.registerTools }));

import { registerBrowserPanelIpc } from "./browser-panel-ipc";

const examId = "exam-123e4567-e89b-12d3-a456-426614174000";
const conversationId = "conversation-a";
const record = { examId, conversationId } as LearnExamRecord;

describe("BrowserPanel exam open IPC", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.controller.openExam.mockResolvedValue(true);
  });

  it("rejects a non-main-window sender before reading the exam", async () => {
    const { handlers, getExamRecord } = register();
    const result = await handlers[IPC.BROWSER_PANEL_OPEN_EXAM]({ sender: { id: 2 } }, { examId, conversationId });
    expect(result).toBe(false);
    expect(getExamRecord).not.toHaveBeenCalled();
    expect(mocks.controller.openExam).not.toHaveBeenCalled();
  });

  it("opens only a valid exam owned by the requested conversation", async () => {
    const { handlers, getExamRecord, mainContents } = register();
    const result = await handlers[IPC.BROWSER_PANEL_OPEN_EXAM]({ sender: mainContents }, { examId, conversationId });
    expect(result).toBe(true);
    expect(getExamRecord).toHaveBeenCalledWith(examId);
    expect(mocks.controller.openExam).toHaveBeenCalledWith(examId, conversationId);
  });

  it("rejects an exam from another conversation and malformed identifiers", async () => {
    const { handlers, getExamRecord, mainContents } = register(async () => ({ ...record, conversationId: "conversation-b" } as LearnExamRecord));
    expect(await handlers[IPC.BROWSER_PANEL_OPEN_EXAM]({ sender: mainContents }, { examId, conversationId })).toBe(false);
    expect(mocks.controller.openExam).not.toHaveBeenCalled();
    expect(await handlers[IPC.BROWSER_PANEL_OPEN_EXAM]({ sender: mainContents }, { examId: "file:///secret", conversationId })).toBe(false);
    expect(getExamRecord).toHaveBeenCalledTimes(1);
  });
});

function register(getRecord: () => Promise<LearnExamRecord> = async () => record) {
  const mainContents = { id: 1, send: vi.fn(), isDestroyed: () => false };
  const win = { webContents: mainContents, isDestroyed: () => false };
  const handlers: Record<string, (...args: any[]) => any> = {};
  const ipc = { handle: (channel: string, handler: (...args: any[]) => any) => { handlers[channel] = handler; } } as IpcScope;
  const getExamRecord = vi.fn(getRecord);
  registerBrowserPanelIpc({ ipc, getWindow: () => win as any, getExamRecord });
  return { handlers, getExamRecord, mainContents };
}
