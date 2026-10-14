import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--live")) throw new Error("Pass --live to authorize one ChatGPT-authenticated Codex test turn.");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = path.join(root, ".test-runtime", `codex-bridge-live-${Date.now()}`);
await mkdir(run, { recursive: true });
const skillDir = path.join(run, ".agents", "skills", "cyrene-bridge-smoke");
await mkdir(skillDir, { recursive: true });
await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: cyrene-bridge-smoke\ndescription: A text-only Cyrene bridge verification skill.\n---\nReply with exactly CYRENE_SKILL_OK. Do not use tools or modify files.\n");
const file = path.join(run, "bridge.cjs");
await build({ stdin: { contents: 'export { CodexBridge, defaults } from "./bridge"; export { AppServerClient } from "./client";', resolveDir: path.join(root, "plugins", "codex-bridge", "src") }, outfile: file, bundle: true, platform: "node", format: "cjs" });
const { CodexBridge, defaults, AppServerClient } = createRequire(import.meta.url)(file);
const data = new Map();
const bridge = new CodexBridge({ rootDir: () => run, get: key => data.get(key), set: (key, value) => data.set(key, structuredClone(value)) });
const timer = setTimeout(() => { bridge.dispose(); console.error("Live test timed out; no retry was submitted."); process.exitCode = 1; }, 120000);
try {
  await bridge.connect({ ...defaults, cwd: run, autoExplain: false }, async config => {
    const client = new AppServerClient(config.executable, config.cwd, message => bridge.event(message), reason => bridge.disconnected(reason));
    await client.initialize(); return client;
  });
  const model = bridge.models.find(model => model.isDefault) ?? bridge.models[0];
  const skill = bridge.skills.find(skill => skill.name === "cyrene-bridge-smoke");
  if (!skill) throw new Error("Isolated project skill was not discovered; no model task submitted.");
  const message = "请执行我选择的测试技能。只输出技能要求的测试标记，不使用工具，不读取或修改文件。";
  const id = await bridge.submit({ message, model: model.model, effort: model.defaultReasoningEffort, skillPath: skill.path, sandbox: "read-only", autoExplain: false });
  while (["submitting", "inProgress", "waiting", "cancelling"].includes(bridge.tasks[0].status)) await new Promise(resolve => setTimeout(resolve, 200));
  const task = bridge.tasks.find(task => task.id === id);
  if (process.argv.includes("--release-test")) {
    while (bridge.connection === "releasing") await new Promise(resolve => setTimeout(resolve, 100));
    if (bridge.connection !== "idle") throw new Error("Server was not released");
    // A separate client must be able to acquire the persisted conversation without a new turn.
    const probe = new AppServerClient("", run, () => {}, () => {});
    try {
      await probe.initialize();
      await probe.request("thread/resume", { threadId: task.threadId });
    } finally { await probe.close(); }
    const nextId = await bridge.submit({ message: "继续测试，仍然只输出技能要求的标记。", model: model.model, effort: model.defaultReasoningEffort, skillPath: skill.path, sandbox: "read-only", autoExplain: false, continueId: id });
    while (["submitting", "inProgress", "waiting", "cancelling"].includes(bridge.tasks[0].status) || bridge.connection === "releasing") await new Promise(resolve => setTimeout(resolve, 200));
    const next = bridge.tasks.find(task => task.id === nextId);
    if (next.status !== "completed" || next.threadId !== task.threadId || next.turnId === task.turnId || bridge.connection !== "idle") throw new Error("Continuation/release failed");
    await writeFile(path.join(run, "release-result.json"), JSON.stringify({ separateClientResumed: true, connection: bridge.connection, tasks: bridge.tasks }, null, 2));
  }
  const receipt = { authentication: bridge.account, skillCount: bridge.skills.length, modelCount: bridge.models.length, task };
  await writeFile(path.join(run, "receipt.json"), JSON.stringify(receipt, null, 2));
  if (task.status !== "completed" || !task.finalText.includes("CYRENE_SKILL_OK")) throw new Error(`Unexpected task status: ${task.status}`);
  console.log(JSON.stringify({ ok: true, authentication: bridge.account, model: model.model, threadId: task.threadId, finalText: task.finalText, skillCount: bridge.skills.length, receipt: path.join(run, "receipt.json") }, null, 2));
} finally { clearTimeout(timer); bridge.dispose(); }
