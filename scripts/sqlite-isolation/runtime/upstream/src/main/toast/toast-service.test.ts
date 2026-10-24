// ToastService 状态机单测：去重分离、结算清退、plan/ask 分类互斥、点击跳转、
// sender 校验、通知档超时/焦点抑制与音效合并。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createToastEventBus } from "./toast-events";
import { createToastService, type ToastServiceDeps } from "./toast-service";
import { TOAST_NOTIFY_TIMEOUT_MS, TOAST_SOUND_MERGE_MS } from "./types";
import type { ToastWindowController } from "./toast-window";
import type { IpcScope } from "../application/ipc-scope";
import type { ToastItem } from "../../shared/toast-types";

/** toast 窗口控制器桩：记录推送/移除/显隐，owns 只认 senderId 42 */
function createWindowStub() {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const visibilityLog: boolean[] = [];
  let height = 0;
  const controller = {
    send: (channel: string, payload: unknown) => {
      sent.push({ channel, payload });
    },
    syncVisibility: (hasToasts: boolean) => {
      visibilityLog.push(hasToasts);
    },
    updateHeight: (value: number) => {
      height = value;
    },
    owns: (webContents: { id: number }) => webContents.id === 42,
    isVisible: () => false,
    preload: () => {},
    dispose: () => {},
  } as unknown as ToastWindowController;
  return { controller, sent, visibilityLog, getHeight: () => height };
}

/** IpcScope 桩：记录注册的 handler/on 监听器，便于用伪造事件触发 */
function createIpcStub() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const ipc: IpcScope = {
    handle: (channel, listener) => handlers.set(channel, listener),
    removeHandler: () => {},
    on: (channel, listener) => {
      const list = listeners.get(channel) ?? [];
      list.push(listener);
      listeners.set(channel, list);
    },
    dispose: () => {},
  };
  return {
    ipc,
    invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)?.(...args),
    emit: (channel: string, senderId: number, payload: unknown) => {
      for (const listener of listeners.get(channel) ?? []) {
        listener({ sender: { id: senderId } }, payload);
      }
    },
  };
}

function setup(overrides: Partial<ToastServiceDeps> = {}) {
  const bus = createToastEventBus();
  const windowStub = createWindowStub();
  const activate = vi.fn();
  const openTasksWindow = vi.fn();
  let counter = 0;
  const service = createToastService({
    bus,
    window: windowStub.controller,
    activate,
    openTasksWindow,
    newId: () => `toast-${++counter}`,
    ...overrides,
  });
  const ipcStub = createIpcStub();
  service.registerIpc(ipcStub.ipc);
  return { bus, service, windowStub, ipcStub, activate, openTasksWindow };
}

function pushedItems(sent: Array<{ channel: string; payload: unknown }>): ToastItem[] {
  return sent
    .filter((entry) => entry.channel === "toast:push")
    .map((entry) => entry.payload as ToastItem);
}

describe("createToastService · 等待操作档状态机", () => {
  it("审批 pending 弹出 toast，同 id 重播不重弹", () => {
    const { bus, service } = setup();
    bus.publishApprovalPending({ id: "approve-1", toolId: "run_shell", toolName: "运行命令" });
    bus.publishApprovalPending({ id: "approve-1", toolId: "run_shell", toolName: "运行命令" });
    const items = service.getActiveToasts();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "approval", sourceId: "approve-1", tier: "action-pending" });
  });

  it("手动关闭后视觉消失、去重记忆保留，重播仍不重弹", () => {
    const { bus, service, ipcStub } = setup();
    bus.publishApprovalPending({ id: "approve-1", toolId: "t", toolName: "工具" });
    const item = service.getActiveToasts()[0];
    // 用户点关闭：sender 必须是 toast 窗口（id 42）
    ipcStub.emit("toast:dismissed", 42, item.id);
    expect(service.getActiveToasts()).toHaveLength(0);
    expect(service.hasPendingSeen("approval", "approve-1")).toBe(true);
    // 10s 重播到达：去重记忆命中，不重弹
    bus.publishApprovalPending({ id: "approve-1", toolId: "t", toolName: "工具" });
    expect(service.getActiveToasts()).toHaveLength(0);
  });

  it("结算清去重记忆并同步移除仍可见的 toast，此后重新 pending 可再弹", () => {
    const { bus, service, windowStub } = setup();
    bus.publishApprovalPending({ id: "approve-1", toolId: "t", toolName: "工具" });
    // toast 仍可见时结算：必须同步 remove
    bus.publishApprovalSettled({ id: "approve-1", reason: "answered" });
    expect(service.getActiveToasts()).toHaveLength(0);
    expect(service.hasPendingSeen("approval", "approve-1")).toBe(false);
    expect(windowStub.sent.some((e) => e.channel === "toast:remove")).toBe(true);
    // 同一业务重新 pending：正常再弹
    bus.publishApprovalPending({ id: "approve-1", toolId: "t", toolName: "工具" });
    expect(service.getActiveToasts()).toHaveLength(1);
  });

  it("ASK 选择卡：pending 弹出、dismiss 结算清理", () => {
    const { bus, service } = setup();
    bus.publishChoiceCard({ cardId: "choice-1", intro: "要打开哪个文件？", runId: "run-1", revision: 1 });
    expect(service.getActiveToasts()).toHaveLength(1);
    expect(service.getActiveToasts()[0]).toMatchObject({ kind: "ask-choice", sourceId: "choice-1" });
    bus.publishChoiceDismiss({ cardId: "choice-1", runId: "run-1", revision: 1, reason: "answered" });
    expect(service.getActiveToasts()).toHaveLength(0);
    expect(service.hasPendingSeen("ask-choice", "choice-1")).toBe(false);
  });

  it("抽查：pending 弹出、settled 清理", () => {
    const { bus, service } = setup();
    bus.publishQuizPending({ quizId: "quiz-1", runId: "run-1", firstQuestion: "什么是闭包？" });
    expect(service.getActiveToasts()[0]).toMatchObject({ kind: "pop-quiz", sourceId: "quiz-1" });
    bus.publishQuizSettled({ quizId: "quiz-1", runId: "run-1", reason: "submitted" });
    expect(service.getActiveToasts()).toHaveLength(0);
    expect(service.hasPendingSeen("pop-quiz", "quiz-1")).toBe(false);
  });
});

