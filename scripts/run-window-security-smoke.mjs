import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron } from "playwright";

const knownApis = [
  "agui", "call", "chat", "chatStore", "choice", "cyrene", "cyreneFont",
  "cyreneLocation", "cyreneScheduler", "cyreneTheme", "gameBot", "lifeStatus",
  "live2dAction", "live2dDiagnostics", "live2dSpeech", "memoryPanel", "modelConfig",
  "music", "openerBridge", "runtimeState", "schedulerEvents", "settings", "sidebar",
  "stickerManager", "system", "tasks", "tokenUsage", "tts", "user", "work",
];

const expected = {
  main: [
    "cyrene", "cyreneFont", "cyreneLocation", "cyreneTheme", "live2dAction",
    "live2dDiagnostics", "live2dSpeech", "openerBridge", "settings", "user",
  ],
  chat: [
    "agui", "chat", "chatStore", "choice", "cyreneFont", "cyreneTheme", "lifeStatus",
    "live2dSpeech", "modelConfig", "music", "schedulerEvents", "settings", "tts", "work",
  ],
  sidebar: ["cyreneFont", "cyreneTheme", "lifeStatus", "modelConfig", "runtimeState", "sidebar"],
  tasks: ["cyreneFont", "cyreneScheduler", "cyreneTheme", "schedulerEvents", "sidebar", "tasks", "tokenUsage"],
  settings: [
    "chatStore", "cyreneFont", "cyreneLocation", "cyreneScheduler", "cyreneTheme",
    "memoryPanel", "modelConfig", "music", "settings", "system", "tokenUsage", "tts", "user",
  ],
  "sticker-manager": ["cyreneFont", "cyreneTheme", "stickerManager"],
  call: ["call", "cyreneFont", "cyreneTheme", "live2dSpeech", "tts"],
};

const profileDir = await mkdtemp(join(tmpdir(), "cyrene-window-security-"));
let electronApp;
try {
  electronApp = await electron.launch({
    args: [".", `--user-data-dir=${profileDir}`],
    cwd: process.cwd(),
    env: { ...process.env, VITE_DEV: "" },
    timeout: 45_000,
  });
  await electronApp.firstWindow({ timeout: 45_000 });

  const findPage = async (fragment) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const page = electronApp.windows().find((candidate) => candidate.url().includes(fragment));
      if (page) {
        await page.waitForLoadState("domcontentloaded");
        return page;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for window: ${fragment}`);
  };

  // Window creation is asynchronous; chat can become observable before the pet
  // window, so identify the root window by its packaged URL instead of arrival order.
  const main = await findPage("/renderer/index.html");
  await main.evaluate(() => {
    window.settings.openSidebar();
    window.settings.openTasks();
  });

  const sidebar = await findPage("/sidebar/");
  await findPage("/tasks/");
  await sidebar.evaluate(() => {
    window.sidebar.openSettings();
    window.sidebar.openCall();
    window.sidebar.openWork();
  });
  const settings = await findPage("/settings/");
  await findPage("/call/");
  await findPage("/chat/");
  await settings.evaluate(() => window.settings.openStickerManager());
  await findPage("/sticker-manager/");

  const fragments = {
    main: "/renderer/index.html",
    chat: "/chat/",
    sidebar: "/sidebar/",
    tasks: "/tasks/",
    settings: "/settings/",
    "sticker-manager": "/sticker-manager/",
    call: "/call/",
  };
  const results = {};
  for (const [role, fragment] of Object.entries(fragments)) {
    const page = role === "main" ? main : await findPage(fragment);
    const exposed = await page.evaluate((names) => names.filter((name) => name in window).sort(), knownApis);
    const inlineScriptExecuted = await page.evaluate(() => {
      const marker = "__cyreneCspInlineSmoke";
      delete window[marker];
      const script = document.createElement("script");
      script.textContent = `window.${marker}=true`;
      document.head.appendChild(script);
      script.remove();
      return window[marker] === true;
    });
    results[role] = { exposed, inlineScriptExecuted };
    const expectedApis = [...expected[role]].sort();
    if (JSON.stringify(exposed) !== JSON.stringify(expectedApis)) {
      throw new Error(`${role} preload mismatch: ${JSON.stringify({ expected: expectedApis, exposed })}`);
    }
    if (inlineScriptExecuted) throw new Error(`${role} CSP allowed an inline script`);
  }
  console.log(JSON.stringify({ ok: true, profileDir, results }, null, 2));
} finally {
  if (electronApp) await electronApp.close().catch(() => {});
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}
