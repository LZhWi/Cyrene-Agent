// toast 窗口控制器测试：聚焦高度协议与定位。
// 回归背景：updateHeight 曾只记账不应用 bounds，且渲染端 offsetHeight 被窗口
// 当前高度 clamp，两者叠加形成"窗口 1px → 测不准 → 永远 1px"的死锁。

import { describe, expect, it, vi } from "vitest";
import { createToastWindowController } from "./toast-window";
import { TOAST_WINDOW_WIDTH } from "./types";

/** 工作区：1920x1080 屏幕，底部任务栏占 48px（workArea 不含任务栏） */
const WORKAREA = { x: 0, y: 0, width: 1920, height: 1080 - 48 };

interface WindowStub {
  setBounds: ReturnType<typeof vi.fn>;
  showInactive: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  isVisible: () => boolean;
  webContents: { id: number };
  isDestroyed: () => boolean;
}

function createWindowStub(): WindowStub {
  let visible = false;
  return {
    setBounds: vi.fn(),
    showInactive: vi.fn(() => { visible = true; }),
    hide: vi.fn(() => { visible = false; }),
    isVisible: () => visible,
    webContents: { id: 42 },
    isDestroyed: () => false,
  };
}

function setup() {
  const win = createWindowStub();
  const controller = createToastWindowController({
    createWindow: () => win as never,
    getChatWindow: () => null,
    getDisplayMatching: () => ({ workArea: WORKAREA }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  });
  return { win, controller };
}

/** 取最近一次 setBounds 的参数 */
function lastBounds(win: WindowStub) {
  const calls = win.setBounds.mock.calls;
  return calls[calls.length - 1][0] as { x: number; y: number; width: number; height: number };
}

describe("createToastWindowController · 高度协议", () => {
  it("updateHeight 收到新高度立即应用 bounds，不等下一次显示", () => {
    const { win, controller } = setup();
    controller.preload();
    controller.updateHeight(94);
    expect(win.setBounds).toHaveBeenCalledWith(
      expect.objectContaining({ width: TOAST_WINDOW_WIDTH, height: 94 }),
    );
  });

  it("重复上报相同高度不重复 setBounds（渲染端之外的防抖兜底）", () => {
    const { win, controller } = setup();
    controller.preload();
    controller.updateHeight(94);
    const calls = win.setBounds.mock.calls.length;
    controller.updateHeight(94);
    expect(win.setBounds.mock.calls.length).toBe(calls);
  });

  it("高度上报驱动窗口逐级放大：模拟 1px 起步的解锁过程", () => {
    const { win, controller } = setup();
    controller.preload();
    // 初始（渲染页空容器上报，scrollHeight = padding 24）
    controller.updateHeight(24);
    expect(lastBounds(win).height).toBe(24);
    // 卡片渲染后上报真实内容高度（scrollHeight 不受窗口 clamp）
    controller.updateHeight(118);
    expect(lastBounds(win).height).toBe(118);
  });

  it("无效高度被忽略：非有限值与 0/负数不更新也不应用", () => {
    const { win, controller } = setup();
    controller.preload();
    win.setBounds.mockClear();
    controller.updateHeight(0);
    controller.updateHeight(-5);
    controller.updateHeight(Number.NaN);
    expect(win.setBounds).not.toHaveBeenCalled();
  });
});

describe("createToastWindowController · 定位与显隐", () => {
  it("窗口贴工作区右下角：底边对齐任务栏上缘，不越界", () => {
    const { win, controller } = setup();
    controller.preload();
    controller.updateHeight(100);
    controller.syncVisibility(true);
    const b = lastBounds(win);
    expect(b.x).toBe(WORKAREA.x + WORKAREA.width - TOAST_WINDOW_WIDTH);
    expect(b.y + b.height).toBe(WORKAREA.y + WORKAREA.height);
    expect(win.showInactive).toHaveBeenCalled();
  });

  it("高度超过工作区 60% 上限时被 clamp，窗口仍不出工作区", () => {
    const { win, controller } = setup();
    controller.preload();
    controller.updateHeight(5000);
    controller.syncVisibility(true);
    const b = lastBounds(win);
    expect(b.height).toBe(Math.floor(WORKAREA.height * 0.6));
    expect(b.y + b.height).toBeLessThanOrEqual(WORKAREA.y + WORKAREA.height);
  });

  it("队列清空整窗隐藏，再来新 toast 重新显示", () => {
    const { win, controller } = setup();
    controller.preload();
    controller.updateHeight(100);
    controller.syncVisibility(true);
    expect(win.isVisible()).toBe(true);
    controller.syncVisibility(false);
    expect(win.isVisible()).toBe(false);
    controller.syncVisibility(true);
    expect(win.isVisible()).toBe(true);
  });
});
