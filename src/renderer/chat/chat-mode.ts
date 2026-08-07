/**
 * Chat 窗口五模式的纯判定逻辑（与 DOM 解耦，便于单测）。
 *
 * 模式下拉五值：collab/talk 走聊天管线；work/code/learn 走 Work 管线，
 * 显示 #work-view（内嵌 Work 面板）。两条管线互不合并，切换只改显示与
 * 懒挂载，会话/滚动状态各自保留。
 */

/** 走 Work 管线、显示内嵌 Work 面板的三个模式。 */
export const WORK_VIEW_MODES = new Set(["work", "code", "learn"]);

/** 模式下拉持久化键（localStorage）。 */
export const LAST_MODE_STORAGE_KEY = "cyrene:last-mode";

/** 已知五模式之一才认账，防止脏数据把视图切到不存在的模式。 */
export function isKnownMode(value: string | null | undefined): value is string {
  return value === "collab" || value === "talk" || WORK_VIEW_MODES.has(value ?? "");
}

/** 该模式是否显示 Work 视图。 */
export function isWorkViewMode(mode: string): boolean {
  return WORK_VIEW_MODES.has(mode);
}
