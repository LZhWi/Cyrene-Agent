export type PreloadWindowRole =
  | "main"
  | "chat"
  | "sidebar"
  | "tasks"
  | "settings"
  | "sticker-manager"
  | "call";

const ROLE_PREFIX = "--cyrene-window-role=";

const ROLE_APIS: Record<PreloadWindowRole, ReadonlySet<string>> = {
  main: new Set([
    "cyrene", "cyreneTheme", "cyreneFont", "settings", "user", "cyreneLocation",
    "live2dSpeech", "live2dAction", "live2dDiagnostics", "openerBridge",
  ]),
  chat: new Set([
    "chat", "work", "agui", "schedulerEvents", "choice", "cyreneTheme", "cyreneFont",
    "settings", "modelConfig", "user", "lifeStatus", "live2dSpeech", "openerBridge",
    "chatStore", "tts", "music",
  ]),
  sidebar: new Set([
    "sidebar", "cyreneTheme", "cyreneFont", "modelConfig", "runtimeState", "lifeStatus", "chatStore",
  ]),
  tasks: new Set([
    "tasks", "sidebar", "schedulerEvents", "cyreneTheme", "cyreneFont",
    "cyreneScheduler", "tokenUsage",
  ]),
  settings: new Set([
    "system", "cyreneTheme", "cyreneFont", "settings", "cyreneScheduler", "modelConfig",
    "user", "cyreneLocation", "memoryPanel", "openerBridge", "chatStore", "tokenUsage", "tts", "music", "gameBot",
  ]),
  "sticker-manager": new Set(["cyreneTheme", "cyreneFont", "stickerManager"]),
  call: new Set(["call", "cyreneTheme", "cyreneFont", "live2dSpeech", "tts"]),
};

export const PRELOAD_API_NAMES = Object.freeze([
  ...new Set(Object.values(ROLE_APIS).flatMap((apis) => [...apis])),
]);

export function parsePreloadWindowRole(argv: readonly string[]): PreloadWindowRole | null {
  const raw = argv.find((arg) => arg.startsWith(ROLE_PREFIX))?.slice(ROLE_PREFIX.length);
  return raw && Object.prototype.hasOwnProperty.call(ROLE_APIS, raw)
    ? raw as PreloadWindowRole
    : null;
}

export function shouldExposePreloadApi(role: PreloadWindowRole | null, apiName: string): boolean {
  // Compatibility rollback: every desktop renderer receives the legacy preload
  // surface. Keep role parsing only so restrictions can be redesigned later.
  void role;
  void apiName;
  return true;
}
