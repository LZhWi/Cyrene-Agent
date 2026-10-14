import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
assert.equal(path.basename(project), "Cyrene-Agent-N-life-conversation");
const output = path.join(project, "output", "native-isolated-smoke");
fs.mkdirSync(output, { recursive: true });
const runtime = path.join(project, ".runtime");
fs.mkdirSync(runtime, { recursive: true });
assert(!fs.lstatSync(runtime).isSymbolicLink());
// Only hash JSON data; no credentials or real messages are copied into the test.
const protectedRoots = [path.join(path.dirname(project), "Cyrene-Agent", "AppData")];
if (process.env.APPDATA) protectedRoots.push(path.join(process.env.APPDATA, "live2d-cyrene"));
function snapshot() {
  const files = {};
  function scan(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) scan(file);
      else if (entry.isFile() && entry.name.endsWith(".json")) files[file] = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    }
  }
  protectedRoots.forEach(scan);
  return files;
}
const before = snapshot();
const root = fs.mkdtempSync(path.join(runtime, "native-smoke-"));
const dirs = Object.fromEntries(["app-data", "local-app-data", "home", "temp", "user-data"].map((name) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  return [name, dir];
}));
for (const name of ["Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos"]) fs.mkdirSync(path.join(dirs.home, name));
const env = { ...process.env, APPDATA: dirs["app-data"], LOCALAPPDATA: dirs["local-app-data"],
  USERPROFILE: dirs.home, HOME: dirs.home, TEMP: dirs.temp, TMP: dirs.temp, TMPDIR: dirs.temp,
  CYRENE_ISOLATED_RUN_ROOT: root };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV;
