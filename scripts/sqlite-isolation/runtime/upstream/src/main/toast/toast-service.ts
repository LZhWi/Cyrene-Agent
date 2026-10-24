// 注意力 Toast 中心：生命周期唯一权威。
// activeToasts（当前显示）与 pendingSeen（已提醒去重记忆）是两个独立结构：
// 可见状态回答"屏幕上显示什么"，去重记忆回答"哪些业务已提醒过"。
// 等待操作档手动关闭/点击后视觉消失但保留去重记忆（10s 重播不重弹），
// 结算信号到达才清记忆，此后同一业务重新 pending 可正常再弹。

import { IPC } from "../../shared/ipc-channels";
import type { ToastItem, ToastPushPayload } from "../../shared/toast-types";
import type { IpcScope } from "../application/ipc-scope";
import type { WindowActivationRequest } from "../application/window-activation";
import type { ToastWindowController } from "./toast-window";
import type { SchedulerFinishedEvent, ToastEventBus } from "./toast-events";
import { TOAST_NOTIFY_TIMEOUT_MS, TOAST_SOUND_MERGE_MS, type ToastTier } from "./types";

export interface ToastServiceDeps {
  bus: ToastEventBus;
  window: ToastWindowController;
  /** 窗口激活代理（点击 toast 后激活聊天窗口/切会话） */
  activate(request: WindowActivationRequest): void;
  /** 打开任务窗口（task-finished 点击跳转目标） */
  openTasksWindow(): void;
  /** toast id 生成器；默认递增计数，可注入以便测试 */
  newId?: () => string;
  /** 时钟注入；默认 Date.now，测试可替换 */
  now?: () => number;
  /** 音效总开关查询（设置页）；默认开 */
  isSoundEnabled?: () => boolean;
  /**
   * 通知档焦点抑制查询：事件到达时判断"用户正看着现场"
   * （聊天窗口存在且聚焦，且当前激活会话 === 事件所属会话）。
   * 仅通知档使用；等待操作档不受抑制（长输出流里卡片易被滚没）。
   */
  shouldSuppressNotify?: (event: SchedulerFinishedEvent) => boolean;
}

/** 去重键：类别 + 业务身份 */
function dedupeKey(kind: ToastItem["kind"], sourceId: string): string {
  return `${kind}:${sourceId}`;
}

