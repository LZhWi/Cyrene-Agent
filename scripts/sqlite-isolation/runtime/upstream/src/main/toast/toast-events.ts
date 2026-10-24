// 注意力事件总线：主进程内的轻量 pub/sub，把"有事在等用户"的事件
// 从事件源（permission / user-choice / agui-bridge / pop-quiz / scheduler）
// 送到 ToastService，避免 toast 模块反向 import 事件源造成耦合。
//
// 事件源只 import 本模块并 publish；ToastService 通过 deps 注入的 bus 实例订阅。
// 载荷在发布侧就地归一化（抽取卡片 id、摘要文本），总线不依赖任何卡片类型联合。

/** 权限审批：请求已创建，等待用户批准 */
export interface ApprovalPendingEvent {
  id: string;
  toolId: string;
  toolName: string;
  runId?: string;
}

/** 权限审批：已结算（answered / cancelled / unavailable） */
export interface ApprovalSettledEvent {
  id: string;
  runId?: string;
  reason: string;
}

/** 选择卡（ASK 工具 / 计划审批卡 / 计划补充卡）已发布 */
export interface ChoiceCardEvent {
  /** 卡片唯一标识：AskCardPayload.interactionId 或 LegacyChoiceCardData.id */
  cardId: string;
  /** 单行摘要：AskCardPayload.intro 或 LegacyChoiceCardData.question */
  intro: string;
  runId?: string;
  revision: number;
}

/** 选择卡已结算（answered / timeout / unavailable / cancelled） */
export interface ChoiceDismissEvent {
  cardId: string;
  runId?: string;
  revision: number;
  reason: string;
}

/** 计划写好，进入 PLAN_REVIEW（总是先于同 runId 的选择卡发布） */
export interface PlanReviewEvent {
  sessionId: string;
  runId: string;
}

/** 计划已批准，进入 EXECUTING */
export interface PlanApprovedEvent {
  sessionId: string;
  runId: string;
}

/** 计划流终止但未走批准路径（拉回讨论态且不再出补充卡，或流程异常） */
export interface PlanReviewEndedEvent {
  sessionId: string;
  runId: string;
}

/** 抽查出题：卡片已发布，等待用户作答 */
export interface QuizPendingEvent {
  quizId: string;
  runId: string;
  firstQuestion: string;
}

/** 抽查已结算（submitted / skipped / cancelled） */
export interface QuizSettledEvent {
  quizId: string;
  runId: string;
  reason: string;
}

/** 定时任务 run 到达终态（通知档，C4 接入） */
export interface SchedulerFinishedEvent {
  schedulerRunId: string;
  taskId: string;
  taskTitle: string;
  status: string;
  outputPreview?: string;
  /** 事件所属会话：焦点抑制判定用；调度执行没有桌面会话，当前恒缺省 */
  sessionId?: string;
}

interface Topic<T> {
  subscribe(listener: (event: T) => void): () => void;
  publish(event: T): void;
}

/** 单主题发布：快照遍历（回调中退订不影响本轮顺序）、幂等退订、顺序执行 + 错误隔离 */
function createTopic<T>(name: string): Topic<T> {
  const listeners = new Set<(event: T) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(event) {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (err) {
          console.warn(`[ToastEvents] ${name} 监听器执行失败:`, err);
        }
      }
    },
  };
}

export interface ToastEventBus {
  onApprovalPending(listener: (event: ApprovalPendingEvent) => void): () => void;
  publishApprovalPending(event: ApprovalPendingEvent): void;
  onApprovalSettled(listener: (event: ApprovalSettledEvent) => void): () => void;
  publishApprovalSettled(event: ApprovalSettledEvent): void;
  onChoiceCard(listener: (event: ChoiceCardEvent) => void): () => void;
  publishChoiceCard(event: ChoiceCardEvent): void;
  onChoiceDismiss(listener: (event: ChoiceDismissEvent) => void): () => void;
  publishChoiceDismiss(event: ChoiceDismissEvent): void;
  onPlanReview(listener: (event: PlanReviewEvent) => void): () => void;
  publishPlanReview(event: PlanReviewEvent): void;
  onPlanApproved(listener: (event: PlanApprovedEvent) => void): () => void;
  publishPlanApproved(event: PlanApprovedEvent): void;
  onPlanReviewEnded(listener: (event: PlanReviewEndedEvent) => void): () => void;
  publishPlanReviewEnded(event: PlanReviewEndedEvent): void;
  onQuizPending(listener: (event: QuizPendingEvent) => void): () => void;
  publishQuizPending(event: QuizPendingEvent): void;
  onQuizSettled(listener: (event: QuizSettledEvent) => void): () => void;
  publishQuizSettled(event: QuizSettledEvent): void;
  onSchedulerFinished(listener: (event: SchedulerFinishedEvent) => void): () => void;
  publishSchedulerFinished(event: SchedulerFinishedEvent): void;
}

export function createToastEventBus(): ToastEventBus {
  const approvalPending = createTopic<ApprovalPendingEvent>("approval-pending");
  const approvalSettled = createTopic<ApprovalSettledEvent>("approval-settled");
  const choiceCard = createTopic<ChoiceCardEvent>("choice-card");
  const choiceDismiss = createTopic<ChoiceDismissEvent>("choice-dismiss");
  const planReview = createTopic<PlanReviewEvent>("plan-review");
  const planApproved = createTopic<PlanApprovedEvent>("plan-approved");
  const planReviewEnded = createTopic<PlanReviewEndedEvent>("plan-review-ended");
  const quizPending = createTopic<QuizPendingEvent>("quiz-pending");
  const quizSettled = createTopic<QuizSettledEvent>("quiz-settled");
  const schedulerFinished = createTopic<SchedulerFinishedEvent>("scheduler-finished");

  return {
    onApprovalPending: approvalPending.subscribe,
    publishApprovalPending: approvalPending.publish,
    onApprovalSettled: approvalSettled.subscribe,
    publishApprovalSettled: approvalSettled.publish,
    onChoiceCard: choiceCard.subscribe,
    publishChoiceCard: choiceCard.publish,
    onChoiceDismiss: choiceDismiss.subscribe,
    publishChoiceDismiss: choiceDismiss.publish,
    onPlanReview: planReview.subscribe,
    publishPlanReview: planReview.publish,
    onPlanApproved: planApproved.subscribe,
    publishPlanApproved: planApproved.publish,
    onPlanReviewEnded: planReviewEnded.subscribe,
    publishPlanReviewEnded: planReviewEnded.publish,
    onQuizPending: quizPending.subscribe,
    publishQuizPending: quizPending.publish,
    onQuizSettled: quizSettled.subscribe,
    publishQuizSettled: quizSettled.publish,
    onSchedulerFinished: schedulerFinished.subscribe,
    publishSchedulerFinished: schedulerFinished.publish,
  };
}

/**
 * 全局单例：事件源模块 import 它做 publish（permission / user-choice /
 * agui-bridge / pop-quiz / scheduler-runner），组合根把同一个实例注入 ToastService。
 */
export const toastEvents: ToastEventBus = createToastEventBus();
