import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { _electron } from "playwright";

// Developer integration test: only synthetic fixtures in a newly created, isolated profile.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
assert.equal(path.basename(project), "Cyrene-Agent-N-life-conversation");
const runtime = path.join(project, ".runtime");
fs.mkdirSync(runtime, { recursive: true });
assert(!fs.lstatSync(runtime).isSymbolicLink());
const root = fs.mkdtempSync(path.join(runtime, "exam-smoke-"));
const dirs = Object.fromEntries(["app-data", "local-app-data", "home", "temp", "user-data"].map((name) => {
  const dir = path.join(root, name); fs.mkdirSync(dir); return [name, dir];
}));
for (const name of ["Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos"]) fs.mkdirSync(path.join(dirs.home, name));
const output = path.join(project, "output", "learn-exam-smoke");
fs.mkdirSync(output, { recursive: true });
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
  scan(path.join(path.dirname(project), "Cyrene-Agent", "AppData"));
  scan(path.join(project, "AppData"));
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
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const page = application.windows().find((page) => predicate(page.url()));
      if (page) { await page.waitForLoadState("domcontentloaded"); return page; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Expected isolated native window did not load");
  }
  const chat = await waitWindow((url) => url.includes("windowKind=chat"));
  await chat.waitForFunction(() => Boolean(window.chatStore), { timeout: 30000 });
  assert(!fs.existsSync(path.join(dirs["user-data"], "learn-exams")));
  report.checks.push("Ordinary Chat startup does not create exam storage");
  const conversationId = await application.evaluate(({ app }) => {
    const require = process.getBuiltinModule("module").createRequire(`${app.getAppPath()}/package.json`);
    const store = require("./dist/main/main/chats/chats-store.js");
    return store.createSession({ mode: "learn", title: "Synthetic exam session", initialMessages: [] }).id;
  });
  await chat.evaluate((id) => window.chatStore.openInReactChatWindow(id), conversationId);
  const workspace = await waitWindow((url) => url.includes("windowKind=workspace"));
  assert(workspace);
  await workspace.waitForFunction(() => location.search.includes("windowKind=workspace") && Boolean(window.learnExams));
  const examId = await application.evaluate(async ({ app }, conversationId) => {
    const require = process.getBuiltinModule("module").createRequire(`${app.getAppPath()}/package.json`);
    const { toolRegistry } = require("./dist/main/main/orchestrator/tools/registry/tool-registry.js");
    const tools = Object.fromEntries(toolRegistry.getAllTools().map((tool) => [tool.id, tool]));
    const ctx = { mode: "learn", conversationId, runId: "synthetic-exam-run", userQuery: "synthetic exam" };
    const types = ["single_choice", "multiple_choice", "true_false", "fill_blank", "short_answer", "essay"];
    const { draftId } = JSON.parse(await tools.learn_exam_create_plan.execute({ schemaVersion: 1, title: "合成数学试卷", subject: "数学", durationMinutes: 15,
      totalPoints: 30, quotas: types.map((type) => ({ type, count: 1, points: 5, learningObjectives: ["加法"] })) }, ctx));
    for (const type of types) {
      const common = { type, prompt: `题目 ${type}：$1+1$，代码：\n\n\`\`\`js\n1 + 1\n\`\`\``, points: 5, learningObjective: "加法", explanation: "PRIVATE_EXPLANATION" };
      const question = type === "single_choice" ? { ...common, options: ["2", "3"], correctIndex: 0 }
        : type === "multiple_choice" ? { ...common, options: ["2", "1+1", "3"], correctIndexes: [0, 1] }
        : type === "true_false" ? { ...common, correct: true }
        : type === "fill_blank" ? { ...common, blanks: [{ referenceAnswer: "2", rubric: ["PRIVATE_RUBRIC"] }, { referenceAnswer: "4", rubric: ["PRIVATE_RUBRIC"] }] }
        : { ...common, referenceAnswer: "PRIVATE_REFERENCE", rubric: ["PRIVATE_RUBRIC"] };
      const writer = type === "short_answer" || type === "essay" ? tools.learn_exam_add_written : tools[`learn_exam_add_${type}`];
      await writer.execute({ draftId, questions: [question] }, ctx);
    }
    return JSON.parse(await tools.learn_exam_publish.execute({ draftId }, ctx)).examId;
  }, conversationId);
  const exam = await waitWindow((url) => url.includes(examId));
  await exam.waitForFunction(() => document.querySelectorAll(".exam-question").length === 6);
  const capability = await exam.evaluate(async () => ({ generalApi: Boolean(window.chatStore || window.settings || window.agui), safe: JSON.stringify(await window.learnExamPage.getExam()) }));
  assert.equal(capability.generalApi, false); assert(!capability.safe.includes("PRIVATE_"));
  report.checks.push("Sandboxed native exam loads all six types without answer keys or general app APIs");
  assert(await exam.locator(".katex").count() > 0);
  const sections = exam.locator(".exam-question");
  await exam.getByRole("button", { name: "第 3 题", exact: true }).click();
  await sections.nth(2).getByRole("button", { name: "⚑ 待检查", exact: true }).click();
  await exam.getByRole("button", { name: "下一题", exact: true }).click();
  await exam.waitForFunction(async () => {
    const { exam } = await window.learnExamPage.getExam();
    return exam.activeQuestionId === exam.questions[3].id && exam.flaggedQuestionIds.includes(exam.questions[2].id);
  });
  report.checks.push("Navigation and review flags persist through the sandboxed page API");
  await sections.nth(0).locator("input").first().check();
  await sections.nth(1).locator("input").nth(0).check();
  await sections.nth(1).locator("input").nth(1).check();
  await sections.nth(2).locator("input").first().check();
  await sections.nth(3).locator("input").nth(1).fill("4");
  await sections.nth(3).locator("input").first().fill("2");
  await sections.nth(4).locator("textarea").fill("short answer");
  await sections.nth(5).locator("textarea").fill("latest answer immediately before submit");
  await exam.waitForFunction(() => document.querySelector("progress")?.value === 6);
  await exam.getByRole("button", { name: "交卷", exact: true }).click();
  await exam.getByRole("button", { name: "确认交卷", exact: true }).click();
  await exam.getByText("答案已冻结。", { exact: false }).waitFor();
  const frozen = JSON.parse(fs.readFileSync(path.join(dirs["user-data"], "learn-exams", `${examId}.json`), "utf8"));
  assert.equal(frozen.status, "submitted");
  assert.equal(Object.keys(frozen.submittedAnswers).length, 6);
  assert.equal(frozen.submittedAnswers[frozen.questions[5].id].value, "latest answer immediately before submit");
  assert.deepEqual(frozen.submittedAnswers[frozen.questions[3].id].value, ["2", "4"]);
  report.checks.push("Real IPC saves all answers, including last input, before immutable submission");
  await workspace.getByRole("button", { name: "开始批改", exact: true }).waitFor();
  // Deliberately do not click: this smoke test does not call any LLM.
  await application.evaluate(async ({ app }, { examId, conversationId }) => {
    const require = process.getBuiltinModule("module").createRequire(`${app.getAppPath()}/package.json`);
    const { toolRegistry } = require("./dist/main/main/orchestrator/tools/registry/tool-registry.js");
    const tools = Object.fromEntries(toolRegistry.getAllTools().map((tool) => [tool.id, tool]));
    const ctx = { mode: "learn", conversationId, runId: "synthetic-grading", userQuery: "synthetic grading" };
    const paper = JSON.parse(await tools.learn_exam_get_submission.execute({ examId }, ctx));
    await tools.learn_exam_save_grading.execute({ examId, result: { totalScore: 30, summary: "合成评分完成",
      questionResults: paper.questions.map((question) => ({ questionId: question.id, awardedPoints: 5, feedback: "合成反馈" })),
      abilityAnalysis: [{ ability: "加法", score: 30, total: 30, feedback: "合成能力评价" }], nextSteps: ["复习"] } }, ctx);
  }, { examId, conversationId });
  await exam.getByRole("heading", { name: "总分 30 / 30" }).waitFor();
  await exam.screenshot({ path: path.join(output, "graded.png") });
  report.checks.push("Model tool contract publishes grading to native page without a model call");
  await exam.close();
  await workspace.getByRole("button", { name: "打开试卷", exact: true }).click();
  const reopened = await waitWindow((url) => url.includes(examId));
  await reopened.getByRole("heading", { name: "总分 30 / 30" }).waitFor();
  report.checks.push("Closing and reopening restores the frozen answers and grading result");
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack ?? String(error); process.exitCode = 1;
  if (application) report.pages = await Promise.all(application.windows().filter((page) => page.url().startsWith("cyrene-exam:")).map(async (page) => ({
    url: page.url(), text: await page.locator("body").innerText().catch(() => "unavailable"),
    record: await page.evaluate(async () => window.learnExamPage ? await window.learnExamPage.getExam() : null).catch(() => null),
  })));
} finally {
  if (application) await application.close().catch((error) => { report.closeError = String(error); });
  const after = snapshot();
  report.protectedChanges = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((file) => before[file] !== after[file]);
  // The user's original app may update its idle opener state independently. Do not stop it.
  report.protectedContentChanges = report.protectedChanges.filter((file) => path.basename(file) !== "opener-state.json");
  if (report.protectedContentChanges.length) { report.passed = false; process.exitCode = 1; }
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  assert.equal(path.dirname(root), runtime);
  assert(path.basename(root).startsWith("exam-smoke-") && !fs.lstatSync(root).isSymbolicLink());
  fs.rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
