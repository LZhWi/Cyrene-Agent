// Snapshot-only source reads; all conversion happens in ignored staging before an atomic target swap.
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "../..");
if (path.basename(root) !== "Cyrene-Agent-N-life-conversation") throw new Error("Wrong checkout");
const target = path.join(root, "AppData/Roaming/live2d-cyrene-n");
const original = path.join(process.env.APPDATA, "live2d-cyrene");
const old = path.join(path.dirname(root), "Cyrene-Agent-N/AppData/Roaming/live2d-cyrene-n");
const apply = process.argv.includes("--apply");
const run = path.join(root, ".runtime/migrations", `${Date.now()}-${randomUUID()}`);
const stage = path.join(run, "candidate");
const snapshot = path.join(run, "original");
const sourceHashes = new Map();
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fileHash = (file) => hash(fs.readFileSync(file));
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
};
function ordinary(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())
    || fs.realpathSync(file).toLowerCase() !== path.resolve(file).toLowerCase()) throw new Error("Non-ordinary path: " + file);
}
function files(directory) {
  ordinary(directory, true);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return files(file);
    ordinary(file);
    return [file];
  });
}
function copySource(source, destination) {
  ordinary(source);
  const bytes = fs.readFileSync(source), before = hash(bytes);
  if (sourceHashes.has(source) && sourceHashes.get(source) !== before) throw new Error("Source changed while snapshotting");
  sourceHashes.set(source, before);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes);
  if (fileHash(destination) !== before) throw new Error("Snapshot copy mismatch");
}
function copyTree(source, destination) {
  if (!fs.existsSync(source)) return;
  for (const file of files(source)) copySource(file, path.join(destination, path.relative(source, file)));
}
function unchanged() {
  for (const [file, expected] of sourceHashes) if (fileHash(file) !== expected) throw new Error("Source changed; no target swap: " + file);
}
function noTargetElectron() {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "@(Get-Process -Name electron -ErrorAction SilentlyContinue | Select-Object Id,Path) | ConvertTo-Json -Compress"],
  { encoding: "utf8", windowsHide: true, timeout: 10000 });
  if (result.error || result.status !== 0) throw new Error("Cannot inspect running Electron processes");
  const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : [], list = Array.isArray(parsed) ? parsed : [parsed];
  if (list.some((item) => item.Path?.toLowerCase().startsWith(root.toLowerCase() + path.sep))) throw new Error("Target app is running");
}
let forbiddenCalls = 0;
const forbidden = async () => { forbiddenCalls++; throw new Error("Migration forbids external model, embedding, delivery and observation calls"); };
function services() {
  const secrets = new Map();
  return { createForPlugin: () => ({ llm: { generateText: forbidden },
    secrets: { get: async (key) => secrets.get(key), set: async (key, value) => secrets.set(key, value), delete: async (key) => secrets.delete(key) },
    conversations: { list: async () => ({ items: [] }), getMessages: async () => ({ items: [] }) },
    assistantDelivery: { postProactiveMessage: forbidden }, screenObservation: { observe: forbidden },
    userPresence: { snapshot: async () => ({ at: new Date(0).toISOString(), idleSeconds: 0, screenLocked: false }) },
    weatherContext: { snapshot: async () => null }, companionContext: { snapshot: async () => ({ items: [] }) },
    memoryRetrieval: { embed: forbidden, rank: forbidden } }) };
}
async function memoryHost(importData) {
  const { PluginManager } = require(path.join(root, "dist/main/plugins/manager.js"));
  const { createPluginPromptRegistry } = require(path.join(root, "dist/main/plugins/prompts.js"));
  const ipc = new Map(), manager = new PluginManager({
    scanRoots: [{ path: path.join(stage, "plugins"), source: "user" }], storageRoot: path.join(stage, "plugin-data"),
    runtime: { toolRegistry: { register: () => undefined, unregister: () => true },
      channelManager: { has: () => false, register: () => undefined, unregister: async () => true, startOne: async () => undefined },
      registerIpc: (channel, handler) => ipc.set(channel, handler), unregisterIpc: (channel) => ipc.delete(channel),
      promptRegistry: createPluginPromptRegistry(), hostServices: services() },
    loadEnabledMap: () => ({ "companion-memory": true }), saveEnabledMap: () => undefined });
  await manager.start();
  try {
    const invoke = async (action, data) => {
      const handler = ipc.get("plugin:companion-memory:ui");
      if (!handler) throw new Error("Memory IPC missing");
      const result = await handler(action, data);
      if (!result?.ok) throw new Error(action + ": " + result?.error);
      return result.data;
    };
    if (importData) {
      const sourcePath = path.join(snapshot, "memory.json"), preview = await invoke("preview-legacy-import", { sourcePath });
      if (!preview.canImport) throw new Error("Memory preflight failed");
      const before = await invoke("state");
      if (before.entries.length || before.evidence.length || before.revision !== 0) throw new Error("Target memory is not empty");
      await invoke("import-legacy", { sourcePath, sourceHash: preview.sourceHash, revision: before.revision, sourceAttested: false, preserveRuntime: true });
      const vectorPath = path.join(snapshot, "rag-data/memory-store.json");
      const vectors = await invoke("preview-legacy-vectors", { sourcePath: vectorPath });
      if (!vectors.canImport) throw new Error("Vector preflight failed");
      await invoke("import-legacy-vectors", { sourcePath: vectorPath, sourceHash: vectors.sourceHash });
    }
    const view = await invoke("state");
    return { entries: view.entries.length, evidence: view.evidence.length, vectors: view.vectorIndex.entries,
      revision: view.revision, runtimePreserved: view.legacyImport.runtimePreserved, sourceAttested: view.legacyImport.sourceAttested };
  } finally { await manager.stop(); }
}
async function helpers() {
  const esbuild = require(path.join(root, "local-plugins/node_modules/esbuild"));
  const outfile = path.join(run, "helpers.cjs");
  await esbuild.build({ stdin: { contents: [
    'export {historyIndexText} from "./src/main/chats/history-index-text";',
    'export {stripAssistantHiddenText} from "./local-plugins/plugins/companion-memory/src/derived-text";',
    'export {createHistoryRetrieval} from "./local-plugins/plugins/companion-memory/src/history-retrieval";',
    'export {createEntityGraph} from "./local-plugins/plugins/companion-memory/src/entity-graph";'
  ].join("\n"), resolveDir: root, loader: "ts" }, bundle: true, platform: "node", format: "cjs", outfile,
  plugins: [{ name: "electron-stub", setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: 'export const app={getPath:()=>globalThis.__migrationUserData};', loader: "js" }));
  } }] });
  global.__migrationUserData = stage;
  return require(outfile);
}
function migrateIndexes(helper, rag, sourceIndex) {
  const recalls = {}, vectors = {}, messages = [];
  let images = 0, reused = 0;
  const recall = (entry, at) => ({ weight: Math.max(1, Math.min(5, Number.isFinite(entry?.weight) ? entry.weight : 1)),
    lastRecalledAt: Number.isFinite(entry?.lastRecalledAt) ? entry.lastRecalledAt : at });
  for (const meta of sourceIndex) {
    const source = json(path.join(snapshot, "cyrene-chats/sessions", meta.id + ".json"));
    const file = path.join(stage, "cyrene-chats/sessions", meta.id + ".json"), session = json(file);
    for (let i = 0; i < session.messages.length; i++) {
      const message = session.messages[i], oldMessage = source.messages[i];
      const projection = helper.historyIndexText(message);
      const text = (message.role === "model" ? helper.stripAssistantHiddenText(projection) : projection).trim();
      const role = message.role === "model" ? "assistant" : "user", id = `host-message:${session.id}:${message.id}`;
      const entry = rag.find((item) => item.source === "chat_history" && item.text.trim() === text
        && (item.metadata?.occurrences ?? [item.metadata]).some((occurrence) => occurrence?.sessionId === session.id
          && occurrence.role === role && (occurrence.turnId ? occurrence.turnId === message.id : occurrence.ts === message.at)));
      recalls[id] = recall(entry, message.at);
      if (entry?.embedding?.length && entry.embedding.every(Number.isFinite)) { vectors[id] = { text, embedding: entry.embedding }; reused++; }
      let imageIndex = 0;
      const projected = [];
      for (let j = 0; j < (message.attachments?.length ?? 0); j++) {
        const attachment = message.attachments[j], oldAttachment = oldMessage.attachments[j];
        if (attachment.kind !== "image") continue;
        const imageKey = hash(`${j}\0${oldAttachment.filePath}`);
        const visual = rag.find((item) => item.source === "chat_image" && item.metadata?.sessionId === session.id
          && item.metadata.turnId === message.id && item.metadata.imageKey === imageKey);
        if (visual) {
          const prefix = `图片 ${visual.metadata.name}。画面内容：`;
          if (!visual.text.startsWith(prefix)) throw new Error("Unexpected visual index text");
          attachment.visualIndexCaption = visual.text.slice(prefix.length);
          attachment.visualIndexSummary = visual.metadata.summary;
          attachment.visualIndexedAt = visual.createdAt;
          images++;
        }
        const caption = attachment.visualIndexCaption?.trim() || attachment.caption?.trim();
        if (caption) {
          recalls[`host-image:${session.id}:${message.id}:${imageIndex++}`] = recall(visual, attachment.visualIndexedAt ?? message.at);
          projected.push({ name: attachment.name, caption, summary: attachment.visualIndexSummary, indexedAt: attachment.visualIndexedAt });
        }
      }
      messages.push({ id: message.id, sessionId: session.id, role, text, at: message.at, images: projected });
    }
    write(file, session);
  }
  const privateRoot = path.join(stage, "plugin-data/companion-memory");
  write(path.join(privateRoot, "history-retrieval-recall-state.json"), { version: 1, entries: recalls });
  write(path.join(privateRoot, "history-retrieval-vector-index.json"), { version: 1, entries: vectors });
  const storage = { get: (key) => { const file = path.join(privateRoot, key + ".json"); return fs.existsSync(file) ? json(file) : undefined; },
    set: () => { throw new Error("Readback must not write"); } };
  helper.createHistoryRetrieval({ turns: () => [], storage });
  helper.createEntityGraph(storage);
  return { imageIndexes: images, historyVectorsReused: reused, recallStates: Object.keys(recalls).length, hostMessages: messages.length };
}
async function main() {
  noTargetElectron(); ordinary(target, true); ordinary(original, true); ordinary(old, true);
  if (fs.existsSync(path.join(target, "plugin-data/companion-memory/memory-state.json"))) throw new Error("Existing memory; refuse duplicate import");
  fs.mkdirSync(run, { recursive: true });
  // A full independent target backup also preserves current Work/Code and new plugin settings.
  const targetHashes = new Map(files(target).map((file) => [path.relative(target, file), fileHash(file)]));
  fs.cpSync(target, stage, { recursive: true, preserveTimestamps: true });
  for (const relative of ["memory.json", "rag-data/memory-store.json", "entity-graph.json", "cyrene-chats/index.json"])
    copySource(path.join(original, relative), path.join(snapshot, relative));
  const sourceIndex = json(path.join(snapshot, "cyrene-chats/index.json"));
  for (const meta of sourceIndex) {
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(meta.id)) throw new Error("Invalid session ID");
    const relative = path.join("cyrene-chats/sessions", meta.id + ".json");
    copySource(path.join(original, relative), path.join(snapshot, relative));
    const session = json(path.join(snapshot, relative));
    for (const message of session.messages) for (const attachment of message.attachments ?? []) {
      if (attachment.filePath && fs.existsSync(attachment.filePath)) {
        ordinary(attachment.filePath); sourceHashes.set(attachment.filePath, fileHash(attachment.filePath));
      }
    }
  }
  const configFiles = ["agent-permission.json", "channels-settings.json", "model-settings.json", "timeout-settings.json", "user-profile.json", "avatar.png"];
  for (const file of configFiles) if (fs.existsSync(path.join(old, file))) copySource(path.join(old, file), path.join(stage, file));
  const profileFile = path.join(stage, "user-profile.json");
  if (fs.existsSync(profileFile)) {
    const profile = json(profileFile);
    if (profile.avatarPath && path.resolve(profile.avatarPath).toLowerCase() === path.join(old, "avatar.png").toLowerCase()) {
      profile.avatarPath = path.join(target, "avatar.png");
      write(profileFile, profile);
    }
  }
  for (const dir of ["skills", "music"]) copyTree(path.join(old, dir), path.join(stage, dir));
  const settingsFile = path.join(old, "app-settings.json");
  copySource(settingsFile, path.join(run, "old-app-settings.json"));
  const current = json(path.join(stage, "app-settings.json")), previous = json(settingsFile);
  write(path.join(stage, "app-settings.json"), { ...current, ...previous,
    plugins: { ...current.plugins, ...previous.plugins }, chatBackend: "companion" });
  const oldMemory = path.join(old, "plugin-data/companion-memory");
  for (const file of fs.readdirSync(oldMemory)) if (/^(auto-.*-enabled|dmae-enabled|semantic-index-settings|native-integration-settings)\.json$/.test(file))
    copySource(path.join(oldMemory, file), path.join(stage, "plugin-data/companion-memory", file));
  for (const file of ["memory-link.json", "screen-monitor-settings.json"])
    if (fs.existsSync(path.join(old, "plugin-data/companion-chat", file))) copySource(path.join(old, "plugin-data/companion-chat", file), path.join(stage, "plugin-data/companion-chat", file));
  const { preparePluginZip, commitPreparedPlugin } = require(path.join(root, "dist/main/plugins/installer.js"));
  for (const name of ["companion-memory", "companion-chat"]) {
    const prepared = await preparePluginZip(path.join(root, "local-plugins/artifacts", name + ".zip"), path.join(stage, "plugins"));
    await commitPreparedPlugin(prepared, path.join(stage, "plugins"), true);
  }
  const memoryRoot = path.join(stage, "plugin-data/companion-memory");
  // Preserve the enabled preference, but establish its baseline only after importing the new source.
  const semanticFile = path.join(memoryRoot, "semantic-index-settings.json");
  const semanticSettings = fs.existsSync(semanticFile) ? json(semanticFile) : { enabled: false };
  write(semanticFile, { enabled: false });
  const imported = await memoryHost(true);
  const state = json(path.join(memoryRoot, "memory-state.json"));
  write(path.join(memoryRoot, "semantic-index-baseline.json"), { version: 1,
    hashes: Object.fromEntries(state.entries.map((entry) => [entry.id, hash(entry.content)])) });
  write(semanticFile, semanticSettings);
  const reopened = await memoryHost(false);
  if (JSON.stringify(imported) !== JSON.stringify(reopened)) throw new Error("Memory restart mismatch");
  const archive = json(path.join(memoryRoot, "legacy-memory-archive.json")), sourceMemory = json(path.join(snapshot, "memory.json"));
  if (JSON.stringify(archive.raw) !== JSON.stringify(sourceMemory)) throw new Error("Full-field archive mismatch");
  if (state.turns.length || state.processed.length) throw new Error("Unverified extraction queued");
  if (state.legacyRuntime.dmae.round !== sourceMemory.l2DmaeRound
    || JSON.stringify(state.legacyRuntime.dmae.states) !== JSON.stringify(sourceMemory.l2DmaeStates)
    || sourceMemory.l2.some((entry) => {
      const recall = state.legacyRuntime.lifecycle.recalls[entry.id];
      return !recall || recall.lastHitAt !== entry.lastAccessedAt || recall.hitCount !== entry.accessCount || recall.weight !== entry.weight;
    })) throw new Error("Lifecycle/DMAE values changed");
  const { migrateChatHistory, verifyChatHistory } = await import(pathToFileURL(path.join(root, "local-plugins/scripts/import-legacy-chat-history.mjs")));
  migrateChatHistory({ source: path.join(snapshot, "cyrene-chats"), target: path.join(stage, "cyrene-chats"), apply: true,
    backupRoot: path.join(run, "chat-backup"), reportRoot: path.join(run, "reports") });
  const chats = verifyChatHistory({ source: path.join(snapshot, "cyrene-chats"), target: path.join(stage, "cyrene-chats") });
  const rag = json(path.join(snapshot, "rag-data/memory-store.json")), graph = json(path.join(snapshot, "entity-graph.json"));
  if (graph.relations.length) throw new Error("Relation conversion required; refusing silent loss");
  write(path.join(memoryRoot, "entity-graph.json"), { version: 1, entities: graph.entities });
  const docs = rag.filter((entry) => entry.source === "imported_doc");
  write(path.join(stage, "rag-data/memory-store.json"), docs);
  const indexes = migrateIndexes(await helpers(), rag, sourceIndex);
  const finalIndex = json(path.join(stage, "cyrene-chats/index.json"));
  const beforeIndex = json(path.join(target, "cyrene-chats/index.json"));
  for (const item of beforeIndex) {
    if (JSON.stringify(finalIndex.find((row) => row.id === item.id)) !== JSON.stringify(item)
      || fileHash(path.join(stage, "cyrene-chats/sessions", item.id + ".json")) !== fileHash(path.join(target, "cyrene-chats/sessions", item.id + ".json"))) throw new Error("Existing Work/Code changed");
  }
  // Attachment copies move with the candidate; never leave paths into staging or the source.
  for (const meta of sourceIndex) {
    const file = path.join(stage, "cyrene-chats/sessions", meta.id + ".json"), session = json(file);
    for (const message of session.messages) for (const attachment of message.attachments ?? []) {
      if (!attachment.filePath.startsWith(stage + path.sep)) throw new Error("Attachment escaped staging");
      attachment.filePath = path.join(target, path.relative(stage, attachment.filePath));
      if (attachment.status !== "error") attachment.previewUrl = pathToFileURL(attachment.filePath).href;
    }
    write(file, session);
  }
  unchanged(); noTargetElectron();
  const latestTarget = files(target);
  if (latestTarget.length !== targetHashes.size || latestTarget.some((file) => targetHashes.get(path.relative(target, file)) !== fileHash(file))) throw new Error("Target changed during preflight");
  if (forbiddenCalls) throw new Error("Migration attempted forbidden external calls: " + forbiddenCalls);
  const report = { version: 1, dryRun: !apply, sourceUnchanged: true, externalModelCalls: forbiddenCalls, imported, chats: chats.counters,
    preservedTargetSessions: beforeIndex.length, documents: docs.length, graphEntities: graph.entities.length,
    indexes, compatibility: state.legacyCompatibility.summary, mcpConfig: "regenerated by built-in startup sync", run };
  write(path.join(run, "report.json"), report);
  if (apply) {
    const backup = path.join(run, "target-before-import");
    fs.renameSync(target, backup);
    try { fs.renameSync(stage, target); } catch (error) { fs.renameSync(backup, target); throw error; }
    report.backup = backup; report.applied = true;
    write(path.join(run, "report.json"), report);
  }
  console.log(JSON.stringify(report, null, 2));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