const report = { startedAt: new Date().toISOString(), checks: [], protectedJsonFiles: Object.keys(before).length };
let app;
let logs = "";
try {
  app = await _electron.launch({ executablePath: createRequire(import.meta.url)("electron"), cwd: project,
    args: [project, `--user-data-dir=${dirs["user-data"]}`], env, timeout: 30_000 });
  app.process().stdout?.on("data", (data) => { logs += data; });
  app.process().stderr?.on("data", (data) => { logs += data; });
  const actual = await app.evaluate(({ app }) => app.getPath("userData"));
  assert.equal(path.resolve(actual), dirs["user-data"]);
  report.checks.push("Electron userData is isolated");
  const waitPage = async (predicate) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const page = app.windows().find((page) => predicate(page.url()));
      if (page) { await page.waitForLoadState("domcontentloaded"); return page; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Expected native window did not load");
  };
  const chat = await waitPage((url) => url.includes("/react/") && url.includes("windowKind=chat"));
  await chat.waitForFunction(() => Boolean(window.chatStore && document.querySelector(".cy-page")));
  report.checks.push("Native Chat mounted");
  await chat.evaluate(() => window.sidebar.openSettings("api-advanced"));
  const settings = await waitPage((url) => url.includes("/settings/"));
  await settings.waitForFunction(() => document.querySelector("#model-request-max-retries")?.value === "5");
  await settings.locator("#model-request-max-retries").fill("2");
  await settings.locator("#api-runtime-form button[type=submit]").click();
  await settings.waitForFunction(() => document.querySelector("#runtime-save-status")?.textContent === "已保存");
  assert.equal(await settings.evaluate(async () => (await window.settings.getConfig()).modelRequestMaxRetries), 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dirs["user-data"], "model-settings.json"), "utf8")).modelRequestMaxRetries, 2);
  report.checks.push("Retry setting saved through native UI and IPC");

  const retryCalls = await app.evaluate(async ({ app }) => {
    const require = process.getBuiltinModule("module").createRequire(`${app.getAppPath()}/package.json`);
    const { pluginGenerateText } = require("./dist/main/main/plugin-llm.js");
    const { createLlmClient } = require("./dist/main/main/services/llm/llm-client.js");
    const { loadModelSettings } = require("./dist/main/main/settings/model-settings.js");
    const { enqueueLLMTask } = require("./dist/main/main/llm-queue.js");
    const original = globalThis.fetch;
    let count = 0;
    globalThis.fetch = async () => {
      count += 1;
      return count === 1
        ? new Response(JSON.stringify({ error: { message: "synthetic unavailable" } }), { status: 503, headers: { "retry-after": "0" } })
        : new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "synthetic success" }, finish_reason: "stop" }] }));
    };
    try {
      const settings = { ...loadModelSettings(), provider: "OpenAI", baseUrl: "https://fake.invalid/v1", model: "synthetic", apiKey: "test-only", explicitTransport: "openai" };
      const text = await pluginGenerateText([{ role: "user", content: "synthetic" }], settings, createLlmClient(), enqueueLLMTask, { purpose: "native-smoke" });
      if (text !== "synthetic success") throw new Error("Unexpected synthetic result");
      return count;
    } finally { globalThis.fetch = original; }
  });
  assert.equal(retryCalls, 2);
  report.checks.push("Native plugin host retried mocked HTTP 503 once and completed without network");
  await app.evaluate(({ app }) => {
    globalThis.__nativeSmokeNav = [];
    app.on("browser-window-created", (_event, window) => {
      window.webContents.on("did-start-loading", () => globalThis.__nativeSmokeNav.push({ event: "loading", url: window.webContents.getURL() }));
      window.webContents.on("did-start-navigation", (details) => globalThis.__nativeSmokeNav.push({ event: "navigation", isSameDocument: details.isSameDocument, isMainFrame: details.isMainFrame }));
    });
  });

  for (const mode of ["work", "code", "learn"]) {
    const id = await app.evaluate(({ app }, { project, mode }) => {
      const require = process.getBuiltinModule("module").createRequire(`${app.getAppPath()}/package.json`);
      const store = require("./dist/main/main/chats/chats-store.js");
      return store.createSession({ mode, title: `Synthetic ${mode}`, initialMessages: Array.from({ length: 400 }, (_, index) => ({
        id: `${mode}-${index}`, role: index % 2 ? "model" : "user", content: `${mode} synthetic message ${index}`, at: Date.now() + index,
      })) }).id;
    }, { project, mode });
    await chat.evaluate((id) => window.chatStore.openInReactChatWindow(id), id);
    const workspace = await waitPage((url) => url.includes("/react/") && url.includes("windowKind=workspace"));
    try {
      await workspace.getByText(`${mode} synthetic message 399`, { exact: true }).waitFor({ timeout: 10_000 });
    } catch (error) {
      report.workspaceFailure = await workspace.evaluate(() => ({ url: location.href,
        rows: Array.from(document.querySelectorAll(".cy-message-list__virtual-row")).map((row) => ({ index: row.getAttribute("data-index"), text: row.textContent })),
        text: document.body.innerText.slice(-2500) }));
      report.dispatchFailure = await app.evaluate(({ app }) => {
        const require = process.getBuiltinModule("module").createRequire(`${app.getAppPath()}/package.json`);
        const { reactWorkspaceSession } = require("./dist/main/main/windows/window-state.js");
        return { ready: reactWorkspaceSession.isReady(), pending: reactWorkspaceSession.getPending(), navigation: globalThis.__nativeSmokeNav };
      });
      await workspace.screenshot({ path: path.join(output, "failure.png") });
      throw error;
    }
    const count = await workspace.locator(".cy-message-list__virtual-row").count();
    assert(count > 0 && count < 40, `Unexpected virtual row count: ${count}`);
    report.checks.push(`${mode}: latest message visible; ${count} virtual rows for 400 synthetic messages`);
    if (mode === "work") await workspace.screenshot({ path: path.join(output, "work.png") });
  }
  assert.equal(await chat.locator(".cy-message-list__virtual-list").count(), 0);
  report.checks.push("Chat does not use workspace virtualization");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch((error) => { report.closeError = String(error); });
  try {
    const after = snapshot();
    report.protectedChanges = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((file) => before[file] !== after[file]);
    report.protectedJsonUnchanged = report.protectedChanges.length === 0;
    // The original app may still be running its minute-tick opener. Do not stop it.
    report.protectedContentChanges = report.protectedChanges.filter((file) => path.basename(file) !== "opener-state.json");
    report.protectedContentJsonUnchanged = report.protectedContentChanges.length === 0;
  } catch (error) {
    report.snapshotError = String(error);
  }
  if (report.protectedContentJsonUnchanged !== true) { report.passed = false; process.exitCode = 1; }
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(output, "electron.log"), logs);
  assert.equal(path.dirname(root), runtime);
  assert(path.basename(root).startsWith("native-smoke-") && !fs.lstatSync(root).isSymbolicLink());
  fs.rmSync(root, { recursive: true, force: true });
  if (fs.readdirSync(runtime).length === 0) fs.rmdirSync(runtime);
  console.log(JSON.stringify(report, null, 2));
}
