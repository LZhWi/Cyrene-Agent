import type { BrowserWindow } from "electron";
import {
  TOAST_MAX_WORKAREA_RATIO,
  TOAST_WINDOW_WIDTH,
} from "./types";

/** 显示器工作区：只取 toast 定位需要的字段，便于测试注入 */
export interface ToastDisplayWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 窗口区域（electron Rectangle 的注入形式） */
export interface ToastBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ToastWindowDeps {
  /** 窗口工厂（由 windows/create-toast-window 提供，toast 模块不直接 new BrowserWindow） */
  createWindow(): BrowserWindow;
  /** 聊天窗口引用：存在时 toast 跟随其所在显示器 */
  getChatWindow(): BrowserWindow | null;
  /** 按窗口区域匹配显示器（electron screen.getDisplayMatching 的注入形式；无交集时内部回退主屏） */
  getDisplayMatching(bounds: ToastBounds): { workArea: ToastDisplayWorkArea };
  /** 鼠标所在位置（electron screen.getCursorScreenPoint 的注入形式） */
  getCursorScreenPoint(): { x: number; y: number };
}

/**
 * toast 窗口控制器：定位（四级回退链）、高度协议、显示/隐藏。
 * 窗口常驻不销毁；队列空整窗 hide，非空时按内容高度贴显示器右下角 showInactive。
 */
export function createToastWindowController(deps: ToastWindowDeps) {
  let window: BrowserWindow | null = null;
  /** 聊天窗口最近一次的区域：窗口销毁后仍用该区域匹配显示器（toast 继续在那块屏幕弹出） */
  let lastChatBounds: ToastBounds | null = null;
  /** 渲染页最近上报的内容高度（高度协议） */
  let contentHeight = 0;

  function ensureWindow(): BrowserWindow {
    if (!window || window.isDestroyed()) {
      window = deps.createWindow();
    }
    return window;
  }

  /**
   * 四级回退链选显示器：
   * 聊天窗口 → 最近记录的聊天窗口区域 → 鼠标所在 → 主屏（getDisplayMatching 内部兜底）。
   * 用户最后一次把 Cyrene 放在哪块屏幕，toast 就应该在那里出来。
   */
  function resolveDisplay(): { workArea: ToastDisplayWorkArea } {
    const chat = deps.getChatWindow();
    if (chat && !chat.isDestroyed()) {
      try {
        const bounds = chat.getBounds();
        if (bounds.width > 0 && bounds.height > 0) {
          lastChatBounds = bounds;
          return deps.getDisplayMatching(bounds);
        }
      } catch {
        // 聊天窗口 bounds 读取失败（销毁竞态）：走下一级
      }
    }
    if (lastChatBounds) {
      return deps.getDisplayMatching(lastChatBounds);
    }
    const cursor = deps.getCursorScreenPoint();
    return deps.getDisplayMatching({ x: cursor.x, y: cursor.y, width: 1, height: 1 });
  }

  /** 高度协议：内容高度 clamp 到工作区 60%，贴右下角向上排布 */
  function applyBounds(): void {
    const win = window;
    if (!win || win.isDestroyed()) return;
    const area = resolveDisplay().workArea;
    const maxHeight = Math.floor(area.height * TOAST_MAX_WORKAREA_RATIO);
    const height = Math.max(1, Math.min(contentHeight, maxHeight));
    const x = area.x + area.width - TOAST_WINDOW_WIDTH;
    const y = area.y + area.height - height;
    try {
      win.setBounds({ x, y, width: TOAST_WINDOW_WIDTH, height });
    } catch {
      // 窗口销毁竞态：忽略，下次显示前会重算
    }
  }

  return {
    /**
     * 渲染页上报内容高度（TOAST_RESIZE）。
     * 高度变化必须立即应用：渲染页首帧测量发生在窗口尚小时，若等下一次
     * syncVisibility 才应用，首条 toast 会以旧高度显示（甚至卡在 1px 死锁）。
     * 隐藏期间同样记账并更新 bounds，显示前无需再补算。
     */
    updateHeight(height: number): void {
      if (!Number.isFinite(height) || height <= 0) return;
      const rounded = Math.round(height);
      if (rounded === contentHeight) return;
      contentHeight = rounded;
      applyBounds();
    },

    /** 当前是否有 toast 决定整窗显隐；显示前重算位置（屏幕/高度可能已变化） */
    syncVisibility(hasToasts: boolean): void {
      if (hasToasts) {
        const win = ensureWindow();
        applyBounds();
        if (!win.isVisible()) {
          // showInactive：绝不抢焦点，避免打断用户正在输入
          win.showInactive();
        }
      } else if (window && !window.isDestroyed() && window.isVisible()) {
        window.hide();
      }
    },

    /** 向 toast 渲染页发送事件（页面未就绪时静默丢弃，主进程状态仍是权威） */
    send(channel: string, payload: unknown): void {
      const win = window;
      if (!win || win.isDestroyed()) return;
      try {
        win.webContents.send(channel, payload);
      } catch {
        // 页面未就绪/正在销毁：忽略本次投递
      }
    },

    /** 预创建窗口并隐藏加载页面（启动期调用，首次弹出零延迟） */
    preload(): void {
      ensureWindow();
    },

    /** 当前窗口是否可见（供测试与状态查询） */
    isVisible(): boolean {
      return !!window && !window.isDestroyed() && window.isVisible();
    },

    /** IPC sender 校验：只有 toast 窗口的 webContents 才被允许上报点击/关闭/高度 */
    owns(webContents: { id: number }): boolean {
      const win = window;
      return !!win && !win.isDestroyed() && win.webContents.id === webContents.id;
    },

    dispose(): void {
      if (window && !window.isDestroyed()) {
        window.destroy();
      }
      window = null;
    },
  };
}

export type ToastWindowController = ReturnType<typeof createToastWindowController>;
