import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

const expected = Object.fromEntries(
  ["main", "chat", "sidebar", "tasks", "settings", "sticker-manager", "call"]
    .map((role) => [role, [...knownApis]]),
);

const profileDir = await mkdtemp(join(tmpdir(), "cyrene-window-security-"));
const roamingAppDataDir = join(profileDir, "AppData", "Roaming");
const localAppDataDir = join(profileDir, "AppData", "Local");
const spellingDir = join(roamingAppDataDir, "Microsoft", "Spelling", "neutral");
let electronApp;
try {
  await mkdir(spellingDir, { recursive: true });
  await mkdir(localAppDataDir, { recursive: true });
  const emptyUtf16Dictionary = Buffer.from([0xff, 0xfe]);
  await Promise.all(
    ["default.dic", "default.exc", "default.acl"]
      .map((name) => writeFile(join(spellingDir, name), emptyUtf16Dictionary)),
  );
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
      APPDATA: roamingAppDataDir,
      LOCALAPPDATA: localAppDataDir,
      HOME: profileDir,
      USERPROFILE: profileDir,
      UV_CACHE_DIR: join(profileDir, "uv-cache"),
      VITE_DEV: "",
    },
    timeout: 60_000,
  });
  await electronApp.firstWindow({ timeout: 60_000 });

  const findPage = async (fragment) => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const page = electronApp.windows().find((candidate) => candidate.url().includes(fragment));
      if (page) {
        await page.waitForLoadState("domcontentloaded", { timeout: 60_000 });
        return page;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for window: ${fragment}`);
  };

  // Window creation is asynchronous; chat can become observable before the pet
  // window, so identify the root window by its packaged URL instead of arrival order.
  const main = await findPage("/renderer/index.html");
  const readMainWindowState = async () => electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()
      .find((candidate) => candidate.webContents.getURL().includes("/renderer/index.html"));
    if (!window || window.isDestroyed()) return null;
    return {
      bounds: window.getBounds(),
      opacity: window.getOpacity(),
      visible: window.isVisible(),
    };
  });
  const waitForMainWindowState = async (predicate, description) => {
    const deadline = Date.now() + 10_000;
    let lastState = null;
    while (Date.now() < deadline) {
      const state = await readMainWindowState();
      lastState = state;
      if (state && predicate(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for main-window state: ${description}; last=${JSON.stringify(lastState)}`);
  };
  await main.waitForFunction(() => {
    const diagnostics = window.__cyrene?.getLive2DDiagnostics?.();
    return diagnostics?.resources?.modelLoaded === true;
  }, undefined, { timeout: 60_000 });
  await main.waitForTimeout(500);
  const screenshot = PNG.sync.read(await main.screenshot({ omitBackground: true }));
  let live2dRendered = false;
  for (let index = 3; index < screenshot.data.length; index += 4) {
    if (screenshot.data[index] !== 0) {
      live2dRendered = true;
      break;
    }
  }
  if (!live2dRendered) throw new Error("Live2D model loaded but the canvas remained transparent");
  const initialMainWindowState = await readMainWindowState();
  if (!initialMainWindowState) throw new Error("main BrowserWindow is unavailable");
  const mainWindowApiResult = await main.evaluate(async () => {
    const frame = await window.cyrene.captureFrame();
    const cursor = await window.cyrene.getCursorPosition();
    await window.cyrene.setInteractive(false);
    await window.cyrene.setInteractive(true);
    return {
      captured: typeof frame === "string" && frame.startsWith("data:image/png;base64,"),
      cursor,
    };
  });
  if (!mainWindowApiResult.captured) throw new Error("main-window capture IPC returned no PNG data URL");
  if (!Number.isFinite(mainWindowApiResult.cursor?.x) || !Number.isFinite(mainWindowApiResult.cursor?.y)) {
    throw new Error(`main-window cursor IPC returned invalid coordinates: ${JSON.stringify(mainWindowApiResult.cursor)}`);
  }

  const targetX = initialMainWindowState.bounds.x + 12;
  const targetY = initialMainWindowState.bounds.y + 12;
  await main.evaluate(({ x, y }) => window.cyrene.moveTo(x, y), { x: targetX, y: targetY });
  await waitForMainWindowState(
    (state) => state.bounds.x === targetX && state.bounds.y === targetY,
    "moveTo",
  );
  await main.evaluate(() => window.cyrene.setDragging(true));
  await waitForMainWindowState((state) => Math.abs(state.opacity - 0.99) < 0.001, "drag opacity");
  await main.evaluate(() => window.cyrene.setDragging(false));
  await waitForMainWindowState((state) => state.opacity === 1, "drag opacity reset");

  await main.evaluate(() => window.settings.setPetZoom(1.1));
  await waitForMainWindowState(
    (state) => state.bounds.width === initialMainWindowState.bounds.width + 40
      && state.bounds.height === initialMainWindowState.bounds.height + 50,
    "pet zoom",
  );
  const resetZoomDiagnostics = await main.evaluate(async () => {
    const events = [];
    const off = window.cyrene.onPetZoom((zoom) => events.push(zoom));
    window.settings.setPetZoom(1);
    const persisted = (await window.settings.getGeneral()).petZoom;
    await new Promise((resolve) => setTimeout(resolve, 100));
    off();
    return { persisted, events, innerWidth: window.innerWidth, innerHeight: window.innerHeight };
  });
  if (resetZoomDiagnostics.persisted !== 1) {
    throw new Error(`pet zoom did not persist reset: ${JSON.stringify(resetZoomDiagnostics)}`);
  }
  await waitForMainWindowState(
    (state) => state.bounds.width === initialMainWindowState.bounds.width
      && state.bounds.height === initialMainWindowState.bounds.height,
    `pet zoom reset ${JSON.stringify(resetZoomDiagnostics)}`,
  );

  await main.evaluate(() => window.settings.setPetVisible(false));
  await waitForMainWindowState((state) => state.visible === false, "pet hide");
  await main.evaluate(() => window.settings.setPetVisible(true));
  await waitForMainWindowState((state) => state.visible === true, "pet show");

  await main.evaluate(({ x, y }) => window.cyrene.moveTo(x, y), {
    x: initialMainWindowState.bounds.x,
    y: initialMainWindowState.bounds.y,
  });
  await waitForMainWindowState(
    (state) => state.bounds.x === initialMainWindowState.bounds.x
      && state.bounds.y === initialMainWindowState.bounds.y,
    "position reset",
  );
  await main.evaluate(() => window.cyrene.setDragging(false));
  const legacyRendererCapabilities = await main.evaluate(() => {
    const marker = "__cyreneLegacyInlineSmoke";
    delete window[marker];
    const script = document.createElement("script");
    script.textContent = `window.${marker}=true`;
    document.head.appendChild(script);
    script.remove();
    const popup = window.open("about:blank");
    const popupAllowed = popup !== null;
    popup?.close();
    return { inlineScriptAllowed: window[marker] === true, popupAllowed };
  });
  if (!legacyRendererCapabilities.inlineScriptAllowed) {
    throw new Error("Legacy renderer script capability is still restricted");
  }
  if (!legacyRendererCapabilities.popupAllowed) {
    throw new Error("Legacy renderer popup capability is still restricted");
  }
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
    results[role] = { exposed };
    const expectedApis = [...expected[role]].sort();
    if (JSON.stringify(exposed) !== JSON.stringify(expectedApis)) {
      throw new Error(`${role} preload mismatch: ${JSON.stringify({ expected: expectedApis, exposed })}`);
    }
  }
  const chat = await findPage("/chat/");
  const cancellationApis = await chat.evaluate(() => ({
    aguiCancel: typeof window.agui?.cancel === "function",
    ttsStreamCancel: typeof window.tts?.streamCancel === "function",
  }));
  if (!cancellationApis.aguiCancel || !cancellationApis.ttsStreamCancel) {
    throw new Error(`chat cancellation preload mismatch: ${JSON.stringify(cancellationApis)}`);
  }
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
  console.log(JSON.stringify({ ok: true, profileDir, mainWindowApiResult, results }, null, 2));
} finally {
  if (electronApp) {
    const closeStartedAt = Date.now();
    await electronApp.close();
    const closeElapsedMs = Date.now() - closeStartedAt;
    if (closeElapsedMs > 7_000) {
      throw new Error(`Electron shutdown exceeded cleanup bound: ${closeElapsedMs}ms`);
    }
  }
  // A removable profile proves Electron and its child processes released their file handles.
  await rm(profileDir, { recursive: true, force: true });
}
