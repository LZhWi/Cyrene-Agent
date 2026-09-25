import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHostHistorySource } from "../plugins/companion-memory/src/host-history-source.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, "../..");
const source = path.resolve(project, "../AppData/Roaming/live2d-cyrene-n/cyrene-chats");
const tempRoot = path.resolve(project, "local-plugins/.test-runtime");
if (!existsSync(source) || path.basename(source) !== "cyrene-chats") throw new Error("正式 Chat 来源不存在");
const require = createRequire(import.meta.url);
const { createPluginConversationsService } = require(path.join(project, "dist/main/main/plugin-host/conversations-service.js"));

function hashTree(root) {
  const hash = createHash("sha256");
  function visit(dir, relative = "") {
    for (const name of readdirSync(dir).sort()) {
      const file = path.join(dir, name), next = path.join(relative, name);
      const stat = lstatSync(file, { throwIfNoEntry: false });
      if (!stat) throw new Error("源文件在读取期间消失");
      if (stat.isSymbolicLink()) throw new Error("会话目录包含符号链接");
      hash.update(next + "\0");
      if (stat.isDirectory()) visit(file, next);
      else if (stat.isFile()) hash.update(readFileSync(file));
      else throw new Error("会话目录存在不支持的文件类型");
    }
  }
  visit(root);
  return hash.digest("hex");
}

const before = hashTree(source);
mkdirSync(tempRoot, { recursive: true });
const temporary = mkdtempSync(path.join(tempRoot, "host-history-"));
if (path.dirname(temporary) !== tempRoot || !path.basename(temporary).startsWith("host-history-")) {
  throw new Error("临时目录越界");
}
try {
  const copy = path.join(temporary, "cyrene-chats");
  cpSync(source, copy, { recursive: true, errorOnExist: true });
  const sessions = JSON.parse(readFileSync(path.join(copy, "index.json"), "utf8"));
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const reader = {
    listSessions: () => sessions,
    getSession: (id) => byId.has(id)
      ? JSON.parse(readFileSync(path.join(copy, "sessions", `${id}.json`), "utf8")) : null,
  };
  const service = createPluginConversationsService({ reader });
  const rows = await createHostHistorySource(service).snapshot(new AbortController().signal);
  const expected = sessions.filter((session) => session.mode === "chat").flatMap((session) => {
    const projected = reader.getSession(session.id).messages
      .filter((message) => message.role === "user" || message.role === "model");
    while (projected.at(-1)?.role === "user") projected.pop();
    return projected;
  });
  if (rows.length !== expected.length || new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error("旧会话只读候选数量或消息 ID 不一致");
  }
  const expectedImages = expected.filter((message) => message.role === "user")
    .flatMap((message) => message.attachments ?? [])
    .filter((attachment) => attachment.kind === "image"
      && (attachment.visualIndexCaption?.trim() || attachment.caption?.trim())).length;
  const projectedImages = rows.reduce((count, row) => count + (row.images?.length ?? 0), 0);
  const indexedImages = rows.reduce((count, row) => count
    + (row.images ?? []).filter((image) => image.summary).length, 0);
  if (projectedImages !== expectedImages) throw new Error("旧图片描述投影数量不一致");
  if (hashTree(copy) !== before || hashTree(source) !== before) throw new Error("验收改变了会话数据");
  console.log(JSON.stringify({ ok: true, chatMessages: rows.length, projectedImages, indexedImages,
    sourceUnchanged: true, copyUnchanged: true }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
