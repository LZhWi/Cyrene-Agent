import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron } from "playwright";
import pngjs from "pngjs";

const { PNG } = pngjs;

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
    "live2dSpeech", "modelConfig", "music", "openerBridge", "schedulerEvents", "settings", "tts", "user", "work",
  ],
  sidebar: ["chatStore", "cyreneFont", "cyreneTheme", "lifeStatus", "modelConfig", "runtimeState", "sidebar"],
  tasks: ["cyreneFont", "cyreneScheduler", "cyreneTheme", "schedulerEvents", "sidebar", "tasks", "tokenUsage"],
  settings: [
    "chatStore", "cyreneFont", "cyreneLocation", "cyreneScheduler", "cyreneTheme",
    "gameBot", "memoryPanel", "modelConfig", "music", "openerBridge", "settings", "system", "tokenUsage", "tts", "user",
  ],
  "sticker-manager": ["cyreneFont", "cyreneTheme", "stickerManager"],
  call: ["call", "cyreneFont", "cyreneTheme", "live2dSpeech", "tts"],
};

const profileDir = await mkdtemp(join(tmpdir(), "cyrene-window-security-"));
let electronApp;
try {
  const avatarPath = join(profileDir, "avatar.png");
  await writeFile(
    avatarPath,
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z2S8AAAAASUVORK5CYII=", "base64"),
  );
  await writeFile(
    join(profileDir, "user-profile.json"),
    JSON.stringify({ avatarPath }),
    "utf8",
  );
  electronApp = await electron.launch({
    // Renderer security checks do not depend on GPU process isolation. Keeping
    // the GPU in-process avoids host subprocess startup failures in this smoke.
    args: [
      "--in-process-gpu",
      `--user-data-dir=${profileDir}`,
      ".",
    ],
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: profileDir,
      USERPROFILE: profileDir,
      UV_CACHE_DIR: join(profileDir, "uv-cache"),
      VITE_DEV: "",
    },
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
  const styleViolations = [];
  const onConsole = (message) => {
    const value = message.text();
    if (value.includes("Content Security Policy") && value.includes("style-src")) {
      styleViolations.push(value);
    }
  };
  main.on("console", onConsole);
  await main.evaluate(() => {
    const probe = document.createElement("link");
    probe.id = "cyrene-google-font-csp-probe";
    probe.rel = "stylesheet";
    probe.href = "https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400&display=swap";
    document.head.appendChild(probe);
  });
  await main.waitForTimeout(500);
  main.off("console", onConsole);
  await main.evaluate(() => document.getElementById("cyrene-google-font-csp-probe")?.remove());
  if (styleViolations.length > 0) {
    throw new Error(`Google Fonts stylesheet is blocked by CSP: ${styleViolations.join(" | ")}`);
  }
  await main.waitForFunction(() => {
    const diagnostics = window.__cyrene?.getLive2DDiagnostics?.();
    return diagnostics?.resources?.modelLoaded === true;
  }, undefined, { timeout: 45_000 });
  await main.waitForTimeout(500);
  const screenshot = PNG.sync.read(await main.screenshot({ omitBackground: true }));
  let live2dRendered = false;
  for (let i = 3; i < screenshot.data.length; i += 4) {
    if (screenshot.data[i] !== 0) {
      live2dRendered = true;
      break;
    }
  }
  if (!live2dRendered) throw new Error("Live2D model loaded but the canvas remained transparent");
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

  const actualUserData = await electronApp.evaluate(({ app }) => app.getPath("userData"));
  if (actualUserData.toLowerCase() !== profileDir.toLowerCase()) {
    throw new Error(`Electron did not use the isolated userData directory: ${actualUserData}`);
  }

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
    const popupBlocked = await page.evaluate(() => window.open("about:blank") === null);
    results[role] = { exposed, inlineScriptExecuted, popupBlocked };
    const expectedApis = [...expected[role]].sort();
    if (JSON.stringify(exposed) !== JSON.stringify(expectedApis)) {
      throw new Error(`${role} preload mismatch: ${JSON.stringify({ expected: expectedApis, exposed })}`);
    }
    if (inlineScriptExecuted) throw new Error(`${role} CSP allowed an inline script`);
    if (!popupBlocked) throw new Error(`${role} navigation policy allowed an about:blank popup`);
  }
  const chat = await findPage("/chat/");
  const avatarDataUrl = await chat.evaluate(() => window.user?.getAvatar());
  if (typeof avatarDataUrl !== "string" || !avatarDataUrl.startsWith("data:image/png;base64,")) {
    throw new Error("chat could not read the isolated user avatar");
  }
  await chat.evaluate(async () => {
    const sessionId = await window.chatStore?.getActiveSession();
    if (!sessionId) throw new Error("chat has no active session for avatar smoke");
    await window.chatStore?.append(sessionId, {
      id: "avatar-smoke-user-message",
      role: "user",
      content: "avatar smoke",
      at: Date.now(),
    });
  });
  await chat.reload({ waitUntil: "domcontentloaded" });
  await chat.waitForFunction(() => {
    const row = document.querySelector('[data-msg-id="avatar-smoke-user-message"]');
    const image = row?.querySelector(".msg__avatar-img");
    return image instanceof HTMLImageElement && image.src.startsWith("data:image/png;base64,");
  }, undefined, { timeout: 10_000 });
  const sidebarHistory = await sidebar.evaluate(() => window.chatStore?.list());
  if (!Array.isArray(sidebarHistory)) throw new Error("sidebar chatStore API is unavailable");
  const clipboardPermission = await chat.evaluate(async () => {
    const status = await navigator.permissions.query({ name: "clipboard-write" });
    return status.state;
  });
  if (clipboardPermission !== "granted") throw new Error(`chat clipboard write permission is ${clipboardPermission}`);
  const memoryPanelData = await settings.evaluate(() => window.memoryPanel?.getData());
  if (!memoryPanelData || typeof memoryPanelData !== "object") {
    throw new Error("settings memoryPanel API is unavailable");
  }
  const openerStatus = await settings.evaluate(() => window.openerBridge?.getStatus());
  if (!openerStatus || typeof openerStatus !== "object") throw new Error("settings openerBridge API is unavailable");
  console.log(JSON.stringify({ ok: true, profileDir, results }, null, 2));
} finally {
  if (electronApp) await electronApp.close().catch(() => {});
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}
