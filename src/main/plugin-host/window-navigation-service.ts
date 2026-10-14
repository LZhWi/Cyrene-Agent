import type { PluginWindowNavigationService } from "../../plugins/api";
import type { WindowManager } from "../windows/window-manager";
import { pluginHostError } from "./errors";

type Mode = "chat" | "work" | "code" | "learn";
const MODES = ["chat", "work", "code", "learn"] as const;
type Session = { id: string; title: string; mode: Mode };

export interface PluginWindowNavigationOptions {
  listSessions(): Session[];
  createSession(mode: Mode): Session | Promise<Session>;
  windows: Pick<WindowManager, "openReactChatWindow" | "openReactWorkspaceWindow" | "createSettingsWindow">;
  signal?: AbortSignal;
}

export function createPluginWindowNavigationService(options: PluginWindowNavigationOptions): PluginWindowNavigationService {
  const active = () => {
    if (options.signal?.aborted) throw pluginHostError("E_PLUGIN_STOPPING", "插件已停止，窗口导航不可用");
  };
  const mode = (value: unknown): Mode => {
    if (!MODES.includes(value as Mode)) throw pluginHostError("E_INVALID_ARGUMENT", "不支持的会话模式");
    return value as Mode;
  };
  return {
    async listSessions(value) {
      active();
      const target = mode(value);
      return options.listSessions().filter(row => row.mode === target)
        .map(row => ({ id: row.id, title: row.title, mode: row.mode }));
    },
    async open(input) {
      active();
      if (!input || typeof input !== "object") throw pluginHostError("E_INVALID_ARGUMENT", "非法窗口导航参数");
      if (input.target === "settings") {
        options.windows.createSettingsWindow();
        return { sessionId: null };
      }
      const target = mode(input.target);
      let session: Session;
      if (input.session === "new") session = await options.createSession(target);
      else if (input.session === "existing") {
        const existing = options.listSessions().find(row => row.id === input.sessionId && row.mode === target);
        if (!existing) throw pluginHostError("E_NOT_FOUND", "所选会话不存在或模式已改变，请重新选择");
        session = existing;
      } else throw pluginHostError("E_INVALID_ARGUMENT", "请选择已有会话或新建会话");
      active();
      if (target === "chat") await options.windows.openReactChatWindow(session.id);
      else await options.windows.openReactWorkspaceWindow(session.id);
      active();
      return { sessionId: session.id };
    },
  };
}
