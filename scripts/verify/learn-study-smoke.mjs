import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { _electron } from "playwright";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
assert.equal(path.basename(project), "Cyrene-Agent-N-life-conversation");
const runtime = path.join(project, ".runtime");
fs.mkdirSync(runtime, { recursive: true }); assert(!fs.lstatSync(runtime).isSymbolicLink());
const root = fs.mkdtempSync(path.join(runtime, "learn-study-smoke-"));
const dirs = Object.fromEntries(["app-data", "local-app-data", "home", "temp", "user-data", "vault-a", "vault-b"].map((name) => {
  const dir = path.join(root, name); fs.mkdirSync(dir); return [name, dir];
}));
for (const name of ["Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos"]) fs.mkdirSync(path.join(dirs.home, name));
const output = path.join(project, "output", "learn-study-smoke"); fs.mkdirSync(output, { recursive: true });
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
  scan(path.join(path.dirname(project), "Cyrene-Agent", "AppData")); scan(path.join(project, "AppData"));
  if (process.env.APPDATA) scan(path.join(process.env.APPDATA, "live2d-cyrene"));
  return files;
}
const before = snapshot();
const env = { ...process.env, APPDATA: dirs["app-data"], LOCALAPPDATA: dirs["local-app-data"], USERPROFILE: dirs.home,
  HOME: dirs.home, TEMP: dirs.temp, TMP: dirs.temp, TMPDIR: dirs.temp, CYRENE_ISOLATED_RUN_ROOT: root };
delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV;
const report = { checks: [], protectedFiles: Object.keys(before).length, modelCalls: 0 };
let application;
try {
  application = await _electron.launch({ executablePath: createRequire(import.meta.url)("electron"), cwd: project,
    args: [project, `--user-data-dir=${dirs["user-data"]}`], env, timeout: 30000 });
  assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath("userData"))), dirs["user-data"]);
  await application.evaluate(({ session }) => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => callback({ cancel: true }));
  });
  async function waitWindow(predicate) {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const page = application.windows().find((page) => predicate(page.url()));
      if (page) { await page.waitForLoadState("domcontentloaded"); return page; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Expected isolated native window did not load");
  }
  const chat = await waitWindow((url) => url.includes("windowKind=chat"));
  await chat.waitForFunction(() => Boolean(window.chatStore));
  assert.equal(await chat.locator(".cy-learn-study").count(), 0);
  assert(!fs.existsSync(path.join(dirs["user-data"], "learn-exams")));
  report.checks.push("Chat startup shows no learning panel and creates no Learn storage");
  const conversationId = await application.evaluate(async ({ app }, vault) => {
    const require = process.getBuiltinModule("module").createRequire(`${app.getAppPath()}/package.json`);
    const fs = require("node:fs"); const path = require("node:path");
    const store = require("./dist/main/main/chats/chats-store.js");
    const session = store.createSession({ mode: "learn", title: "合成学习验证", initialMessages: [] });
    store.setWorkspaceBinding(session.id, { workspaceRoot: vault, displayName: "合成 Vault", boundAt: Date.now() });
    fs.mkdirSync(path.join(vault, "materials")); fs.writeFileSync(path.join(vault, "materials/addition.md"), "# 加法\n两个一组成二。\n");
    const { LearnReviewService } = require("./dist/main/main/learn/study/review-service.js");
    const { contentHash } = require("./dist/main/main/learn/obsidian/obsidian-markdown.js");
    const reviews = new LearnReviewService(vault);
    await reviews.record({ question: { type: "choice", question: "1+1 的结果？", options: ["2", "3"], correctIndex: 0, learningObjective: "加法", explanation: "两个一组成二。" },
      source: { file: "materials/addition.md", quote: "两个一组成二。", contentHash: contentHash(fs.readFileSync(path.join(vault, "materials/addition.md"), "utf8")) },
      origin: "quiz", attempt: { id: "synthetic-first", at: new Date(Date.now() - 2 * 86400000).toISOString(), result: "incorrect", answer: 1, feedback: "需复习", grader: "local" } });
    return session.id;
  }, dirs["vault-a"]);
  await chat.evaluate((id) => window.chatStore.openInReactChatWindow(id), conversationId);
  const workspace = await waitWindow((url) => url.includes("windowKind=workspace"));
  await workspace.waitForFunction(() => Boolean(window.learnStudy) && Boolean(document.querySelector(".cy-learn-study")));
  await workspace.locator(".cy-learn-study > summary").click();
  await workspace.getByRole("button", { name: "复习这道题", exact: true }).waitFor();
  assert.equal((await workspace.evaluate((id) => window.learnStudy.overview(id), conversationId)).dueCount, 1);
  const denied = await chat.evaluate(async (id) => { try { await window.learnStudy.overview(id); return false; } catch { return true; } }, conversationId);
  assert(denied); report.checks.push("Learn management API rejects the ordinary Chat window");
  await workspace.getByRole("button", { name: "复习这道题", exact: true }).click();
  await workspace.locator('.cy-learn-study__question input[type="radio"]').first().check();
  await workspace.getByRole("button", { name: "提交复习作答", exact: true }).click();
  await workspace.getByRole("status").filter({ hasText: "答对：两个一组成二" }).waitFor();
  const assessed = await workspace.evaluate((id) => window.learnStudy.overview(id), conversationId);
  assert.equal(assessed.dueCount, 0); assert.equal(assessed.reviews[0].attemptCount, 2);
  report.checks.push("Actual native review submission persists evidence and schedules the next review");
  const videoBytes = await workspace.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext("2d"); const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
    const chunks = []; recorder.ondataavailable = (event) => chunks.push(event.data);
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    const timer = setInterval(() => { context.fillStyle = "#554477"; context.fillRect(0, 0, 320, 180); context.fillStyle = "white"; context.font = "24px sans-serif"; context.fillText("Synthetic course", 30, 90); }, 100);
    recorder.start(); await new Promise((resolve) => setTimeout(resolve, 2200)); recorder.stop(); await stopped;
    clearInterval(timer); stream.getTracks().forEach((track) => track.stop());
    return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
  });
  fs.writeFileSync(path.join(dirs["vault-a"], "course.webm"), Buffer.from(videoBytes));
  fs.writeFileSync(path.join(dirs["vault-a"], "course.srt"), "1\n00:00:01,000 --> 00:00:02,000\n合成课程字幕\n");
  const mediaBefore = crypto.createHash("sha256").update(fs.readFileSync(path.join(dirs["vault-a"], "course.webm"))).digest("hex");
  await application.evaluate(({ dialog }, files) => {
    const choices = [...files]; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [choices.shift()] });
  }, [path.join(dirs["vault-a"], "course.webm"), path.join(dirs["vault-a"], "course.srt")]);
  await workspace.getByRole("button", { name: "选择 Vault 内视频", exact: true }).click();
  await workspace.waitForFunction(() => { const video = document.querySelector(".cy-learn-study video"); return video && video.readyState >= 2; });
  await workspace.locator(".cy-learn-study video").evaluate(async (video) => { await video.play(); });
  await workspace.waitForFunction(() => document.querySelector(".cy-learn-study video").currentTime > .3);
  await workspace.locator(".cy-learn-study video").evaluate((video) => video.pause());
  await workspace.getByRole("textbox", { name: "时间点笔记" }).fill("这里是合成时间点笔记");
  await workspace.getByRole("button", { name: "保存当前时间点笔记", exact: true }).click();
  await workspace.getByText("这里是合成时间点笔记", { exact: true }).waitFor();
  await workspace.getByRole("button", { name: "导入 SRT/VTT 字幕", exact: true }).click();
  await workspace.getByRole("button", { name: "00:00:01 · 字幕", exact: true }).click();
  await workspace.waitForFunction(() => Math.abs(document.querySelector(".cy-learn-study video").currentTime - 1) < .2);
  const bounds = await workspace.evaluate(() => {
    const panel = document.querySelector(".cy-learn-exams").getBoundingClientRect();
    const task = document.querySelector(".cy-todo")?.getBoundingClientRect();
    return { right: panel.right, taskLeft: task?.left };
  });
  if (bounds.taskLeft !== undefined) assert(bounds.right <= bounds.taskLeft, "Learning controls overlap the task panel");
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(dirs["vault-a"], "course.webm"))).digest("hex"), mediaBefore);
  await workspace.screenshot({ path: path.join(output, "learn-panel.png") });
  report.checks.push("Native video decoding, range playback, timestamp notes, subtitle import and seek work without task-panel overlap");
  await workspace.reload(); await workspace.locator(".cy-learn-study > summary").waitFor(); await workspace.locator(".cy-learn-study > summary").click();
  await workspace.getByText("这里是合成时间点笔记", { exact: true }).waitFor();
  assert.equal((await workspace.evaluate((id) => window.learnStudy.overview(id), conversationId)).reviews[0].attemptCount, 2);
  const oldUrl = (await workspace.evaluate((id) => window.learnStudy.videos(id), conversationId))[0].url;
  await application.evaluate(({ app, BrowserWindow }, { conversationId, root }) => {
    const require = process.getBuiltinModule("module").createRequire(`${app.getAppPath()}/package.json`);
    require("./dist/main/main/chats/chats-store.js").setWorkspaceBinding(conversationId, { workspaceRoot: root, displayName: "合成 B", boundAt: Date.now() });
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send("chats:workspace-changed", { sessionId: conversationId, binding: { workspaceRoot: root, displayName: "合成 B", boundAt: Date.now() } });
  }, { conversationId, root: dirs["vault-b"] });
  const afterSwitch = await workspace.evaluate(async ({ id, oldUrl }) => {
    let status;
    try { status = (await fetch(oldUrl)).status; } catch { status = "blocked"; }
    return { overview: await window.learnStudy.overview(id), videos: await window.learnStudy.videos(id), status };
  }, { id: conversationId, oldUrl });
  assert.equal(afterSwitch.overview.reviews.length, 0); assert.equal(afterSwitch.videos.length, 0); assert([403, "blocked"].includes(afterSwitch.status));
  assert.equal(fs.readdirSync(dirs["vault-b"]).length, 0);
  await workspace.waitForFunction(() => !document.querySelector(".cy-learn-study video") && !document.querySelector(".cy-learn-study__question"));
  report.checks.push("Reload restores learning files; switching Vault hides old records and revokes old media URLs");
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack ?? String(error); process.exitCode = 1;
  if (application) report.pages = await Promise.all(application.windows().filter((page) => page.url().includes("windowKind=workspace")).map(async (page) => ({ url: page.url(), text: await page.locator("body").innerText().catch(() => "unavailable") })));
} finally {
  if (application) await application.close().catch((error) => { report.closeError = String(error); });
  const after = snapshot();
  report.protectedChanges = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((file) => before[file] !== after[file]);
  report.protectedContentChanges = report.protectedChanges.filter((file) => path.basename(file) !== "opener-state.json");
  if (report.protectedContentChanges.length) { report.passed = false; process.exitCode = 1; }
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  assert.equal(path.dirname(root), runtime); assert(path.basename(root).startsWith("learn-study-smoke-") && !fs.lstatSync(root).isSymbolicLink());
  fs.rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
