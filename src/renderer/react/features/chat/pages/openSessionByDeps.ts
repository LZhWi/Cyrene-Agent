/**
 * React 聊天窗口打开会话的纯函数 helper。
 *
 * 之所以独立成模块：便于 React ChatPage 与测试文件独立 import，
 * 避免测试文件触发 ChatPage.tsx 整模块的依赖副作用（antdx / 大量 hooks）。
 *
 * React 窗口支持 chat/work/code/daily/learn 五种模式。
 * 返回 null 表示调用方应执行 fallback。
 */

export type ReactSessionMode = "chat" | "work" | "code" | "daily" | "learn";

export function normalizeSessionMode(mode: string | undefined): ReactSessionMode | null {
  switch (mode) {
    case "chat":
    case "work":
    case "code":
    case "daily":
    case "learn":
      return mode;
    default:
      return null;
  }
}

export interface OpenSessionArgs {
  sessionId: string;
  getSession: (sessionId: string) => Promise<{ mode?: string } | null>;
  selectSession: (sessionId: string, mode: ReactSessionMode) => Promise<void>;
}

export async function openSessionByIdWithDeps(args: OpenSessionArgs): Promise<boolean> {
  const session = await args.getSession(args.sessionId);
  if (!session) return false;
  const mode = normalizeSessionMode(session.mode);
  if (!mode) return false;
  await args.selectSession(args.sessionId, mode);
  return true;
}
