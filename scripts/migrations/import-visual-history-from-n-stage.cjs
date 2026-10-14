// Copy only verified identical image descriptions into an isolated local RAG copy.
const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");

const localStage = process.argv[2] && path.resolve(process.argv[2]);
const nStage = process.argv[3] && path.resolve(process.argv[3]);
const apply = process.argv.includes("--apply");
if (!localStage?.includes("_history-index-work-") || !localStage.endsWith(`${path.sep}stage`)
  || !nStage?.includes("_history-index-work-") || !nStage.endsWith(`${path.sep}n-stage`)
  || path.dirname(localStage) !== path.dirname(nStage)) {
  throw new Error("Pass matching isolated stage and n-stage paths");
}

const projectRoot = path.resolve(__dirname, "../..");
const { setAppPathProvider } = require("../../dist/main/main/runtime/runtime-paths.js");
setAppPathProvider({ getPath: () => localStage, getAppPath: () => projectRoot });
const rag = require("../../dist/main/main/rag/index.js");

function sha(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function imageKey(filePath, index) {
  return createHash("sha256").update(`${index}\0${filePath}`).digest("hex");
}

function comparableMessage(message) {
  const value = structuredClone(message);
  for (const attachment of value.attachments ?? []) {
    delete attachment.filePath;
    delete attachment.previewUrl;
    delete attachment.status;
    delete attachment.visualIndexSummary;
    delete attachment.visualIndexCaption;
  }
  return JSON.stringify(value);
}

async function main() {
  const localIndex = JSON.parse(fs.readFileSync(path.join(localStage, "cyrene-chats/index.json"), "utf8"));
  const nIndex = new Set(JSON.parse(fs.readFileSync(path.join(nStage, "cyrene-chats/index.json"), "utf8"))
    .map((session) => session.id));
  const existing = JSON.parse(fs.readFileSync(path.join(localStage, "rag-data/memory-store.json"), "utf8"))
    .filter((entry) => entry.source === "chat_image");
  const existingKeys = new Set(existing.map((entry) =>
    `${entry.metadata?.sessionId}\0${entry.metadata?.turnId}\0${entry.metadata?.imageKey}`));
  const candidates = [];
  let unverified = 0;
  let currentFileMatches = 0;
  let verifiedImportedCopies = 0;
  const importedAssetRoot = path.resolve(nStage, "../..", "Cyrene-Agent-N", "AppData", "Roaming",
    "live2d-cyrene-n", "cyrene-chats", "imported-assets");
  for (const sessionMeta of localIndex.filter((item) => nIndex.has(item.id))) {
    const sessionFile = `${sessionMeta.id}.json`;
    const local = JSON.parse(fs.readFileSync(path.join(localStage, "cyrene-chats/sessions", sessionFile), "utf8"));
    const n = JSON.parse(fs.readFileSync(path.join(nStage, "cyrene-chats/sessions", sessionFile), "utf8"));
    const nMessages = new Map(n.messages.map((message) => [message.id, message]));
    for (const message of local.messages) {
      if (message.role !== "user") continue;
      const counterpart = nMessages.get(message.id);
      if (!counterpart || counterpart.role !== "user") continue;
      const sameMessage = comparableMessage(message) === comparableMessage(counterpart);
      for (const [index, image] of (message.attachments ?? []).entries()) {
        if (image.kind !== "image") continue;
        const nImage = counterpart.attachments?.[index];
        const caption = nImage?.visualIndexCaption?.trim() || nImage?.caption?.trim();
        if (nImage?.kind !== "image" || nImage.name !== image.name
          || !nImage.visualIndexSummary || !caption) continue;
        const key = imageKey(image.filePath, index);
        if (existingKeys.has(`${local.id}\0${message.id}\0${key}`)) continue;
        const currentMatch = fs.existsSync(image.filePath) && fs.existsSync(nImage.filePath)
          && sha(image.filePath) === sha(nImage.filePath);
        const expectedCopy = path.join(importedAssetRoot, local.id, message.id,
          `${index}${path.extname(image.filePath)}`);
        const importedCopy = !fs.existsSync(image.filePath) && sameMessage && image.status === "done"
          && nImage.status === "done" && path.resolve(nImage.filePath) === expectedCopy
          && fs.existsSync(expectedCopy);
        if (!currentMatch && !importedCopy) { unverified += 1; continue; }
        if (currentMatch) currentFileMatches += 1;
        else verifiedImportedCopies += 1;
        candidates.push({ text: `图片 ${image.name}。画面内容：${caption}`,
          metadata: { sessionId: local.id, turnId: message.id, imageKey: key, name: image.name,
            summary: nImage.visualIndexSummary, ts: message.at } });
      }
    }
  }
  console.log(JSON.stringify({ existing: existing.length, verifiedCandidates: candidates.length,
    currentFileMatches, verifiedImportedCopies, unverified, apply }));
  if (!apply || !candidates.length) return;
  const settings = JSON.parse(fs.readFileSync(path.join(localStage, "model-settings.json"), "utf8"));
  await rag.initRAG("auto", undefined, undefined, settings.embeddingModel);
  for (const candidate of candidates) await rag.upsertChatImageVector(candidate.text, candidate.metadata);
  rag.flushVectorStoreSync();
  const updated = rag.getEntriesBySource("chat_image");
  if (updated.length !== existing.length + candidates.length) throw new Error("Visual index count mismatch");
  console.log(JSON.stringify({ validatedImages: updated.length, imported: candidates.length }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