describe("createToastService · plan/ask 分类互斥", () => {
  it("PLAN_REVIEW 流程不得同时生成 plan-review + ask-choice 两张 toast", () => {
    const { bus, service } = setup();
    bus.publishPlanReview({ sessionId: "s1", runId: "run-1" });
    // 同 runId 的审批卡随后到达：归 plan-review，不进 ask-choice
    bus.publishChoiceCard({ cardId: "choice-1", intro: "计划是否批准？", runId: "run-1", revision: 1 });
    const items = service.getActiveToasts();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "plan-review", sourceId: "run-1" });
  });

  it("计划补充卡（revision 2）不重复弹", () => {
    const { bus, service } = setup();
    bus.publishPlanReview({ sessionId: "s1", runId: "run-1" });
    bus.publishChoiceDismiss({ cardId: "choice-1", runId: "run-1", revision: 1, reason: "answered" });
    bus.publishChoiceCard({ cardId: "choice-2", intro: "想补充什么？", runId: "run-1", revision: 2 });
    expect(service.getActiveToasts()).toHaveLength(0);
    expect(service.hasPendingSeen("plan-review", "run-1")).toBe(true);
  });

  it("第一段卡结算只移除可见 toast，revision 2 结算才全量清理", () => {
    const { bus, service } = setup();
    bus.publishPlanReview({ sessionId: "s1", runId: "run-1" });
    bus.publishChoiceDismiss({ cardId: "choice-1", runId: "run-1", revision: 1, reason: "answered" });
    expect(service.getActiveToasts()).toHaveLength(0);
    expect(service.hasPendingSeen("plan-review", "run-1")).toBe(true);
    bus.publishChoiceDismiss({ cardId: "choice-2", runId: "run-1", revision: 2, reason: "timeout" });
    expect(service.hasPendingSeen("plan-review", "run-1")).toBe(false);
    // 清理后同 runId 再 review 可正常再弹
    bus.publishPlanReview({ sessionId: "s1", runId: "run-1" });
    expect(service.getActiveToasts()).toHaveLength(1);
  });

  it("计划批准：清去重记忆与残留 toast", () => {
    const { bus, service } = setup();
    bus.publishPlanReview({ sessionId: "s1", runId: "run-1" });
    bus.publishPlanApproved({ sessionId: "s1", runId: "run-1" });
    expect(service.getActiveToasts()).toHaveLength(0);
    expect(service.hasPendingSeen("plan-review", "run-1")).toBe(false);
  });

  it("run 取消（revision 1 cancelled）直接全量清理", () => {
    const { bus, service } = setup();
    bus.publishPlanReview({ sessionId: "s1", runId: "run-1" });
    bus.publishChoiceDismiss({ cardId: "choice-1", runId: "run-1", revision: 1, reason: "cancelled" });
    expect(service.hasPendingSeen("plan-review", "run-1")).toBe(false);
    expect(service.getActiveToasts()).toHaveLength(0);
  });

  it("revision 1 非批准非补充后计划流终止事件全量清理，不留陈旧条目", () => {
    const { bus, service } = setup();
    bus.publishPlanReview({ sessionId: "s1", runId: "run-1" });
    // revision 1 超时（空答案）：保留记忆等可能的补充卡
    bus.publishChoiceDismiss({ cardId: "choice-1", runId: "run-1", revision: 1, reason: "timeout" });
    expect(service.hasPendingSeen("plan-review", "run-1")).toBe(true);
    // agui-bridge 不再出补充卡，发布计划流终止
    bus.publishPlanReviewEnded({ sessionId: "s1", runId: "run-1" });
    expect(service.hasPendingSeen("plan-review", "run-1")).toBe(false);
    expect(service.getActiveToasts()).toHaveLength(0);
    // 清理后互斥登记一并解除：同 runId 再来的卡走普通 ask-choice 路径
    bus.publishChoiceCard({ cardId: "choice-2", intro: "普通问题", runId: "run-1", revision: 1 });
    expect(service.getActiveToasts()[0]).toMatchObject({ kind: "ask-choice", sourceId: "choice-2" });
  });

  it("计划流终止事件幂等：已由 cancelled 清理后再发无副作用", () => {
    const { bus, service } = setup();
    bus.publishPlanReview({ sessionId: "s1", runId: "run-1" });
    bus.publishChoiceDismiss({ cardId: "choice-1", runId: "run-1", revision: 1, reason: "cancelled" });
    expect(() => bus.publishPlanReviewEnded({ sessionId: "s1", runId: "run-1" })).not.toThrow();
    expect(service.hasPendingSeen("plan-review", "run-1")).toBe(false);
  });
});

