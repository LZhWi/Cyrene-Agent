const { createHash, randomUUID } = require("node:crypto");
const { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, rmdirSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..", "..");
const containerRoot = path.resolve(projectRoot, "..");
const appDataRoot = path.join(containerRoot, "AppData");
const userDataRelative = path.join("Roaming", "live2d-cyrene-n");
const formalMemory = path.join(appDataRoot, userDataRelative, "plugin-data", "companion-memory", "memory-state.json");
const formalVectors = path.join(appDataRoot, userDataRelative, "plugin-data", "companion-memory", "vector-index.json");

function hash(file) { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
function ensureClosed() {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "@(Get-Process -Name electron -ErrorAction SilentlyContinue | Select-Object Id,Path) | ConvertTo-Json -Compress"],
  { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (result.error || result.status !== 0 || result.stderr.trim()) throw new Error("无法确认 Electron 已退出");
  const parsed = result.stdout.trim() ? JSON.parse(result.stdout.trim()) : [];
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (list.some((item) => typeof item?.Path === "string"
    && path.resolve(item.Path).toLowerCase().includes(path.resolve(containerRoot).toLowerCase()))) {
    throw new Error("Cyrene-Agent-N 仍在运行");
  }
}

function hostServices() {
  return { createForPlugin() { return {
    llm: { generateText: async () => { throw new Error("副本验收禁止调用模型"); } },
    secrets: { get: async () => undefined, set: async () => undefined, delete: async () => false },
    conversations: { list: async () => ({ items: [] }), getMessages: async () => ({ items: [] }) },
    assistantDelivery: { postProactiveMessage: async () => { throw new Error("副本验收禁止主动消息"); } },
    screenObservation: { observe: async () => { throw new Error("副本验收禁止屏幕观察"); } },
    userPresence: { snapshot: async () => ({ at: new Date(0).toISOString(), idleSeconds: 0, screenLocked: false }) },
    weatherContext: { snapshot: async () => null },
    memoryRetrieval: {
      embed: async () => { throw new Error("副本验收不生成向量"); },
      rank: async ({ candidates, topK }) => ({
        rankedIds: candidates.slice(0, topK).map((candidate) => candidate.id),
        vectorHitIds: candidates.slice(0, topK * 3).map((candidate) => candidate.id),
      }),
    },
  }; } };
}

async function main() {
  ensureClosed();
  if (path.basename(projectRoot) !== ".upstream-latest" || path.basename(containerRoot) !== "Cyrene-Agent-N") {
    throw new Error("项目边界不符");
  }
  for (const file of [formalMemory, formalVectors]) {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`正式导入文件无效: ${file}`);
  }
  const before = { memory: hash(formalMemory), vectors: hash(formalVectors) };
  const runRoot = path.join(containerRoot, ".formal-import-verification", `run-${randomUUID()}`);
  const copiedAppData = path.join(runRoot, "AppData");
  mkdirSync(runRoot, { recursive: true });
  cpSync(appDataRoot, copiedAppData, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
  try {
    const copiedUserData = path.join(copiedAppData, userDataRelative);
    const pluginRoot = path.join(copiedUserData, "plugins");
    const storageRoot = path.join(copiedUserData, "plugin-data");
    const { PluginManager } = require(path.join(projectRoot, "dist", "main", "plugins", "manager.js"));
    const { createPluginPromptRegistry } = require(path.join(projectRoot, "dist", "main", "plugins", "prompts.js"));
    const promptRegistry = createPluginPromptRegistry();
    const ipc = new Map();
    const manager = new PluginManager({
      scanRoots: [{ path: pluginRoot, source: "user" }], storageRoot,
      runtime: {
        toolRegistry: { register: () => undefined, unregister: () => true },
        channelManager: { has: () => false, register: () => undefined, unregister: async () => true, startOne: async () => undefined },
        registerIpc: (channel, handler) => ipc.set(channel, handler),
        unregisterIpc: (channel) => ipc.delete(channel), promptRegistry, hostServices: hostServices(),
      },
      loadEnabledMap: () => ({ "companion-memory": true, "companion-chat": false }), saveEnabledMap: () => undefined,
    });
    await manager.start();
    try {
      const handler = ipc.get("plugin:companion-memory:ui");
      if (!handler) throw new Error("记忆插件 IPC 未注册");
      const invoke = async (action, data) => {
        const result = await handler(action, data);
        if (result?.ok !== true) throw new Error(`${action}: ${result?.error || "失败"}`);
        return result.data;
      };
      const initial = await invoke("state");
      const probe = initial.entries.find((entry) => entry.status === "active" && !entry.pinned
        && !entry.supersededBy && !entry.mergedInto);
      if (!probe?.content) throw new Error("导入库没有可检索 active 记忆");
      const query = probe.content.slice(0, 80);
      const manual = await invoke("search", query);
      const knownIds = new Set(initial.entries.map((entry) => entry.id));
      const recalledIds = typeof manual === "string"
        ? [...manual.matchAll(/\[记忆 ([^；\]]+)；/g)].map((match) => match[1]) : [];
      if (recalledIds.length === 0 || recalledIds.some((id) => !knownIds.has(id))) {
        throw new Error("词面检索没有返回可核验的正式记忆 ID");
      }
      await invoke("save-native-integration", {
        captureEnabled: false, autoExtractEnabled: false, promptInjectionEnabled: true,
        momentsInjectionEnabled: false, socialContextEnabled: false,
      });
      await invoke("dmae", true);
      const runId = `copy-verify-${randomUUID()}`;
      const detailed = await promptRegistry.buildDetailed({
        source: "conversation", mode: "chat", chatBackend: "companion", userText: query,
        conversationId: "copy-verification", runId, timezone: "Asia/Shanghai",
      });
      if (!detailed.content.includes("plugin:companion-memory:memory-context")
        || !detailed.content.includes(`[记忆 ${recalledIds[0]}；`) || detailed.receipts.length !== 1) {
        throw new Error("Prompt 注入或消费回执不完整");
      }
      const copyDmae = path.join(storageRoot, "companion-memory", "dmae-state.json");
      const copyBeforeReceipt = existsSync(copyDmae) ? hash(copyDmae) : null;
      await manager.publishHostEvent("prompt:accepted", {
        runId, providerId: "plugin:companion-memory:memory-context", complete: true,
      });
      await manager.publishHostEvent("turn:finished", {
        eventId: `event-${runId}`, runId, mode: "chat", source: "desktop", chatBackend: "companion",
        status: "success", conversationId: "copy-verification", inputMessageId: "input-copy",
        finalMessageId: "final-copy", timestamp: new Date().toISOString(),
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const copyAfterReceipt = existsSync(copyDmae) ? hash(copyDmae) : null;
      const receiptCommittedInCopy = copyAfterReceipt !== null && copyBeforeReceipt !== copyAfterReceipt;
      if (!receiptCommittedInCopy) throw new Error("成功回执没有在副本中提交 DMAE 工作集");
      const vector = JSON.parse(readFileSync(path.join(storageRoot, "companion-memory", "vector-index.json"), "utf8"));
      const ids = new Set(initial.entries.map((entry) => entry.id));
      if (vector.entries.length !== 122 || vector.dimensions !== 1024
        || vector.entries.some((entry) => !ids.has(entry.l2Id) || entry.embedding.length !== 1024)) {
        throw new Error("导入向量结构或 L2 对应关系不完整");
      }
      const after = { memory: hash(formalMemory), vectors: hash(formalVectors) };
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("正式导入库在副本验收期间发生变化");
      console.log(JSON.stringify({
        ok: true, formalDataUnchanged: true, lexicalRecall: true, promptInjection: true,
        receiptCommittedInCopy,
        entries: initial.entries.length, evidence: initial.evidence.length,
        vectors: vector.entries.length, dimensions: vector.dimensions,
        resultDigest: createHash("sha256").update(manual).digest("hex"),
      }, null, 2));
    } finally {
      await manager.stop();
    }
  } finally {
    rmSync(runRoot, { recursive: true, force: false });
    const parent = path.dirname(runRoot);
    if (existsSync(parent) && require("node:fs").readdirSync(parent).length === 0) rmdirSync(parent);
  }
}

main().catch((error) => {
  console.error(`[formal-companion-verify] ${error?.stack || error}`);
  process.exitCode = 1;
});
