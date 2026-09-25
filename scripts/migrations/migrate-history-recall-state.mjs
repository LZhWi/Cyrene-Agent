import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHostHistorySource } from "../../local-plugins/plugins/companion-memory/src/host-history-source.ts";

const [ragFile, userData, action = "--check"] = process.argv.slice(2);
if (!ragFile || !userData || !["--check", "--commit"].includes(action)) {
  throw new Error("Usage: node migrate-history-recall-state.mjs <rag-snapshot.json> <N-user-data> [--check|--commit]");
}
const require = createRequire(import.meta.url);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createPluginConversationsService } = require(path.join(project, "dist/main/main/plugin-host/conversations-service.js"));
const chatDir = path.join(userData, "cyrene-chats");
const indexFile = path.join(chatDir, "index.json");
const target = path.join(userData, "plugin-data", "companion-memory", "history-retrieval-recall-state.json");
const sourceBytes = readFileSync(ragFile);
const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
const indexBytes = readFileSync(indexFile);
const indexHash = createHash("sha256").update(indexBytes).digest("hex");
const sessions = JSON.parse(indexBytes);
const sessionFiles = sessions.filter((session) => session.mode === "chat")
  .map((session) => path.join(chatDir, "sessions", `${session.id}.json`));
const sessionHashes = new Map(sessionFiles.map((file) => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]));
const byId = new Map(sessions.map((session) => [session.id, session]));
const reader = {
  listSessions: () => sessions,
  getSession: (id) => byId.has(id) ? JSON.parse(readFileSync(path.join(chatDir, "sessions", `${id}.json`))) : null,
};
const rows = await createHostHistorySource(createPluginConversationsService({ reader }))
  .snapshot(new AbortController().signal);
const host = new Map(rows.map((row) => [`${row.sessionId}\0${row.id}`, row]));
if (host.size !== rows.length) throw new Error("宿主历史消息 ID 不唯一");

const entries = {};
let matched = 0;
let differingText = 0;
for (const item of JSON.parse(sourceBytes)) {
  if (item.source !== "chat_history") continue;
  const occurrences = item.metadata?.occurrences?.length ? item.metadata.occurrences
    : [item.metadata];
  for (const occurrence of occurrences) {
    const row = host.get(`${occurrence?.sessionId}\0${occurrence?.turnId}`);
    if (!row) throw new Error(`RAG occurrence missing host message: ${item.id}`);
    if (row.role !== occurrence.role || row.at !== occurrence.ts) {
      throw new Error(`RAG occurrence metadata differs from host: ${item.id}`);
    }
    if (row.text !== item.text) differingText++;
    const key = `host-message:${row.sessionId}:${row.id}`;
    if (entries[key]) throw new Error(`duplicate host recall ID: ${key}`);
    if (!Number.isFinite(item.weight) || item.weight < 1 || item.weight > 5
      || !Number.isFinite(item.lastRecalledAt) || item.lastRecalledAt < 0) {
      throw new Error(`invalid RAG recall state: ${item.id}`);
    }
    entries[key] = { weight: item.weight, lastRecalledAt: item.lastRecalledAt };
    matched++;
  }
}
const unindexed = rows.filter((row) => !entries[`host-message:${row.sessionId}:${row.id}`]);
if (differingText) throw new Error("RAG 与宿主消息的索引文本不一致");
if (unindexed.some((row) => row.text.trim())) throw new Error("非空宿主消息未匹配本地 RAG");
if (createHash("sha256").update(readFileSync(ragFile)).digest("hex") !== sourceHash
  || createHash("sha256").update(readFileSync(indexFile)).digest("hex") !== indexHash
  || [...sessionHashes].some(([file, hash]) => createHash("sha256").update(readFileSync(file)).digest("hex") !== hash)) {
  throw new Error("源文件在核对期间发生变化");
}
const result = { sourceHash, hostMessages: rows.length, matched, unindexedEmpty: unindexed.length, differingText };
if (action === "--commit") {
  if (existsSync(target)) throw new Error("-N 召回状态文件已存在，拒绝覆盖");
  writeFileSync(target, JSON.stringify({ version: 1, entries }));
  result.written = target;
}
console.log(JSON.stringify(result));