describe("createToastService · 点击跳转与 IPC 安全", () => {
  it("点击 plan-review：激活聊天窗口并切到对应会话，toast 消隐但去重记忆保留", () => {
    const { bus, service, ipcStub, activate } = setup();
    bus.publishPlanReview({ sessionId: "s1", runId: "run-1" });
    const item = service.getActiveToasts()[0];
    ipcStub.emit("toast:clicked", 42, item.id);
    expect(activate).toHaveBeenCalledWith({ kind: "chat", sessionId: "s1" });
    expect(service.getActiveToasts()).toHaveLength(0);
    expect(service.hasPendingSeen("plan-review", "run-1")).toBe(true);
  });

  it("点击 approval：激活聊天窗口（无会话落点）", () => {
    const { bus, service, ipcStub, activate } = setup();
    bus.publishApprovalPending({ id: "approve-1", toolId: "t", toolName: "工具" });
    const item = service.getActiveToasts()[0];
    ipcStub.emit("toast:clicked", 42, item.id);
    expect(activate).toHaveBeenCalledWith({ kind: "chat" });
  });

  it("非 toast 窗口的 sender 上报被忽略", () => {
    const { bus, service, ipcStub, activate } = setup();
    bus.publishApprovalPending({ id: "approve-1", toolId: "t", toolName: "工具" });
    const item = service.getActiveToasts()[0];
    ipcStub.emit("toast:clicked", 999, item.id);
    expect(activate).not.toHaveBeenCalled();
    expect(service.getActiveToasts()).toHaveLength(1);
  });

  it("toast:get-all 返回当前可见列表，高度上报转发给窗口控制器", () => {
    const { bus, service, ipcStub, windowStub } = setup();
    bus.publishApprovalPending({ id: "approve-1", toolId: "t", toolName: "工具" });
    const all = ipcStub.invoke("toast:get-all") as ToastItem[];
    expect(all).toHaveLength(1);
    ipcStub.emit("toast:resize", 42, 128);
    expect(windowStub.getHeight()).toBe(128);
  });

  it("推送载荷带 sound 字段（首条默认播提示音）", () => {
    const { bus, windowStub } = setup();
    bus.publishApprovalPending({ id: "approve-1", toolId: "t", toolName: "工具" });
    const items = pushedItems(windowStub.sent) as Array<ToastItem & { sound: boolean }>;
    expect(items[0].sound).toBe(true);
  });
});

