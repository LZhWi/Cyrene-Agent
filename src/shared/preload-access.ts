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
    "settings", "modelConfig", "lifeStatus", "live2dSpeech", "chatStore", "tts", "music",
  ]),
  sidebar: new Set([
    "sidebar", "cyreneTheme", "cyreneFont", "modelConfig", "runtimeState", "lifeStatus",
  ]),
  tasks: new Set([
    "tasks", "sidebar", "schedulerEvents", "cyreneTheme", "cyreneFont",
    "cyreneScheduler", "tokenUsage",
  ]),
  settings: new Set([
    "system", "cyreneTheme", "cyreneFont", "settings", "cyreneScheduler", "modelConfig",
    "user", "cyreneLocation", "memoryPanel", "chatStore", "tokenUsage", "tts", "music",
  ]),
  "sticker-manager": new Set(["cyreneTheme", "cyreneFont", "stickerManager"]),
  call: new Set(["call", "cyreneTheme", "cyreneFont", "live2dSpeech", "tts"]),
};

export function parsePreloadWindowRole(argv: readonly string[]): PreloadWindowRole | null {
  const raw = argv.find((arg) => arg.startsWith(ROLE_PREFIX))?.slice(ROLE_PREFIX.length);
  return raw && Object.prototype.hasOwnProperty.call(ROLE_APIS, raw)
    ? raw as PreloadWindowRole
    : null;
}

export function shouldExposePreloadApi(role: PreloadWindowRole | null, apiName: string): boolean {
  // Unlabelled windows retain the legacy preload surface. GameBot is intentionally
  // unlabelled because it is outside the scope of the PC hardening work.
  return role === null || ROLE_APIS[role].has(apiName);
}
