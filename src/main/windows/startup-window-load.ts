/**
 * 启动期窗口页面加载辅助：
 * 把“页面加载 + ready-to-show 有限等待 + 主框架失败/超时判定”从窗口对象
 * 创建中拆出来。聊天窗口壳可以先创建，页面等全部 IPC 处理器注册后再加载。
 */

export interface StartupLoadWindowLike {
  once(event: "ready-to-show", listener: () => void): void;
  removeListener(event: "ready-to-show", listener: () => void): void;
  webContents: {
    once(
      event: "did-fail-load",
      listener: (_event: unknown, code: number, description: string, url: string, isMainFrame: boolean) => void,
    ): void;
    removeListener(
      event: "did-fail-load",
      listener: (_event: unknown, code: number, description: string, url: string, isMainFrame: boolean) => void,
    ): void;
  };
}

export interface LoadWindowForStartupInput {
  window: StartupLoadWindowLike;
  load(): Promise<void>;
  timeoutMs: number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

/**
 * 加载窗口页面并在有限时间内等待 ready-to-show。
 * - load() 的拒绝原样透传（页面加载失败属于致命错误）。
 * - 主框架 did-fail-load 拒绝；子框架失败忽略。
 * - ready-to-show 超时以 "ready-to-show timeout" 拒绝。
 */
export function loadWindowForStartup(input: LoadWindowForStartupInput): Promise<void> {
  const { window, load, timeoutMs } = input;
  const setTimeoutFn = input.setTimeout ?? ((handler: () => void, ms: number) => globalThis.setTimeout(handler, ms));
  const clearTimeoutFn = input.clearTimeout ?? ((handle: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(handle));

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const onReady = () => settle(resolve);
    const onFail = (_event: unknown, code: number, description: string, url: string, isMainFrame: boolean) => {
      if (!isMainFrame) return;
      settle(() => reject(new Error(`chat page did-fail-load ${code}: ${description} ${url}`)));
    };

    function settle(next: () => void): void {
      if (settled) return;
      settled = true;
      window.removeListener("ready-to-show", onReady);
      window.webContents.removeListener("did-fail-load", onFail);
      if (timeoutHandle !== undefined) clearTimeoutFn(timeoutHandle);
      next();
    }

    // 监听器必须先于 loadURL/loadFile 挂载，避免快速失败被错过。
    window.once("ready-to-show", onReady);
    window.webContents.once("did-fail-load", onFail);
    timeoutHandle = setTimeoutFn(() => settle(() => reject(new Error("ready-to-show timeout"))), timeoutMs);

    Promise.resolve()
      .then(load)
      .catch((error) => settle(() => reject(error)));
  });
}

/** 聊天窗口 ready-to-show 的默认等待上限。 */
export const CHAT_READY_TIMEOUT_MS = 20_000;
