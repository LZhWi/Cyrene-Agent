// Run only against an isolated userData copy. Prints counts, never chat content.
const fs = require("fs");
const path = require("path");

const userData = process.argv[2] && path.resolve(process.argv[2]);
const apply = process.argv.includes("--apply");
if (!userData || !path.isAbsolute(userData)) throw new Error("Pass an absolute isolated userData path");
const projectRoot = path.resolve(__dirname, "../..");
const { setAppPathProvider } = require("../../dist/main/main/runtime/runtime-paths.js");
setAppPathProvider({
  getPath: (name) => name === "userData" ? userData : userData,
  getAppPath: () => projectRoot,
});
const { historyIndexText } = require("../../dist/main/main/chats/history-index-text.js");
const rag = require("../../dist/main/main/rag/index.js");

function occurrenceFor(entry, turnId) {
  const values = Array.isArray(entry.metadata?.occurrences) ? entry.metadata.occurrences : [entry.metadata];
  return values.find((item) => item?.turnId === turnId);
}

async function main() {
  const index = JSON.parse(fs.readFileSync(path.join(userData, "cyrene-chats/index.json"), "utf8"));
  const sessions = index.map(({ id }) => JSON.parse(fs.readFileSync(
    path.join(userData, "cyrene-chats/sessions", `${id}.json`), "utf8")));
  const messages = sessions.flatMap((session) => session.messages.map((message) => ({ sessionId: session.id, message })));
  const messageIds = new Set(messages.map(({ message }) => message.id));
  const current = JSON.parse(fs.readFileSync(path.join(userData, "rag-data/memory-store.json"), "utf8"))
    .filter((entry) => entry.source === "chat_history");
  const byTurnId = new Map();
  for (const entry of current) {
    for (const occurrence of Array.isArray(entry.metadata?.occurrences) ? entry.metadata.occurrences : [entry.metadata]) {
      if (!occurrence?.turnId) continue;
      const group = byTurnId.get(occurrence.turnId) ?? [];
      group.push(entry);
      byTurnId.set(occurrence.turnId, group);
    }
  }
  const changes = messages.flatMap(({ sessionId, message }) => {
    const desired = historyIndexText(message);
    const old = byTurnId.get(message.id) ?? [];
    const aligned = old.length === (desired ? 1 : 0) && (!desired || (
      old[0].text === desired && occurrenceFor(old[0], message.id)?.ts === message.at));
    return aligned ? [] : [{ sessionId, message, desired }];
  });
  const orphanIds = [...byTurnId.keys()].filter((id) => !messageIds.has(id));
  console.log(JSON.stringify({ messages: messages.length, currentHistoryEntries: current.length,
    changedMessageIds: changes.length, orphanMessageIds: orphanIds.length, apply }));
  if (!apply) return;

  const settings = JSON.parse(fs.readFileSync(path.join(userData, "model-settings.json"), "utf8"));
  await rag.initRAG("auto", undefined, undefined, settings.embeddingModel);
  for (const { sessionId, message, desired } of changes) {
    rag.deleteHistoryEntriesByTurnIds([message.id]);
    if (desired) await rag.addHistoryMemory(desired, { sessionId,
      role: message.role === "user" ? "user" : "assistant", ts: message.at, turnId: message.id },
    { createdAt: message.at });
  }
  for (const id of orphanIds) rag.deleteHistoryEntriesByTurnIds([id]);
  rag.flushVectorStoreSync();

  const updated = rag.getEntriesBySource("chat_history");
  const errors = messages.filter(({ message }) => {
    const desired = historyIndexText(message);
    const matching = updated.filter((entry) => occurrenceFor(entry, message.id));
    return matching.length !== (desired ? 1 : 0) || (desired && matching[0]?.text !== desired);
  });
  if (errors.length) throw new Error(`Post-rebuild validation failed for ${errors.length} messages`);
  console.log(JSON.stringify({ validatedMessages: messages.length, rebuiltHistoryEntries: updated.length,
    remainingOrphanIds: orphanIds.filter((id) => updated.some((entry) => occurrenceFor(entry, id))).length }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
