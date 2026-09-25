import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const userData = process.argv[2];
const expected = Number(process.argv[3]);
if (!userData || path.basename(userData) !== "live2d-cyrene-n" || !Number.isSafeInteger(expected) || expected < 1) {
  throw new Error("用法: node backfill-image-recall-state.mjs <live2d-cyrene-n 路径> <预期图片数>");
}
const sessionsDir = path.join(userData, "cyrene-chats", "sessions");
const statePath = path.join(userData, "plugin-data", "companion-memory", "history-retrieval-recall-state.json");
const hash = (data) => createHash("sha256").update(data).digest("hex");
const stateBytes = fs.readFileSync(statePath);
const state = JSON.parse(stateBytes.toString("utf8"));
if (state.version !== 1 || !state.entries || typeof state.entries !== "object") throw new Error("召回状态格式无效");
const files = fs.readdirSync(sessionsDir).filter((name) => name.endsWith(".json"))
  .map((name) => path.join(sessionsDir, name));
const changed = [];
const stamp = Date.now();
let images = 0;
for (const file of files) {
  const bytes = fs.readFileSync(file);
  const session = JSON.parse(bytes.toString("utf8"));
  let dirty = false;
  for (const message of session.messages ?? []) {
    if (message.role !== "user") continue;
    const projected = (message.attachments ?? []).filter((item) => item.kind === "image"
      && (item.visualIndexCaption?.trim() || item.caption?.trim()));
    projected.forEach((image, index) => {
      if (!image.visualIndexSummary?.trim()) return;
      images++;
      const id = `host-image:${session.id}:${message.id}:${index}`;
      if (!image.visualIndexedAt) {
        image.visualIndexedAt = stamp;
        dirty = true;
      }
      if (!state.entries[id]) state.entries[id] = { weight: 1, lastRecalledAt: image.visualIndexedAt };
    });
  }
  if (dirty) changed.push({ file, bytes, session });
}
if (images !== expected) throw new Error(`图片数 ${images} 与预期 ${expected} 不符；未写入`);
const imageStates = Object.keys(state.entries).filter((id) => id.startsWith("host-image:"));
if (imageStates.length !== expected) throw new Error(`图片状态数 ${imageStates.length} 与预期 ${expected} 不符；未写入`);
for (const { file, bytes } of changed) if (hash(fs.readFileSync(file)) !== hash(bytes)) throw new Error(`会话在预检后改变: ${file}`);
if (hash(fs.readFileSync(statePath)) !== hash(stateBytes)) throw new Error("召回状态在预检后改变");
if (!changed.length && stateBytes.toString("utf8") === JSON.stringify(state)) {
  console.log(JSON.stringify({ status: "already-current", images, imageStates: imageStates.length }));
  process.exit(0);
}
const backupDir = path.join(userData, "backups", `image-recall-state-${new Date(stamp).toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(backupDir, { recursive: true });
fs.copyFileSync(statePath, path.join(backupDir, path.basename(statePath)));
for (const { file } of changed) fs.copyFileSync(file, path.join(backupDir, path.basename(file)));
for (const { file, session } of changed) fs.writeFileSync(file, JSON.stringify(session, null, 2) + "\n", "utf8");
fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
console.log(JSON.stringify({ status: "backfilled", images, imageStates: imageStates.length,
  changedSessions: changed.length, backupDir }));
