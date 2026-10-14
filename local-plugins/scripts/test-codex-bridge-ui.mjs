import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = path.join(root, ".test-runtime", `codex-bridge-ui-${Date.now()}`);
await mkdir(run, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1080, height: 900 }, deviceScaleFactor: 1 });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const config = { executable: "", cwd: "E:\\Projects\\demo", model: "test-model", effort: "high", skillPath: "", sandbox: "read-only", autoExplain: true };
    const state = { config, connection: "connected", account: { type: "chatgpt", planType: "测试数据" },
      models: [{ model: "test-model", displayName: "Codex 测试模型", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] }],
      skills: [{ name: "pdf", path: "E:\\skills\\pdf\\SKILL.md", enabled: true, description: "读取、创建并验证 PDF 文件。" }], skillErrors: [], prompts: [], tasks: [{
        id: "demo-task", createdAt: new Date().toISOString(), config, message: "检查项目文档，列出需要补充的内容。", status: "completed", threadId: "demo-thread",
        finalText: "已完成文档检查。发现两处需要补充：\n1. 安装步骤缺少运行时版本。\n2. 测试章节未说明如何运行单元测试。\n本次只读检查，没有修改文件。", progress: "", diff: "",
        explanation: "文档检查完成了。安装环境和测试方法各有一处说明需要补齐，原文件没有改动。你可以继续这项任务，让 Codex 起草补充内容。",
      }] };
    window.codexBridge = { invoke: async action => action === "state" ? { ok: true, data: structuredClone(state) } : { ok: false, error: "静态验证不执行任务" } };
  });
  await page.goto(pathToFileURL(path.join(root, "plugins", "codex-bridge", "static", "ui.html")).href);
  await page.getByText("Codex 原始回执", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(run, "desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 760, height: 780 });
  await page.screenshot({ path: path.join(run, "narrow.png"), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (errors.length || overflow) throw new Error(JSON.stringify({ errors, overflow }));
  await writeFile(path.join(run, "result.json"), JSON.stringify({ ok: true, errors, overflow, mockedProtocol: true, browserOnly: true }));
  console.log(`Browser visual checks passed: ${run}`);
} finally { await browser.close(); }
