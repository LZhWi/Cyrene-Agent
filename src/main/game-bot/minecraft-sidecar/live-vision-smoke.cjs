"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fork } = require("node:child_process");
const { app, BrowserWindow } = require("electron");
const { readMinecraftSettings } = require("./live-provider-smoke.cjs");

const settingsPath = process.argv[2];
if (!settingsPath) throw new Error("usage: electron live-vision-smoke.cjs <game-bot-settings.json>");

async function main() {
  const all = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const original = readMinecraftSettings(settingsPath);
  const child = fork(path.join(__dirname, "sidecar.cjs"), [], {
    cwd: __dirname, stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  const progress = [];
  let childError = "";
  child.stderr.on("data", (chunk) => { childError += String(chunk).slice(0, 4000); });
  let finished = false;
  const finish = (result) => {
    if (finished) return;
    finished = true;
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (child.connected) child.send({ type: "stop" });
    setTimeout(() => { if (!child.killed) child.kill(); app.exit(result.ok ? 0 : 1); }, 500);
    if (!result.ok) process.exitCode = 1;
  };
  const timer = setTimeout(() => finish({ ok: false, error: "vision smoke timeout", progress: progress.slice(-8) }), 70_000);
  child.on("message", async (message) => {
    if (message?.type === "progress" && message.message) progress.push(String(message.message));
    if (message?.type === "progress" && message.message) process.stderr.write(`[mc] ${message.message}\n`);
    if (message?.type !== "viewer_ready") return;
    try {
      const win = new BrowserWindow({ show: false, width: 960, height: 720, webPreferences: { offscreen: true, sandbox: true } });
      await win.loadURL(message.viewerUrl);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const capture = await win.webContents.capturePage();
      const size = capture.getSize();
      const png = capture.toPNG();
      const capturePath = process.argv[4];
      if (capturePath) fs.writeFileSync(path.resolve(capturePath), png);
      const bitmap = capture.toBitmap();
      const samples = new Set();
      const stride = Math.max(4, Math.floor(bitmap.length / 2000 / 4) * 4);
      for (let index = 0; index < bitmap.length; index += stride) samples.add(bitmap.subarray(index, index + 4).toString("hex"));
      const config = all.vlm;
      let observation = null;
      if (config?.baseUrl && config?.model) {
        const { focusMinecraftThirdPerson, observeMinecraftThirdPerson } = require(path.join(__dirname, "../../../../dist/main/main/game-bot/minecraft/vision.js"));
        const image = { base64: png.toString("base64"), mime: "image/png" };
        observation = process.argv[3]
          ? await focusMinecraftThirdPerson(config, image, process.argv[3], { test: "read-only focused vision smoke" })
          : await observeMinecraftThirdPerson(config, image, { test: "read-only vision smoke" });
      }
      clearTimeout(timer);
      win.destroy();
      finish({ ok: size.width > 0 && size.height > 0 && samples.size > 8 && Boolean(observation), size, colors: samples.size, observation, progress: progress.slice(-8) });
    } catch (error) {
      clearTimeout(timer);
      finish({ ok: false, error: error instanceof Error ? error.message : String(error), progress: progress.slice(-8) });
    }
  });
  child.on("exit", (code) => {
    if (!finished) finish({ ok: false, error: `sidecar exited ${code}`, childError: childError.slice(-2000), progress: progress.slice(-8) });
  });
  child.send({ type: "start", settings: {
    ...original,
    username: "CyreneVision", owner: original.owner, auth: "offline", reconnect: false,
    autonomy: { mode: "passive", visionEnabled: true }, soul: { ...original.soul, enabled: false }, llm: { ...original.llm, enabled: false },
    profilesFolder: path.join(__dirname, ".vision-auth-unused"), stateFile: path.join(__dirname, ".vision-state-unused.json"),
  } });
}

app.whenReady().then(main).catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 1;
  app.quit();
});
