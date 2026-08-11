// input —— 键鼠控制（@nut-tree-fork/nut-js）。
// 高风险操作：真实控制用户鼠标键盘。仅供 game-bot 引擎调用，走权限网关。
//
// 注意：nut.js 是 native 模块，Electron 需 electron-rebuild 重编译。
// 若启动报 native 模块错误，备选 koffi + user32 SendInput（见 plan Task 6/13 验证点）。

import { mouse, Point, keyboard, Key, Button } from "@nut-tree-fork/nut-js";

const CLICK_HOLD_MS = 80;

/** 特殊键名 → nut.js Key。单字母（A-Z）走动态解析。 */
const KEY_MAP: Record<string, Key> = {
  F1: Key.F1, F2: Key.F2, F3: Key.F3, F4: Key.F4, F5: Key.F5, F6: Key.F6,
  F7: Key.F7, F8: Key.F8, F9: Key.F9, F10: Key.F10, F11: Key.F11, F12: Key.F12,
  Escape: Key.Escape, Esc: Key.Escape, Enter: Key.Enter, Return: Key.Enter,
  Space: Key.Space, Tab: Key.Tab, Backspace: Key.Backspace, Delete: Key.Delete,
  Alt: Key.LeftAlt, Ctrl: Key.LeftControl, Control: Key.LeftControl, Shift: Key.LeftShift,
  Win: Key.LeftSuper, Meta: Key.LeftSuper,
};

/** 键名 → Key。支持 F1-12 / Escape / Enter / 修饰键 / 单字母 A-Z。未知返回 null。 */
function resolveKey(name: string): Key | null {
  const upper = name.trim();
  if (KEY_MAP[upper] !== undefined) return KEY_MAP[upper];
  if (/^[A-Z]$/.test(upper)) {
    const k = (Key as unknown as Record<string, Key>)[upper];
    return k ?? null;
  }
  return null;
}

/** 移动到 (x,y) 并左键单击一次。 */
export async function click(x: number, y: number): Promise<void> {
  await mouse.setPosition(new Point(x, y));
  await mouse.pressButton(Button.LEFT);
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, CLICK_HOLD_MS));
  } finally {
    await mouse.releaseButton(Button.LEFT);
  }
}

/** 从屏幕坐标 start 平滑拖拽到 end。 */
export async function drag(start: { x: number; y: number }, end: { x: number; y: number }): Promise<void> {
  const path = Array.from({ length: 13 }, (_, index) => {
    const ratio = index / 12;
    return new Point(
      Math.round(start.x + (end.x - start.x) * ratio),
      Math.round(start.y + (end.y - start.y) * ratio),
    );
  });
  await mouse.setPosition(path[0]);
  await mouse.drag(path);
}

/** 在指定屏幕坐标滚动；steps > 0 向下，steps < 0 向上。 */
export async function scroll(x: number, y: number, steps: number): Promise<void> {
  await mouse.setPosition(new Point(x, y));
  if (steps > 0) await mouse.scrollDown(steps);
  else if (steps < 0) await mouse.scrollUp(Math.abs(steps));
}

/** 点击屏幕中心。 */
export async function clickCenter(width: number, height: number): Promise<void> {
  await click(Math.floor(width / 2), Math.floor(height / 2));
}

/** 按组合键。combo 形如 "F4" / "Alt+F4" / "Escape" / "V"。 */
export async function keyPress(combo: string): Promise<void> {
  const parts = combo.split("+").map(s => s.trim());
  const keys = parts.map(resolveKey).filter((k): k is Key => k !== null);
  if (keys.length === 0) {
    console.warn("[GameBot] 未知键组合，跳过:", combo);
    return;
  }
  await keyboard.pressKey(...keys);
  await keyboard.releaseKey(...keys.slice().reverse());
}
