/**
 * Renderer Feature Flags
 *
 * 集中管理渲染器的功能开关。
 * 这些标志控制新旧实现的切换。
 *
 * 使用方式:
 * ```ts
 * import { rendererFeatureFlags } from './feature-flags';
 *
 * if (rendererFeatureFlags.useReactChatWindow) {
 *   // 使用 React 实现
 * } else {
 *   // 使用旧实现
 * }
 * ```
 */

export const rendererFeatureFlags = {
  /**
   * 是否使用 React Chat 窗口
   *
   * - true: 使用新的 React 实现
   * - false: 使用旧的原生 DOM 实现
   *
   * 切换方式:
   * 1. 直接修改此值
   * 2. 通过环境变量: VITE_USE_REACT_CHAT=true
   */
  useReactChatWindow: import.meta.env.VITE_USE_REACT_CHAT === 'true' || false,

  /**
   * 是否使用 Ant Design X 组件
   *
   * - true: 使用 Ant Design X 的 Bubble、Sender 等组件
   * - false: 使用自定义组件
   */
  useAntDesignX: import.meta.env.VITE_USE_ANT_DESIGN_X === 'true' || false,
} as const;

/**
 * 检查是否使用 React Chat 窗口
 */
export function shouldUseReactChat(): boolean {
  return rendererFeatureFlags.useReactChatWindow;
}

/**
 * 检查是否使用 Ant Design X
 */
export function shouldUseAntDesignX(): boolean {
  return rendererFeatureFlags.useAntDesignX;
}