describe("createToastService · 通知档（任务完成）", () => {
  const finishedEvent = {
    schedulerRunId: "sched-1",
    taskId: "task-1",
    taskTitle: "每日简报",
    status: "success",
    outputPreview: "简报已生成",
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("任务成功完成弹出通知档 toast，10s 超时后主进程自动消隐", () => {
    const { bus, service, windowStub } = setup();
    bus.publishSchedulerFinished(finishedEvent);
    const item = service.getActiveToasts()[0];
    expect(item).toMatchObject({ kind: "task-finished", tier: "notify", sourceId: "sched-1" });
    // 通知档不进去重记忆：schedulerRunId 每次唯一，进集合会无限增长
    expect(service.hasPendingSeen("task-finished", "sched-1")).toBe(false);
    vi.advanceTimersByTime(TOAST_NOTIFY_TIMEOUT_MS - 1);
    expect(service.getActiveToasts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(service.getActiveToasts()).toHaveLength(0);
    expect(windowStub.sent.some((e) => e.channel === "toast:remove" && e.payload === item.id)).toBe(true);
  });

  it("失败终态不弹提醒", () => {
    const { bus, service } = setup();
    bus.publishSchedulerFinished({ ...finishedEvent, status: "runtime_error" });
    expect(service.getActiveToasts()).toHaveLength(0);
  });

  it("焦点抑制：用户正看着现场时跳过，不弹也不进任何状态", () => {
    const { bus, service } = setup({
      shouldSuppressNotify: () => true,
    });
    bus.publishSchedulerFinished(finishedEvent);
    expect(service.getActiveToasts()).toHaveLength(0);
    expect(service.hasPendingSeen("task-finished", "sched-1")).toBe(false);
  });

  it("点击 task-finished：打开任务窗口并结束生命周期，超时定时器一并清理", () => {
    const { bus, service, ipcStub, openTasksWindow } = setup();
    bus.publishSchedulerFinished(finishedEvent);
    const item = service.getActiveToasts()[0];
    ipcStub.emit("toast:clicked", 42, item.id);
    expect(openTasksWindow).toHaveBeenCalledTimes(1);
    expect(service.getActiveToasts()).toHaveLength(0);
    // 提前结束后定时器不得再把已移除的 toast 复活
    vi.advanceTimersByTime(TOAST_NOTIFY_TIMEOUT_MS * 2);
    expect(service.getActiveToasts()).toHaveLength(0);
  });

  it("手动关闭即终局，与点击等效", () => {
    const { bus, service, ipcStub } = setup();
    bus.publishSchedulerFinished(finishedEvent);
    const item = service.getActiveToasts()[0];
    ipcStub.emit("toast:dismissed", 42, item.id);
    expect(service.getActiveToasts()).toHaveLength(0);
    vi.advanceTimersByTime(TOAST_NOTIFY_TIMEOUT_MS * 2);
    expect(service.getActiveToasts()).toHaveLength(0);
  });
});

describe("createToastService · 音效合并与开关", () => {
  /** 固定时钟：从 t=1000 起，每次调用推进 step 毫秒 */
  function createClock(start = 1000, step = 0) {
    let now = start;
    return () => {
      const current = now;
      now += step;
      return current;
    };
  }

  it("首条播提示音，合并窗口内到达的第二条不播", () => {
    const { bus, windowStub } = setup({ now: createClock() });
    bus.publishApprovalPending({ id: "a-1", toolId: "t", toolName: "工具" });
    bus.publishApprovalPending({ id: "a-2", toolId: "t", toolName: "工具" });
    const items = pushedItems(windowStub.sent) as Array<ToastItem & { sound: boolean }>;
    expect(items).toHaveLength(2);
    expect(items[0].sound).toBe(true);
    expect(items[1].sound).toBe(false);
  });

  it("等待操作档在合并窗口内可顶替刚播过的轻提示", () => {
    let now = 1000;
    const { bus, windowStub } = setup({ now: () => now });
    bus.publishSchedulerFinished({
      schedulerRunId: "s-1",
      taskId: "t1",
      taskTitle: "任务",
      status: "success",
    });
    now = 1000 + TOAST_SOUND_MERGE_MS - 1; // 仍在合并窗口内
    bus.publishApprovalPending({ id: "a-1", toolId: "t", toolName: "工具" });
    const items = pushedItems(windowStub.sent) as Array<ToastItem & { sound: boolean }>;
    expect(items[0].sound).toBe(true); // 通知档先播
    expect(items[1].sound).toBe(true); // 等待操作档顶替，重要提醒优先
  });

  it("轻提示不能顶替刚播过的等待操作档音效", () => {
    let now = 1000;
    const { bus, windowStub } = setup({ now: () => now });
    bus.publishApprovalPending({ id: "a-1", toolId: "t", toolName: "工具" });
    now = 1000 + TOAST_SOUND_MERGE_MS - 1;
    bus.publishSchedulerFinished({
      schedulerRunId: "s-1",
      taskId: "t1",
      taskTitle: "任务",
      status: "success",
    });
    const items = pushedItems(windowStub.sent) as Array<ToastItem & { sound: boolean }>;
    expect(items[0].sound).toBe(true);
    expect(items[1].sound).toBe(false);
  });

  it("音效总开关关闭时不播", () => {
    const { bus, windowStub } = setup({ isSoundEnabled: () => false });
    bus.publishApprovalPending({ id: "a-1", toolId: "t", toolName: "工具" });
    const items = pushedItems(windowStub.sent) as Array<ToastItem & { sound: boolean }>;
    expect(items[0].sound).toBe(false);
  });
});
