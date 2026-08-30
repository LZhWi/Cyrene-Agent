// 工具侧统一 timezone 注入（原样迁自 built-in-tools.ts，行为不变）。
// index.ts 启动时调 setUserTimezoneConfig；任何工具要给模型格式化时间，
// 统一走 `currentUserTimezone()`，禁止各自直接读 profile/Intl。

import { resolveChatContextTimezone } from "../../chat-time-context";

let userTimezoneGetter: (() => string | undefined) | null = null;

export function setUserTimezoneConfig(timezoneGetter: () => string | undefined): void {
  userTimezoneGetter = timezoneGetter;
}

/** 当前用户的有效时区（缺/非法时回退 Asia/Shanghai）。统一封装，所有工具复用。 */
export function currentUserTimezone(): string {
  const raw = userTimezoneGetter?.();
  return resolveChatContextTimezone(raw);
}
