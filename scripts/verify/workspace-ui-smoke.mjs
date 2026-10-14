import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
assert.equal(path.basename(project), "Cyrene-Agent-N-life-conversation");
const runtime = path.join(project, ".runtime");
fs.mkdirSync(runtime, { recursive: true }); assert(!fs.lstatSync(runtime).isSymbolicLink());
const root = fs.mkdtempSync(path.join(runtime, "workspace-ui-"));
const dirs = Object.fromEntries(["app-data", "local-app-data", "home", "temp", "user-data", "workspace"].map((name) => {
  const directory = path.join(root, name); fs.mkdirSync(directory); return [name, directory];
}));
for (const name of ["Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos"]) fs.mkdirSync(path.join(dirs.home, name));
fs.writeFileSync(path.join(dirs.workspace, "fixture.txt"), "Synthetic file preview\n<script>never execute this</script>");
fs.mkdirSync(path.join(dirs.workspace, "nested")); fs.writeFileSync(path.join(dirs.workspace, "nested", "notes.md"), "# Nested fixture");
const output = path.join(project, "output", "workspace-ui-smoke"); fs.mkdirSync(output, { recursive: true });
function snapshot() {
  const result = {};
  function scan(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) scan(file);
      else if (entry.isFile() && entry.name.endsWith(".json")) result[file] = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    }
  }
  scan(path.join(path.dirname(project), "Cyrene-Agent", "AppData")); scan(path.join(project, "AppData"));
  if (process.env.APPDATA) scan(path.join(process.env.APPDATA, "live2d-cyrene"));
  return result;
}
const before = snapshot();
const env = { ...process.env, APPDATA: dirs["app-data"], LOCALAPPDATA: dirs["local-app-data"], USERPROFILE: dirs.home,
  HOME: dirs.home, TEMP: dirs.temp, TMP: dirs.temp, TMPDIR: dirs.temp, CYRENE_ISOLATED_RUN_ROOT: root };
delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV;
const report = { checks: [], modelCalls: 0, protectedFiles: Object.keys(before).length };
let application;
const pageErrors = [];
let logs = "";
try {
  application = await _electron.launch({ executablePath: createRequire(import.meta.url)("electron"), cwd: project,
    args: [project, `--user-data-dir=${dirs["user-data"]}`], env, timeout: 30000 });
  assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath("userData"))), dirs["user-data"]);
  application.process().stdout?.on("data", (data) => { logs += data; });
  application.process().stderr?.on("data", (data) => { logs += data; });
  application.on("window", (page) => page.on("pageerror", (error) => pageErrors.push(error.message)));
  await application.evaluate(({ session }) => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => callback({ cancel: true }));
  });
  async function pageFor(predicate) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const page = application.windows().find((page) => predicate(page.url()));
      if (page) { await page.waitForLoadState("domcontentloaded"); return page; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Native workspace did not load");
  }
  const chat = await pageFor((url) => url.includes("windowKind=chat"));
  await chat.waitForFunction(() => Boolean(window.chatStore));
  const fixture = await application.evaluate(({ app }, root) => {
    const require = process.getBuiltinModule("module").createRequire(`${app.getAppPath()}/package.json`);
    const store = require("./dist/main/main/chats/chats-store.js");
    const { TaskSessionStore } = require("./dist/main/main/tasks/task-session-store.js");
    const tasks = new TaskSessionStore(app.getPath("userData"));
    const work = store.createSession({ mode: "work", title: "Synthetic workspace" });
    store.setWorkspaceBinding(work.id, { workspaceRoot: root, displayName: "Fixture project", boundAt: Date.now() });
    const task = tasks.create({ parentConversationId: work.id, parentRunId: "synthetic-run", description: "Inspect fixture", prompt: "Synthetic task input", mode: "work", subagentType: "general" });
    tasks.checkpoint(task.id, { status: "completed", messages: [{ role: "user", content: "Synthetic task input" }, { role: "assistant", content: "Synthetic task result" }] });
    store.appendMessage(work.id, { id: "assistant", role: "model", content: "Synthetic answer", at: Date.now(), runActivity: { startedAt: Date.now() - 1000, completedAt: Date.now(), reasoningMs: 0 }, taskDelegations: [{ taskId: task.id, invocationId: "call", description: "Inspect fixture", nickname: "Fixture", assetFileName: "", status: "completed" }] });
    const code = store.createSession({ mode: "code", title: "Synthetic code" });
    store.setWorkspaceBinding(code.id, { workspaceRoot: root, displayName: "Fixture project", boundAt: Date.now() });
    const learn = store.createSession({ mode: "learn", title: "Synthetic learn" });
    store.setWorkspaceBinding(learn.id, { workspaceRoot: root, displayName: "Fixture vault", boundAt: Date.now() });
    return { work: work.id, code: code.id, learn: learn.id };
  }, dirs.workspace);
  await chat.evaluate((id) => window.chatStore.openInReactChatWindow(id), fixture.work);
  const workspace = await pageFor((url) => url.includes("windowKind=workspace"));
  const errors = []; workspace.on("pageerror", (error) => errors.push(error.message));
  await workspace.getByText("Synthetic answer", { exact: true }).waitFor();
  const sidebarFonts = await workspace.locator(".cy-page-newtask .cy-side-action-label").evaluateAll((labels) => labels.map((label) => {
    const style = getComputedStyle(label);
    return { text: label.textContent, family: style.fontFamily, size: style.fontSize, weight: style.fontWeight };
  }));
  assert.equal(sidebarFonts.length, 4);
  for (const label of sidebarFonts.slice(1)) {
    assert.equal(label.family, sidebarFonts[0].family);
    assert.equal(label.size, sidebarFonts[0].size);
    assert.equal(label.weight, sidebarFonts[0].weight);
  }
  assert.equal(await workspace.locator(".cy-organized-heading span[title]").evaluate((label) => getComputedStyle(label).fontFamily), sidebarFonts[0].family);
  report.sidebarFonts = sidebarFonts;
  report.checks.push("Sidebar actions match New's font family, size and weight; project labels use the same family");
  await workspace.locator(".cy-workspace-titlebar").getByRole("button", { name: "文件", exact: true }).click();
  await workspace.getByRole("button", { name: "fixture.txt", exact: true }).click();
  await workspace.getByText("Synthetic file preview", { exact: false }).waitFor();
  await workspace.getByRole("tab", { name: "文件", exact: true }).click();
  await workspace.getByRole("button", { name: "nested", exact: true }).click();
  await workspace.getByRole("button", { name: "notes.md", exact: true }).click();
  await workspace.getByText("# Nested fixture", { exact: true }).waitFor();
  assert.equal(await workspace.getByRole("tab").count(), 3);
  report.checks.push("File tree expands, source is previewed as text, multiple previews stay open");
  const separator = workspace.getByRole("separator", { name: "调整侧面板宽度" });
  await separator.focus(); await separator.press("ArrowLeft");
  assert.equal(await workspace.evaluate(() => localStorage.getItem("cyrene:workspace:inspector-width")), "500");
  await workspace.locator(".cy-run-activity__header").click();
  await workspace.getByRole("button", { name: "任务详情", exact: true }).click();
  await workspace.getByText("Synthetic task result", { exact: true }).waitFor();
  await workspace.screenshot({ path: path.join(output, "work-inspector.png") });
  report.checks.push("Panel resizing persists and task rows open their private transcript");
  await workspace.locator(".cy-workspace-side-action").first().click();
  await workspace.locator(".ant-modal input").fill("Synthetic code");
  await workspace.locator(".cy-workspace-search-result").click();
  await workspace.waitForFunction(() => document.querySelector(".cy-workspace-titlebar strong")?.textContent === "Synthetic code");
  assert.equal(await workspace.locator(".cy-right-inspector").count(), 0);
  report.checks.push("Search switches mode/session and does not show the previous session's panels");
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes("windowKind=workspace"));
    window.webContents.send("permission:approval-request", { id: "synthetic-permission", toolId: "fixture", toolName: "Fixture", toolDescription: "Synthetic confirmation", args: {}, risk: "low" });
  });
  await workspace.getByRole("button", { name: "收起确认卡片", exact: true }).click();
  await workspace.getByRole("button", { name: "展开待处理卡片", exact: true }).click();
  report.checks.push("Pending confirmation collapses and restores without resolving it");
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes("windowKind=workspace"));
    window.webContents.send("permission:approval-settled", { id: "synthetic-permission", reason: "cancelled" }); window.setSize(780, 680);
  });
  await workspace.locator(".cy-workspace-titlebar").getByRole("button", { name: "文件", exact: true }).click();
  await workspace.getByRole("button", { name: "fixture.txt", exact: true }).waitFor();
  await workspace.waitForFunction(() => Number(getComputedStyle(document.querySelector(".cy-right-inspector")).opacity) === 1);
  assert((await workspace.locator(".cy-page-main").boundingBox()).width >= 500, "Inspector must not squeeze the narrow workspace composer");
  report.viewportWidth = await workspace.evaluate(() => innerWidth);
  await workspace.screenshot({ path: path.join(output, "workspace-narrow.png") });
  await chat.evaluate((id) => window.chatStore.openInReactChatWindow(id), fixture.learn);
  await workspace.waitForFunction(() => document.querySelector(".cy-workspace-titlebar strong")?.textContent === "Synthetic learn");
  await workspace.screenshot({ path: path.join(output, "learn-workspace.png") });
  assert.deepEqual(errors, []); report.checks.push("Work/Code/Learn render without page errors, including a narrow window");
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = String(error); report.pageErrors = pageErrors; report.logs = logs.slice(-6000);
  if (application) report.pages = await Promise.all(application.windows().map(async (page) => ({ url: page.url(), text: await page.locator("body").innerText().catch(() => "unavailable") })));
  if (application) await application.windows().find((page) => page.url().includes("windowKind=workspace"))?.screenshot({ path: path.join(output, "failed-workspace.png") }).catch(() => {});
  process.exitCode = 1;
}
finally {
  if (application) await application.close().catch(() => {});
  const after = snapshot(); report.protectedChanges = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((file) => before[file] !== after[file]);
  report.protectedContentChanges = report.protectedChanges.filter((file) => path.basename(file) !== "opener-state.json");
  if (report.protectedContentChanges.length) { report.passed = false; process.exitCode = 1; }
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  assert.equal(path.dirname(root), runtime); assert(path.basename(root).startsWith("workspace-ui-") && !fs.lstatSync(root).isSymbolicLink());
  fs.rmSync(root, { recursive: true, force: true }); console.log(JSON.stringify(report, null, 2));
}