export function createToastService(deps: ToastServiceDeps) {
  const newId = deps.newId ?? (() => `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const nowFn = deps.now ?? (() => Date.now());
  const soundEnabled = deps.isSoundEnabled ?? (() => true);
  const shouldSuppressNotify = deps.shouldSuppressNotify ?? (() => false);

  /** 当前显示中的 toast（可见状态） */
  const activeToasts = new Map<string, ToastItem>();
  /** 已提醒过的等待操作档业务事件（去重记忆；通知档不进此集合） */
  const pendingSeen = new Set<string>();
  /** 已登记为计划流的 runId：同 runId 的 choice 卡归 plan-review，不进 ask-choice 路径 */
  const planRunIds = new Set<string>();
  /** 通知档 10s 自动消隐定时器（主进程为权威） */
  const notifyTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  // ── 音效合并：300ms 窗口内只播一次，等待操作档可顶替轻提示 ──

  let lastSoundAt = -Infinity;
  let lastSoundTier: ToastTier | null = null;

  function decideSound(tier: ToastTier): boolean {
    if (!soundEnabled()) return false;
    const now = nowFn();
    if (now - lastSoundAt > TOAST_SOUND_MERGE_MS) {
      lastSoundAt = now;
      lastSoundTier = tier;
      return true;
    }
    // 合并窗口内到达：重要提醒（等待操作档）优先，可顶替刚播过的轻提示
    if (tier === "action-pending" && lastSoundTier === "notify") {
      lastSoundAt = now;
      lastSoundTier = tier;
      return true;
    }
    return false;
  }

  // ── 推送与移除（渲染页只被动响应） ─────────────────────

  function pushToast(item: ToastItem): void {
    activeToasts.set(item.id, item);
    const payload: ToastPushPayload = { ...item, sound: decideSound(item.tier) };
    deps.window.send(IPC.TOAST_PUSH, payload);
    deps.window.syncVisibility(true);
  }

  function removeToast(id: string): void {
    // 通知档提前结束（点击/关闭）时清掉自动消隐定时器
    const timer = notifyTimeouts.get(id);
    if (timer) {
      clearTimeout(timer);
      notifyTimeouts.delete(id);
    }
    if (!activeToasts.delete(id)) return;
    deps.window.send(IPC.TOAST_REMOVE, id);
    deps.window.syncVisibility(activeToasts.size > 0);
  }

  /** 按"类别 + 业务身份"找当前可见的 toast（结算清退用） */
  function findActiveBySource(kind: ToastItem["kind"], sourceId: string): ToastItem | undefined {
    for (const item of activeToasts.values()) {
      if (item.kind === kind && item.sourceId === sourceId) return item;
    }
    return undefined;
  }

  /** 等待操作档业务首次 pending：进去重记忆并弹出 */
  function popActionToast(item: ToastItem): void {
    const key = dedupeKey(item.kind, item.sourceId);
    if (pendingSeen.has(key)) return; // 10s 重播/补充卡命中去重：不重弹
    pendingSeen.add(key);
    pushToast(item);
  }

  /** 结算：清去重记忆并移除仍可见的 toast */
  function settleActionToast(kind: ToastItem["kind"], sourceId: string): void {
    pendingSeen.delete(dedupeKey(kind, sourceId));
    const active = findActiveBySource(kind, sourceId);
    if (active) removeToast(active.id);
  }

  // ── 四类等待操作档事件 ─────────────────────────────────

  function handleApprovalPending(event: { id: string; toolId: string; toolName: string }): void {
    popActionToast({
      id: newId(),
      kind: "approval",
      tier: "action-pending",
      sourceId: event.id,
      title: "昔涟在等你的批准",
      summary: event.toolName,
      // 审批事件在主进程侧拿不到所属会话，只能激活聊天窗口
      target: { type: "window", window: "chat" },
      createdAt: nowFn(),
    });
  }

  function handleApprovalSettled(event: { id: string }): void {
    settleActionToast("approval", event.id);
  }

  function handleChoiceCard(event: { cardId: string; intro: string; runId?: string; revision: number }): void {
    // 分类互斥：计划流的 choice 卡（审批卡/补充卡）已由 plan-review 弹过并进了去重记忆
    if (event.runId && planRunIds.has(event.runId)) return;
    popActionToast({
      id: newId(),
      kind: "ask-choice",
      tier: "action-pending",
      sourceId: event.cardId,
      title: "昔涟想问你一个问题",
      summary: event.intro,
      target: { type: "window", window: "chat" },
      createdAt: nowFn(),
    });
  }

  function handleChoiceDismiss(event: { cardId: string; runId?: string; revision: number; reason: string }): void {
    if (event.runId && planRunIds.has(event.runId)) {
      handlePlanCardDismiss(event);
      return;
    }
    // 普通 ASK 卡：结算即终局（answered / timeout / cancelled / unavailable）
    settleActionToast("ask-choice", event.cardId);
  }

  /**
   * 计划流 choice 卡结算：
   * - 第一段卡（revision 1）answered/timeout 后可能紧跟补充卡（revision 2），
   *   只移除可见 toast、保留去重记忆，补充卡不重复弹；
   * - revision 2 结算或任意 revision 取消（run 中止）→ 计划卡流程结束，全量清理。
   */
  function handlePlanCardDismiss(event: { runId?: string; revision: number; reason: string }): void {
    const runId = event.runId;
    if (!runId) return;
    const flowEnded = event.revision >= 2 || event.reason === "cancelled";
    if (flowEnded) {
      settleActionToast("plan-review", runId);
      planRunIds.delete(runId);
    } else {
      const active = findActiveBySource("plan-review", runId);
      if (active) removeToast(active.id);
    }
  }

  function handlePlanReview(event: { sessionId: string; runId: string }): void {
    planRunIds.add(event.runId);
    popActionToast({
      id: newId(),
      kind: "plan-review",
      tier: "action-pending",
      sourceId: event.runId,
      title: "计划已写好，等你批准",
      // 计划审批卡事件自带 sessionId，点击后可直接切到该会话
      target: { type: "session", sessionId: event.sessionId },
      createdAt: nowFn(),
    });
  }

  function handlePlanApproved(event: { runId: string }): void {
    settleActionToast("plan-review", event.runId);
    planRunIds.delete(event.runId);
  }

  /**
   * 计划流终止但未走批准（拉回讨论态且不再出补充卡，或流程异常）：
   * 全量清理。幂等——与 revision 2 结算 / cancelled 等既有清理路径重合时无副作用。
   */
  function handlePlanReviewEnded(event: { runId: string }): void {
    settleActionToast("plan-review", event.runId);
    planRunIds.delete(event.runId);
  }

  function handleQuizPending(event: { quizId: string; runId: string; firstQuestion: string }): void {
    popActionToast({
      id: newId(),
      kind: "pop-quiz",
      tier: "action-pending",
      sourceId: event.quizId,
      title: "昔涟出了道抽查题",
      summary: event.firstQuestion,
      target: { type: "window", window: "chat" },
      createdAt: nowFn(),
    });
  }

  function handleQuizSettled(event: { quizId: string }): void {
    settleActionToast("pop-quiz", event.quizId);
  }

  // ── 通知档：定时任务完成 ─────────────────────────────────

  function handleSchedulerFinished(event: SchedulerFinishedEvent): void {
    // V1 边界：只有成功完成才提醒，失败不弹
    if (event.status !== "success") return;
    // 焦点抑制：用户正看着现场时跳过，不打扰
    if (shouldSuppressNotify(event)) return;
    const item: ToastItem = {
      id: newId(),
      kind: "task-finished",
      tier: "notify",
      sourceId: event.schedulerRunId,
      title: `「${event.taskTitle}」跑完了`,
      summary: event.outputPreview,
      // 任务结果落在任务历史而非聊天流，V1 点击降级为打开任务窗口
      target: { type: "window", window: "tasks" },
      createdAt: nowFn(),
    };
    pushToast(item);
    // 通知档 10s 自动消隐：主进程定时器为唯一权威；
    // 提前结束（点击/手动关闭）时 removeToast 会清掉定时器
    const timer = setTimeout(() => {
      notifyTimeouts.delete(item.id);
      removeToast(item.id);
    }, TOAST_NOTIFY_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
    notifyTimeouts.set(item.id, timer);
  }

  // ── 用户交互（渲染页只上报 id，跳转由这里查权威状态解析） ──

  function handleClicked(id: string): void {
    const item = activeToasts.get(id);
    if (!item) return;
    switch (item.target.type) {
      case "session":
        deps.activate({ kind: "chat", sessionId: item.target.sessionId });
        break;
      case "window":
        if (item.target.window === "tasks") {
          deps.openTasksWindow();
        } else {
          deps.activate({ kind: "chat" });
        }
        break;
    }
    // 点击即视觉消隐；等待操作档的去重记忆保留到业务结算
    removeToast(id);
  }

  function handleDismissed(id: string): void {
    // 手动关闭：视觉消失，去重记忆保留（等待操作档），结算信号负责最终清退
    removeToast(id);
  }

  // ── 订阅与 IPC 注册 ─────────────────────────────────────

  const unsubscribers: Array<() => void> = [
    deps.bus.onApprovalPending(handleApprovalPending),
    deps.bus.onApprovalSettled(handleApprovalSettled),
    deps.bus.onChoiceCard(handleChoiceCard),
    deps.bus.onChoiceDismiss(handleChoiceDismiss),
    deps.bus.onPlanReview(handlePlanReview),
    deps.bus.onPlanApproved(handlePlanApproved),
    deps.bus.onPlanReviewEnded(handlePlanReviewEnded),
    deps.bus.onQuizPending(handleQuizPending),
    deps.bus.onQuizSettled(handleQuizSettled),
    deps.bus.onSchedulerFinished(handleSchedulerFinished),
  ];

  function registerIpc(ipc: IpcScope): void {
    ipc.handle(IPC.TOAST_GET_ALL, () => [...activeToasts.values()]);
    ipc.on(IPC.TOAST_CLICKED, (event, id: unknown) => {
      // sender 校验：只有 toast 窗口的上报才被接受，其他来源直接忽略
      if (!deps.window.owns(event.sender)) return;
      if (typeof id === "string") handleClicked(id);
    });
    ipc.on(IPC.TOAST_DISMISSED, (event, id: unknown) => {
      if (!deps.window.owns(event.sender)) return;
      if (typeof id === "string") handleDismissed(id);
    });
    ipc.on(IPC.TOAST_RESIZE, (event, height: unknown) => {
      if (!deps.window.owns(event.sender)) return;
      if (typeof height === "number") deps.window.updateHeight(height);
    });
  }

  return {
    registerIpc,
    /** 当前可见列表（测试与状态查询） */
    getActiveToasts(): ToastItem[] {
      return [...activeToasts.values()];
    },
    /** 去重记忆是否包含某业务（测试用） */
    hasPendingSeen(kind: ToastItem["kind"], sourceId: string): boolean {
      return pendingSeen.has(dedupeKey(kind, sourceId));
    },
    dispose(): void {
      for (const unsubscribe of unsubscribers) unsubscribe();
      unsubscribers.length = 0;
    },
  };
}

export type ToastService = ReturnType<typeof createToastService>;
