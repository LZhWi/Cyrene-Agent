/**
 * Chat React Root
 *
 * React Chat 窗口的根组件。
 * 负责初始化 React 应用并挂载到 DOM。
 *
 * 使用方式:
 * ```ts
 * import { initChatReactRoot } from './app/ChatReactRoot';
 *
 * initChatReactRoot(document.getElementById('react-root')!);
 * ```
 */

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CyreneThemeProvider } from '../theme/CyreneThemeProvider';
import { ChatPage } from '../features/chat/ChatPage';
import { AppProviders } from './providers';

// ===== 根节点初始化 =====

let root: Root | null = null;

/**
 * 初始化 React Chat 根节点
 *
 * @param container - 挂载容器
 * @param options - 初始化选项
 */
export function initChatReactRoot(
  container: HTMLElement,
  options?: {
    /** 主题模式 */
    themeMode?: 'dark' | 'light';
    /** 是否严格模式 */
    strictMode?: boolean;
  }
) {
  const { themeMode = 'dark', strictMode = true } = options ?? {};

  // 创建根节点
  root = createRoot(container);

  // 渲染应用
  const app = (
    <AppProviders themeMode={themeMode} strictMode={strictMode}>
      <ChatPage />
    </AppProviders>
  );

  root.render(app);

  return {
    /** 卸载应用 */
    unmount: () => {
      root?.unmount();
      root = null;
    },
    /** 获取根节点 */
    getRoot: () => root,
  };
}

/**
 * 卸载 React Chat 根节点
 */
export function unmountChatReactRoot() {
  root?.unmount();
  root = null;
}
