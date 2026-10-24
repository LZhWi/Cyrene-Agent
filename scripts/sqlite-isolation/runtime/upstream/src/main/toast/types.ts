// 注意力 Toast 中心：主进程侧契约。
// 类型定义放在 src/shared/toast-types.ts（preload 与 toast 渲染页也要引用，
// 它们不能 import 主进程目录）；此处 re-export 并补充主进程私有的运行时常量。

export type { ToastTier, ToastKind, ToastTarget, ToastItem, ToastPushPayload } from "../../shared/toast-types";
export { TOAST_MAX_VISIBLE } from "../../shared/toast-types";

/** 通知档自动消隐时长（主进程定时器） */
export const TOAST_NOTIFY_TIMEOUT_MS = 10_000;

/** toast 窗口固定宽度（px） */
export const TOAST_WINDOW_WIDTH = 440;

/** 窗口高度上限：所在显示器工作区高度的 60%（防止大块透明区遮挡鼠标） */
export const TOAST_MAX_WORKAREA_RATIO = 0.6;

/** 音效合并窗口：短时间内多条 toast 进队只播一次，取档位最高的音效 */
export const TOAST_SOUND_MERGE_MS = 300;
